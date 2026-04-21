// Story 1.5b — Re-auth Edge Function (password flow).
//
// PRD v1.3 auth pivot (Termii business-KYC blocker). Replaces the Story
// 1.3 SMS-OTP challenge/verify pipeline with a single password-check
// against Supabase Auth's `signInWithPassword`. Consumed by Stories 2.6
// (bulk/single delete), 7.4 (cycle settlement), 9.3 (CSV export), 6.x
// (receipt resend) to gate sensitive operations per FR5.
//
// Request:
//   POST /functions/v1/re-auth
//   Authorization: Bearer <collector JWT>
//   Body: { password: string, operation_intent: "cycle_settlement"
//                                              | "member_delete"
//                                              | "csv_export"
//                                              | "sms_resend" }
//
// Success (200): { ok: true, scope: <operation_intent> }
// Failures (RFC 7807):
//   401 unauthenticated         — missing / invalid JWT
//   401 credentials_invalid     — password wrong
//   429 rate_limited            — Supabase Auth per-identifier cap hit
//   400 request_invalid         — body schema fail
//   500 internal_unexpected     — anything else
//
// Hard rules (do NOT relax without amending the spec):
//   - NEVER store, log, or echo the raw password.
//   - NEVER mint/refresh the caller's session JWT — the verify client is
//     a fresh anon client whose session stays in-process and is signed
//     out immediately; the caller's main session is untouched.
//   - 4xx/5xx responses ALWAYS RFC 7807 (Content-Type: application/problem+json).
//
// See: _bmad-output/implementation-artifacts/1-5b-password-auth-switch.md
// AC #7 + PRD v1.3 FR5 + architecture.md § Sensitive-op re-auth.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

import { assertAuthenticated, buildAnonClient, buildServiceClient } from "../_shared/auth-check.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";

// Module-scope lazy clients for the caller-JWT + service paths. The verify
// client is NEVER a singleton — we create one per request so its in-memory
// session state cannot leak across requests.
let _anonClient: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;
function getAnonClient(): SupabaseClient {
  if (!_anonClient) _anonClient = buildAnonClient();
  return _anonClient;
}
function getServiceClient(): SupabaseClient {
  if (!_serviceClient) _serviceClient = buildServiceClient();
  return _serviceClient;
}

const OperationIntentSchema = z.enum([
  "cycle_settlement",
  "member_delete",
  "csv_export",
  "sms_resend",
]);

const RequestBodySchema = z.object({
  // Minimum mirrors Supabase Auth's server-side floor; substantive
  // complexity is out of scope at MVP per Story 1.5b AC #13.
  password: z.string().min(1, "password required"),
  operation_intent: OperationIntentSchema,
});

type LogEvent = "reauth.verified" | "reauth.failed" | "reauth.rate_limited" | "reauth.unexpected";

function logJson(
  level: "info" | "warn" | "error",
  event: LogEvent,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }));
}

async function resolveCollectorPhone(
  service: SupabaseClient,
  collectorId: string,
): Promise<string | null> {
  // auth.users is the source of truth for the phone Supabase Auth binds to
  // for signInWithPassword. The service client bypasses RLS.
  const { data, error } = await service.auth.admin.getUserById(collectorId);
  if (error || !data.user?.phone) return null;
  return data.user.phone.startsWith("+") ? data.user.phone : `+${data.user.phone}`;
}

export async function handler(req: Request): Promise<Response> {
  const reqUrl = req.url;

  if (req.method !== "POST") {
    return problemResponse(
      problem("request_invalid", `Only POST is allowed; got ${req.method}`),
      reqUrl,
      { Allow: "POST" },
    );
  }

  // 1. Parse + validate body.
  let parsed: z.infer<typeof RequestBodySchema>;
  try {
    const raw = await req.json();
    const result = RequestBodySchema.safeParse(raw);
    if (!result.success) {
      return problemResponse(
        problem("request_invalid", result.error.issues.map((i) => i.message).join("; ")),
        reqUrl,
      );
    }
    parsed = result.data;
  } catch (err) {
    return problemResponse(
      problem("request_invalid", `Body must be valid JSON: ${(err as Error).message}`),
      reqUrl,
    );
  }

  // 2. Authenticate caller.
  const auth = await assertAuthenticated(req, getAnonClient(), getServiceClient());
  if ("problem" in auth) {
    return problemResponse(auth.problem, reqUrl);
  }

  // 3. Resolve caller's phone — the identifier used by signInWithPassword.
  const service = getServiceClient();
  const phone = await resolveCollectorPhone(service, auth.collectorId);
  if (!phone) {
    logJson("error", "reauth.unexpected", {
      collector_id: auth.collectorId,
      reason: "phone_lookup",
    });
    return problemResponse(
      problem("internal_unexpected", "Could not resolve collector phone"),
      reqUrl,
    );
  }

  // 4. Verify password on a FRESH anon client. Constructing a new client
  //    per request guarantees the verify-session never bleeds across
  //    requests, and the caller's main session (held in the browser) is
  //    untouched by this call.
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const verifyClient = createClient(url, anonKey, { auth: { persistSession: false } });

  try {
    const { data, error } = await verifyClient.auth.signInWithPassword({
      phone,
      password: parsed.password,
    });
    if (error) {
      const status = error.status ?? 0;
      if (status === 429 || (error as { code?: string }).code === "over_request_rate_limit") {
        logJson("warn", "reauth.rate_limited", {
          collector_id: auth.collectorId,
          operation_intent: parsed.operation_intent,
        });
        return problemResponse(
          problem("rate_limited", "Too many attempts; please retry later."),
          reqUrl,
        );
      }
      logJson("warn", "reauth.failed", {
        collector_id: auth.collectorId,
        operation_intent: parsed.operation_intent,
        status,
      });
      return problemResponse(problem("credentials_invalid", "Invalid password"), reqUrl);
    }
    if (!data.session) {
      return problemResponse(problem("credentials_invalid", "Invalid password"), reqUrl);
    }

    // Defensive: explicitly sign out the verify client. persistSession=false
    // means its tokens never reach storage, but calling signOut clears the
    // in-memory session object too.
    await verifyClient.auth.signOut().catch(() => undefined);

    logJson("info", "reauth.verified", {
      collector_id: auth.collectorId,
      operation_intent: parsed.operation_intent,
    });
    return new Response(JSON.stringify({ ok: true, scope: parsed.operation_intent }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    logJson("error", "reauth.unexpected", {
      collector_id: auth.collectorId,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return problemResponse(
      problem("internal_unexpected", "Unexpected error in re-auth handler"),
      reqUrl,
    );
  }
}

// Supabase Edge Functions runtime entry point.
type DenoGlobal = { serve?: (handler: (req: Request) => Promise<Response>) => unknown };
const denoMaybe: DenoGlobal | undefined = (globalThis as { Deno?: DenoGlobal }).Deno;
if (denoMaybe?.serve) {
  denoMaybe.serve(handler);
}
