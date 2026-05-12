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
//   - NEVER mint/refresh the caller's session JWT — verify-password.ts
//     uses a fresh anon client per call; the caller's main session is
//     untouched.
//   - 4xx/5xx responses ALWAYS RFC 7807 (Content-Type: application/problem+json).
//
// Story 6.6 — verify-password logic extracted to `_shared/verify-password.ts`
// (no behaviour change; second consumer is sms-resend-history).
//
// See: _bmad-output/implementation-artifacts/1-5b-password-auth-switch.md AC #7
//      + _bmad-output/implementation-artifacts/6-6-resend-cycle-history.md AC #6
//      + PRD v1.3 FR5 + architecture.md § Sensitive-op re-auth.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { z } from "https://deno.land/x/zod@v3.23.8/mod.ts";

import { assertAuthenticated, buildAnonClient, buildServiceClient } from "../_shared/auth-check.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { verifyPassword } from "../_shared/verify-password.ts";

// Module-scope lazy clients for the caller-JWT + service paths.
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

  // 3. Delegate to shared verify-password helper (Story 6.6 extraction).
  const verifyResult = await verifyPassword({
    serviceClient: getServiceClient(),
    collectorId: auth.collectorId,
    password: parsed.password,
    logContext: { operation_intent: parsed.operation_intent },
  });

  if (!verifyResult.ok) {
    return problemResponse(verifyResult.problem, reqUrl);
  }

  return new Response(JSON.stringify({ ok: true, scope: parsed.operation_intent }), {
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
