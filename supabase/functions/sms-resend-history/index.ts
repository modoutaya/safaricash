// Story 6.6 — sms-resend-history Edge Function.
//
// Collector-initiated full-cycle SMS history re-delivery (FR33).
//
// Request:
//   POST /functions/v1/sms-resend-history
//   Authorization: Bearer <collector JWT>
//   Body: { member_id: uuid, cycle_id: uuid, password: string }
//
// Flow:
//   1. JWT auth (assertAuthenticated).
//   2. Password verify via _shared/verify-password.ts (FR5 re-auth gate).
//   3. JWT-bound supabase-js client → call enqueue_resend_history RPC.
//   4. RPC returns (enqueued int, reason text); map to {enqueued, reason} JSON.
//
// Success (200): { enqueued: number, reason: "opt_out" | "no_phone" | "no_transactions" | null }
// Failures (RFC 7807):
//   400 request_invalid         — body schema fail
//   401 auth_unauthenticated    — missing / invalid JWT
//   401 credentials_invalid     — password wrong
//   429 rate_limited            — Supabase Auth per-identifier cap hit
//   404 not_found               — RPC P0002 (member / cycle ownership fail)
//   500 internal_unexpected     — anything else
//
// Hard rules (parity with re-auth):
//   - NEVER log password / phone / sms body.
//   - Password verify uses a fresh anon client (verify-password.ts owns this).
//   - All 4xx/5xx responses use RFC 7807 (application/problem+json).
//
// See: _bmad-output/implementation-artifacts/6-6-resend-cycle-history.md AC #5 / #7.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

import { assertAuthenticated, buildAnonClient, buildServiceClient } from "../_shared/auth-check.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { verifyPassword } from "../_shared/verify-password.ts";

// Module-scope lazy singletons for the JWT-validate + service paths.
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

const RequestBodySchema = z.object({
  member_id: z.string().uuid("member_id must be a uuid"),
  cycle_id: z.string().uuid("cycle_id must be a uuid"),
  // Code-review patch (P8): trim before length check — `"   "` would
  // otherwise burn a Supabase Auth rate-limit slot on guaranteed-invalid
  // input.
  password: z.string().trim().min(1, "password required"),
});

type LogEvent =
  | "sms_resend_history.enqueued"
  | "sms_resend_history.short_circuited"
  | "sms_resend_history.unexpected";

function logJson(
  level: "info" | "warn" | "error",
  event: LogEvent,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }));
}

/** Build a Supabase client scoped to the caller's JWT — RLS + auth.uid() apply. */
function buildJwtBoundClient(jwt: string): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing in Edge Function env");
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
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

  // 3. Password verify (FR5 re-auth gate).
  const verifyResult = await verifyPassword({
    serviceClient: getServiceClient(),
    collectorId: auth.collectorId,
    password: parsed.password,
    logContext: { operation_intent: "sms_resend", member_id: parsed.member_id },
  });
  if (!verifyResult.ok) {
    return problemResponse(verifyResult.problem, reqUrl);
  }

  // 4. Call enqueue_resend_history under the caller's JWT — RLS + RPC's
  //    own ownership checks gate access.
  let jwtClient: SupabaseClient;
  try {
    jwtClient = buildJwtBoundClient(auth.jwt);
  } catch (err) {
    logJson("error", "sms_resend_history.unexpected", {
      collector_id: auth.collectorId,
      reason: "jwt_client_build",
      error: (err as Error).message,
    });
    return problemResponse(
      problem("internal_unexpected", "Could not build user-scoped Supabase client"),
      reqUrl,
    );
  }

  const { data, error } = await jwtClient.rpc("enqueue_resend_history", {
    p_member_id: parsed.member_id,
    p_cycle_id: parsed.cycle_id,
  });

  if (error) {
    // PostgREST surfaces Postgres SQLSTATE in error.code.
    const code = (error as { code?: string }).code;
    if (code === "28000") {
      // Defensive — JWT-bound client should never see this.
      logJson("warn", "sms_resend_history.unexpected", {
        collector_id: auth.collectorId,
        reason: "rpc_auth_unauthenticated",
      });
      return problemResponse(
        problem("auth_unauthenticated", "RPC rejected: caller not authenticated"),
        reqUrl,
      );
    }
    if (code === "P0002") {
      return problemResponse(
        problem("not_found", "Member or cycle not found / not owned by caller"),
        reqUrl,
      );
    }
    // Code-review patch (P2): log the raw error.message server-side; do
    // NOT include it in the RFC 7807 detail returned to the client.
    // PostgREST messages can carry table / column / constraint identifiers.
    logJson("error", "sms_resend_history.unexpected", {
      collector_id: auth.collectorId,
      reason: "rpc_failed",
      pg_code: code,
      message: error.message,
    });
    return problemResponse(
      problem("internal_unexpected", "Unexpected error processing the resend request"),
      reqUrl,
    );
  }

  // 5. Map RPC return (record-set with one row) to JSON.
  // PostgREST returns a single-element array for table-returning RPCs.
  type RpcRow = { enqueued: number; reason: string | null };
  const row: RpcRow = Array.isArray(data) ? data[0] : (data as RpcRow);
  if (!row) {
    logJson("error", "sms_resend_history.unexpected", {
      collector_id: auth.collectorId,
      reason: "rpc_empty_result",
    });
    return problemResponse(problem("internal_unexpected", "RPC returned no row"), reqUrl);
  }

  // Code-review patch (P7): defensively guard against a malformed RPC
  // return (e.g., string that doesn't coerce to a number → NaN). The
  // JSON response would otherwise emit `"enqueued":null` and the UI
  // would render a misleading generic-error toast.
  const enqueued = typeof row.enqueued === "number" ? row.enqueued : Number(row.enqueued);
  if (!Number.isFinite(enqueued)) {
    logJson("error", "sms_resend_history.unexpected", {
      collector_id: auth.collectorId,
      reason: "rpc_enqueued_not_a_number",
      raw: row.enqueued,
    });
    return problemResponse(problem("internal_unexpected", "RPC returned a malformed row"), reqUrl);
  }
  const reason: string | null = row.reason ?? null;

  if (enqueued === 0) {
    logJson("info", "sms_resend_history.short_circuited", {
      collector_id: auth.collectorId,
      member_id: parsed.member_id,
      cycle_id: parsed.cycle_id,
      reason,
    });
  } else {
    logJson("info", "sms_resend_history.enqueued", {
      collector_id: auth.collectorId,
      member_id: parsed.member_id,
      cycle_id: parsed.cycle_id,
      count: enqueued,
    });
  }

  return new Response(JSON.stringify({ enqueued, reason }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Supabase Edge Functions runtime entry point.
type DenoGlobal = { serve?: (handler: (req: Request) => Promise<Response>) => unknown };
const denoMaybe: DenoGlobal | undefined = (globalThis as { Deno?: DenoGlobal }).Deno;
if (denoMaybe?.serve) {
  denoMaybe.serve(handler);
}
