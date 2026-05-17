// Story 7.4 — cycle-settlement Edge Function.
//
// Collector-initiated atomic settlement commit, gated by password re-auth
// (FR5) and NFR-R3 zero-tolerance payout cross-check.
//
// Request:
//   POST /functions/v1/cycle-settlement
//   Authorization: Bearer <collector JWT>
//   Body: { member_id: uuid, cycle_id: uuid, expected_payout: int, password: string }
//
// Flow:
//   1. JWT auth (assertAuthenticated).
//   2. Password verify via _shared/verify-password.ts (FR5 re-auth gate).
//   3. JWT-bound supabase-js client → call commit_cycle_settlement RPC.
//   4. RPC returns (settlement_transaction_id, settled_payout, settled_at);
//      map to JSON.
//
// Success (200): { ok: true, settlement_transaction_id, settled_payout, settled_at }
// Failures (RFC 7807):
//   400 request_invalid         — body schema fail
//   401 auth_unauthenticated    — missing / invalid JWT
//   401 credentials_invalid     — password wrong
//   404 not_found               — cycle not found / not owned
//   405 method_not_allowed      — non-POST
//   409 cycle_not_settleable    — cycle.status ≠ 'completed' OR cycle/member mismatch
//   409 payout_mismatch         — client/server payout disagree (NFR-R3)
//   429 rate_limited            — Supabase Auth per-identifier cap hit
//   500 internal_unexpected     — anything else
//
// Hard rules (parity with re-auth + sms-resend-history):
//   - NEVER log password.
//   - All 4xx/5xx responses use RFC 7807 (application/problem+json).
//   - 500 detail is a static string — error.message is logged server-side only.
//
// See: _bmad-output/implementation-artifacts/7-4-settlement-reauth-gate.md AC #5.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

import { assertAuthenticated, buildAnonClient, buildServiceClient } from "../_shared/auth-check.ts";
import { withCors } from "../_shared/cors.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { verifyPassword } from "../_shared/verify-password.ts";

// Module-scope lazy singletons.
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
  // Positive integer FCFA. Story 7.1's SettlementSummaryCard computes this
  // via @/domain/cycle's settle() and passes it through Story 7.3's route.
  expected_payout: z.number().int().positive("expected_payout must be a positive integer"),
  // Story 6.6 P8 — trim before length check so whitespace-only is rejected
  // BEFORE we burn a Supabase Auth rate-limit slot.
  password: z.string().trim().min(1, "password required"),
});

