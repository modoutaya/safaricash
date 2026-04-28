// Story 6.5 / FR32 — sms-inbound Edge Function (Termii STOP-keyword webhook).
//
// POST /functions/v1/sms-inbound?secret=<shared-secret>
// Body (Termii v3): { id, from, to, text, received_at, ... }
//
// If `text` (case-insensitive, trimmed) starts with "STOP", look up
// every member whose decrypted phone matches `from` (across collectors)
// and call set_member_sms_opt_out(member_id, 'stop_keyword').
//
// Auth: shared static secret in `?secret=` query string (Termii doesn't
// ship request signing for inbound; an HMAC upgrade is queued for a
// future story once Termii v4 lands).
//
// NEVER logs plaintext phone or full inbound text. Phone hashed via
// SHA-256 prefix (mirrors Story 6.1 / 6.2).

import { createHash } from "node:crypto";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { problem, problemResponse } from "../_shared/rfc7807.ts";

type RequestBody = { from?: unknown; text?: unknown };

function logJson(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level, event, ...fields }));
}

function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isStopKeyword(text: string): boolean {
  const trimmed = text.trim().toUpperCase();
  if (trimmed === "STOP") return true;
  // "STOP merci" or "STOP " followed by extra content also counts.
  return trimmed.startsWith("STOP ") || trimmed.startsWith("STOP\t");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return problemResponse(problem("method_not_allowed", `Method ${req.method} not allowed`));
  }

  const url = new URL(req.url);
  const providedSecret = url.searchParams.get("secret") ?? "";
  const expectedSecret = Deno.env.get("TERMII_INBOUND_SECRET") ?? "";
  if (!expectedSecret) {
    logJson("error", "sms_inbound.secret_unset", {});
    return problemResponse(problem("internal_unexpected", "Inbound webhook secret not configured"));
  }
  if (!constantTimeEquals(providedSecret, expectedSecret)) {
    return problemResponse(
      problem("auth_unauthenticated", "Inbound webhook secret missing or invalid"),
    );
  }

  let raw: RequestBody;
  try {
    raw = (await req.json()) as RequestBody;
  } catch {
    return problemResponse(problem("request_invalid", "Body is not valid JSON"));
  }
  const fromPhone = typeof raw.from === "string" ? raw.from.trim() : "";
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!fromPhone) {
    return problemResponse(problem("request_invalid", "Body.from must be a non-empty string"));
  }
  if (typeof raw.text !== "string") {
    return problemResponse(problem("request_invalid", "Body.text must be a string"));
  }

  const phoneHash = hashPhone(fromPhone);

  // Non-STOP messages are silently ignored. Don't leak shape; respond 200.
  if (!isStopKeyword(text)) {
    logJson("info", "sms_inbound.ignored", {
      from_hash: phoneHash,
      reason: "not_stop_keyword",
    });
    return new Response(JSON.stringify({ ignored: true, reason: "not_stop_keyword" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    logJson("error", "sms_inbound.env_missing", {});
    return problemResponse(problem("internal_unexpected", "Edge function env not configured"));
  }
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Reverse-vault lookup via SECURITY DEFINER RPC (migration 0049).
  // O(N) over active members but acceptable for an inbound webhook
  // (low volume, member count bounded).
  const { data: matches, error: lookupErr } = await service.rpc("find_members_by_phone", {
    p_phone: fromPhone,
  });
  if (lookupErr) {
    logJson("error", "sms_inbound.lookup_failed", { error: lookupErr.message });
    return problemResponse(problem("internal_unexpected", "Member lookup failed"));
  }
  const memberIds: string[] = ((matches ?? []) as Array<{ id: string }>).map((row) => row.id);

  let optedOut = 0;
  for (const memberId of memberIds) {
    const { error: rpcErr } = await service.rpc("set_member_sms_opt_out", {
      p_member_id: memberId,
      p_via: "stop_keyword",
    });
    if (rpcErr) {
      logJson("warn", "sms_inbound.opt_out_rpc_failed", {
        member_id: memberId,
        error: rpcErr.message,
      });
      continue;
    }
    optedOut += 1;
  }

  logJson("info", "sms_inbound.processed", {
    from_hash: phoneHash,
    members_matched: memberIds.length,
    opted_out: optedOut,
  });

  return new Response(JSON.stringify({ opted_out: optedOut }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
