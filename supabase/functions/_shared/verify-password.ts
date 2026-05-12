// Story 6.6 — Shared password-verify helper.
//
// Extracted from re-auth/index.ts (Story 1.5b) once a second consumer
// (sms-resend-history) landed. Same defensive discipline as the original:
//   - Fresh anon client per call → no session bleed between requests.
//   - Caller's main session JWT is NEVER minted, refreshed, or echoed.
//   - Defensive signOut on the verify client to clear in-memory tokens.
//   - Rate-limit detection via Supabase status code 429.
//   - Structured JSON logging; the password is NEVER logged.
//
// Callers (re-auth, sms-resend-history, future settlement / csv-export
// Edge Functions) import this and own the surrounding RFC 7807 response
// composition.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { problem, type Problem } from "./rfc7807.ts";

export type VerifyPasswordOk = { ok: true };
export type VerifyPasswordErr = { ok: false; problem: Problem };
export type VerifyPasswordResult = VerifyPasswordOk | VerifyPasswordErr;

export interface VerifyPasswordOptions {
  /** Service-role client used to resolve the collector's phone (auth.users). */
  serviceClient: SupabaseClient;
  /** Caller's JWT-validated collector id. */
  collectorId: string;
  /** Raw password — never logged, never persisted by this helper. */
  password: string;
  /**
   * Optional structured-log discriminator (e.g., `{ operation_intent: "sms_resend" }`).
   * Merged into the JSON log record alongside `collector_id`.
   */
  logContext?: Record<string, unknown>;
}

type LogLevel = "info" | "warn" | "error";
type LogEvent =
  | "verify_password.verified"
  | "verify_password.failed"
  | "verify_password.rate_limited"
  | "verify_password.unexpected";

function logJson(level: LogLevel, event: LogEvent, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }));
}

async function resolveCollectorPhone(
  service: SupabaseClient,
  collectorId: string,
): Promise<string | null> {
  // auth.users.phone is the identifier Supabase Auth binds to for
  // signInWithPassword. The service client bypasses RLS.
  const { data, error } = await service.auth.admin.getUserById(collectorId);
  if (error || !data.user?.phone) return null;
  return data.user.phone.startsWith("+") ? data.user.phone : `+${data.user.phone}`;
}

/**
 * Verifies that {phone-resolved-from-collectorId, password} matches a
 * Supabase Auth credential. Returns {ok: true} on success or {ok: false,
 * problem: RFC7807} on any failure. The caller composes the HTTP response.
 *
 * Hard rules (do NOT relax):
 *   - NEVER log the password.
 *   - NEVER mint or refresh the caller's session.
 *   - On unknown error → {ok: false, problem: internal_unexpected}.
 */
export async function verifyPassword(
  options: VerifyPasswordOptions,
): Promise<VerifyPasswordResult> {
  const { serviceClient, collectorId, password, logContext } = options;
  const baseLogFields = { collector_id: collectorId, ...(logContext ?? {}) };

  // Resolve the caller's phone — the identifier signInWithPassword uses.
  const phone = await resolveCollectorPhone(serviceClient, collectorId);
  if (!phone) {
    logJson("error", "verify_password.unexpected", {
      ...baseLogFields,
      reason: "phone_lookup",
    });
    return {
      ok: false,
      problem: problem("internal_unexpected", "Could not resolve collector phone"),
    };
  }

  // Fresh anon client per call — verify session never bleeds across requests,
  // and the caller's main session (held in the browser) is untouched.
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    logJson("error", "verify_password.unexpected", {
      ...baseLogFields,
      reason: "env_missing",
    });
    return {
      ok: false,
      problem: problem(
        "internal_unexpected",
        "SUPABASE_URL / SUPABASE_ANON_KEY missing in Edge Function env",
      ),
    };
  }
  const verifyClient = createClient(url, anonKey, { auth: { persistSession: false } });

  try {
    const { data, error } = await verifyClient.auth.signInWithPassword({ phone, password });
    if (error) {
      const status = error.status ?? 0;
      const code = (error as { code?: string }).code;
      if (status === 429 || code === "over_request_rate_limit") {
        logJson("warn", "verify_password.rate_limited", baseLogFields);
        return {
          ok: false,
          problem: problem("rate_limited", "Too many attempts; please retry later."),
        };
      }
      logJson("warn", "verify_password.failed", { ...baseLogFields, status });
      return {
        ok: false,
        problem: problem("credentials_invalid", "Invalid password"),
      };
    }
    if (!data.session) {
      logJson("warn", "verify_password.failed", { ...baseLogFields, reason: "no_session" });
      return {
        ok: false,
        problem: problem("credentials_invalid", "Invalid password"),
      };
    }

    // Defensive: clear the verify client's in-memory session. persistSession=false
    // means tokens never reach storage, but signOut clears the in-process state.
    // Log on failure so a future Supabase-js change (e.g., server-side token
    // revocation) doesn't degrade silently.
    await verifyClient.auth.signOut().catch((signOutErr: unknown) => {
      const msg = signOutErr instanceof Error ? signOutErr.message : String(signOutErr);
      logJson("warn", "verify_password.unexpected", {
        ...baseLogFields,
        reason: "verify_client_signout_failed",
        error: msg,
      });
    });

    logJson("info", "verify_password.verified", baseLogFields);
    return { ok: true };
  } catch (err) {
    logJson("error", "verify_password.unexpected", {
      ...baseLogFields,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return {
      ok: false,
      problem: problem("internal_unexpected", "Unexpected error in verify-password helper"),
    };
  }
}