type LogEvent =
  | "cycle_settlement.committed"
  | "cycle_settlement.payout_mismatch"
  | "cycle_settlement.unexpected";

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
      problem("method_not_allowed", `Only POST is allowed; got ${req.method}`),
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
    logContext: {
      operation_intent: "cycle_settlement",
      member_id: parsed.member_id,
      cycle_id: parsed.cycle_id,
    },
  });
  if (!verifyResult.ok) {
    return problemResponse(verifyResult.problem, reqUrl);
  }

  // 4. Call commit_cycle_settlement under the caller's JWT — RPC asserts
  //    auth.uid() ownership + cycle status preconditions itself.
  let jwtClient: SupabaseClient;
  try {
    jwtClient = buildJwtBoundClient(auth.jwt);
  } catch (err) {
    logJson("error", "cycle_settlement.unexpected", {
      collector_id: auth.collectorId,
      reason: "jwt_client_build",
      error: (err as Error).message,
    });
    return problemResponse(
      problem("internal_unexpected", "Could not build user-scoped Supabase client"),
      reqUrl,
    );
  }

  const { data, error } = await jwtClient.rpc("commit_cycle_settlement", {
    p_member_id: parsed.member_id,
    p_cycle_id: parsed.cycle_id,
    p_expected_payout: parsed.expected_payout,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    const message = error.message ?? "";

    // Auth failure path — JWT-bound client should never see this, but
    // defensive parity with sms-resend-history.
    if (code === "28000") {
      logJson("warn", "cycle_settlement.unexpected", {
        collector_id: auth.collectorId,
        reason: "rpc_auth_unauthenticated",
      });
      return problemResponse(
        problem("auth_unauthenticated", "RPC rejected: caller not authenticated"),
        reqUrl,
      );
    }

    // P0002 path — parse the message prefix to map to the right 7807 type.
    if (code === "P0002") {
      if (message.includes("payout mismatch")) {
        // Code-review patch #3 — extract `server_payout` from the PG error
        // message (format: 'payout mismatch (client=X, server=Y)') and
        // surface it in the RFC 7807 body. Spec AC #5 mandate: client must
        // see the authoritative server number to render an informed error.
        const match = message.match(/server=(\d+)/);
        const serverPayout = match ? Number(match[1]) : undefined;
        logJson("warn", "cycle_settlement.payout_mismatch", {
          collector_id: auth.collectorId,
          member_id: parsed.member_id,
          cycle_id: parsed.cycle_id,
          client_payout: parsed.expected_payout,
          server_payout: serverPayout,
          pg_message: message,
        });
        return problemResponse(
          problem(
            "payout_mismatch",
            "Server-computed payout differs from client value",
            serverPayout !== undefined ? { server_payout: serverPayout } : {},
          ),
          reqUrl,
        );
      }
      if (message.includes("cycle not in completed status")) {
        return problemResponse(
          problem("cycle_not_settleable", "Cycle is not in 'completed' status"),
          reqUrl,
        );
      }
      if (message.includes("cycle/member mismatch")) {
        // Code-review patch #2 — bug-class error (mismatched UUIDs in the
        // request body): 400 request_invalid, not 409 cycle_not_settleable.
        // The latter would mislead the client into showing "Ce cycle n'est
        // plus prêt à être clôturé" / reload — but no reload fixes a
        // client-side UUID mismatch.
        return problemResponse(
          problem("request_invalid", "Cycle does not belong to the given member"),
          reqUrl,
        );
      }
      if (message.includes("cycle not found or not owned")) {
        return problemResponse(
          problem("not_found", "Cycle not found or not owned by caller"),
          reqUrl,
        );
      }
      // Unknown P0002 — log + return generic 500.
      logJson("error", "cycle_settlement.unexpected", {
        collector_id: auth.collectorId,
        reason: "rpc_p0002_unmapped",
        pg_message: message,
      });
      return problemResponse(
        problem("internal_unexpected", "Unexpected settlement precondition failure"),
        reqUrl,
      );
    }

    // Anything else — log server-side (NEVER include the raw message in the
    // RFC 7807 detail; PostgREST messages can carry table / column / vault
    // identifiers).
    logJson("error", "cycle_settlement.unexpected", {
      collector_id: auth.collectorId,
      reason: "rpc_failed",
      pg_code: code,
      message,
    });
    return problemResponse(
      problem("internal_unexpected", "Unexpected error processing the settlement"),
      reqUrl,
    );
  }

  // 5. Map RPC return (table-returning function → array of one row).
  type RpcRow = {
    settlement_transaction_id: string;
    settled_payout: number | string;
    settled_at: string;
  };
  const row: RpcRow = Array.isArray(data) ? data[0] : (data as RpcRow);
  if (!row) {
    logJson("error", "cycle_settlement.unexpected", {
      collector_id: auth.collectorId,
      reason: "rpc_empty_result",
    });
    return problemResponse(problem("internal_unexpected", "RPC returned no row"), reqUrl);
  }

  // Coerce settled_payout — PostgREST may return it as a string for bigint.
  const settledPayout =
    typeof row.settled_payout === "number" ? row.settled_payout : Number(row.settled_payout);
  if (!Number.isFinite(settledPayout)) {
    logJson("error", "cycle_settlement.unexpected", {
      collector_id: auth.collectorId,
      reason: "rpc_payout_not_finite",
      raw: row.settled_payout,
    });
    return problemResponse(
      problem("internal_unexpected", "RPC returned non-numeric payout"),
      reqUrl,
    );
  }

  logJson("info", "cycle_settlement.committed", {
    collector_id: auth.collectorId,
    member_id: parsed.member_id,
    cycle_id: parsed.cycle_id,
    settlement_transaction_id: row.settlement_transaction_id,
    settled_payout: settledPayout,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      settlement_transaction_id: row.settlement_transaction_id,
      settled_payout: settledPayout,
      settled_at: row.settled_at,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

// Supabase Edge Functions runtime entry point.
type DenoGlobal = { serve?: (handler: (req: Request) => Promise<Response>) => unknown };
const denoMaybe: DenoGlobal | undefined = (globalThis as { Deno?: DenoGlobal }).Deno;
if (denoMaybe?.serve) {
  denoMaybe.serve(withCors(handler));
}
