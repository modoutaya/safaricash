// Story 10.4 / FR48 / AR13 — saver-delete Edge Function.
//
// POST /functions/v1/saver-delete  { member_id, confirm }
//
// Honours a saver's right-to-deletion request by irreversibly anonymising
// their PII. A thin transport/validation shell — ALL data mutation lives in
// the anonymise_member SECURITY DEFINER RPC (overwrites the name/phone Vault
// secrets in place with salted hashes, sets sms_opt_out, stamps
// anonymised_at, chains a member.anonymised audit event).
//
// Service-role-only — invoked server-side by support/the founder with the
// service-role key (there is no saver-facing surface at MVP). `confirm` must
// be literally true — a deliberate guard against an accidental call.
// NEVER logs or returns plaintext PII (saver name, phone).
//
// See: _bmad-output/implementation-artifacts/10-4-saver-anonymisation-edge-function.md

import { createClient } from "jsr:@supabase/supabase-js@2";

import { problem, problemResponse } from "../_shared/rfc7807.ts";

type AnonymiseStatus = "anonymised" | "already_anonymised" | "not_found";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function logJson(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isServiceRole(req: Request): boolean {
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!expected) return false;
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return constantTimeEquals(m[1] ?? "", expected);
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return problemResponse(problem("method_not_allowed", `Method ${req.method} not allowed`));
  }
  if (!isServiceRole(req)) {
    return problemResponse(
      problem(
        "auth_service_role_required",
        "saver-delete is invocable only with the service role key",
      ),
    );
  }

  let raw: { member_id?: unknown; confirm?: unknown };
  try {
    const txt = await req.text();
    raw = txt ? JSON.parse(txt) : {};
  } catch {
    return problemResponse(problem("request_invalid", "Body is not valid JSON"));
  }

  const memberId = typeof raw.member_id === "string" ? raw.member_id : null;
  if (!memberId || !UUID_RE.test(memberId)) {
    return problemResponse(problem("request_invalid", "member_id must be a UUID"));
  }
  if (raw.confirm !== true) {
    return problemResponse(problem("request_invalid", "confirm must be true to anonymise a saver"));
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    logJson("error", "saver_delete.env_missing", {});
    return problemResponse(problem("internal_unexpected", "Edge function env not configured"));
  }
  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await service.rpc("anonymise_member", { p_member_id: memberId });
  if (error) {
    // Do NOT leak the DB error text to the caller.
    logJson("error", "saver_delete.rpc_failed", {
      member_id_prefix: memberId.slice(0, 8),
      error: error.message,
    });
    return problemResponse(problem("internal_unexpected", "Anonymisation failed"));
  }

  // anonymise_member always `return query select`s a row — a null / empty
  // result means a broken RPC contract, not a real 'not_found'.
  const row = (Array.isArray(data) ? data[0] : data) as { status?: string } | undefined;
  if (!row || typeof row.status !== "string") {
    logJson("error", "saver_delete.rpc_empty", { member_id_prefix: memberId.slice(0, 8) });
    return problemResponse(problem("internal_unexpected", "Anonymisation failed"));
  }
  const status = row.status as AnonymiseStatus;

  logJson("info", "saver_delete.completed", {
    member_id_prefix: memberId.slice(0, 8),
    status,
  });

  return new Response(JSON.stringify({ ok: true, status }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Supabase Edge Functions runtime entry point. Guarded so `import`-ing the
// module in a Deno test does not start a server.
type DenoGlobal = { serve?: (handler: (req: Request) => Promise<Response>) => unknown };
const denoMaybe: DenoGlobal | undefined = (globalThis as { Deno?: DenoGlobal }).Deno;
if (denoMaybe?.serve) {
  denoMaybe.serve(handler);
}
