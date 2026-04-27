// Story 6.1 / FR27 — sms-dispatch Edge Function (manual re-send entry point).
//
// POST /functions/v1/sms-dispatch  { transaction_id: <uuid> }
//
// Inserts a new sms_queue row for the given transaction (mirroring the
// trigger's logic) and emits an `sms.queued` audit event via
// audit_append_external. Use case: Story 6.6's eventual support flow
// where a collector taps "Renvoyer le reçu" on a member's transaction
// history. Each call creates a NEW row — re-sends are intentional, not
// idempotent.
//
// Re-auth NOT required (FR5 — re-sending an SMS the collector already
// owns is not a sensitive operation).
//
// NEVER logs plaintext phone numbers or SMS bodies — structured JSON
// references queue_id only.

import { createHash } from "node:crypto";

import { assertAuthenticated, buildAnonClient, buildServiceClient } from "../_shared/auth-check.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RequestBody = { transaction_id?: unknown };

function logJson(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) {
  // Structured logs — never include plaintext phone numbers or SMS body.
  console.log(JSON.stringify({ level, event, ...fields }));
}

function hashPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return problemResponse(problem("method_not_allowed", `Method ${req.method} not allowed`));
  }

  // Parse + Zod-light validate the body. Avoiding npm:zod here keeps the
  // Edge Function's cold-start small; the validation is one shape check.
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return problemResponse(problem("request_invalid", "Body is not valid JSON"));
  }
  const transactionId = typeof body.transaction_id === "string" ? body.transaction_id : "";
  if (!UUID_REGEX.test(transactionId)) {
    return problemResponse(problem("request_invalid", "transaction_id must be a UUID v4"));
  }

  const anonClient = buildAnonClient();
  const serviceClient = buildServiceClient();

  const auth = await assertAuthenticated(req, anonClient, serviceClient);
  if ("problem" in auth) {
    return problemResponse(auth.problem);
  }
  const { collectorId } = auth;

  // Look up the transaction via service role + filter by collector_id —
  // this enforces RLS-equivalent ownership without round-tripping the
  // user JWT through PostgREST. Returns null for foreign or non-existent.
  const { data: tx, error: txErr } = await serviceClient
    .from("transactions")
    .select("id, member_id, collector_id")
    .eq("id", transactionId)
    .eq("collector_id", collectorId)
    .maybeSingle();
  if (txErr) {
    logJson("error", "sms_dispatch.tx_lookup_failed", {
      collector_id: collectorId,
      tx_id_hash: createHash("sha256").update(transactionId).digest("hex").slice(0, 16),
      error: txErr.message,
    });
    return problemResponse(problem("internal_unexpected", "Transaction lookup failed"));
  }
  if (!tx) {
    return problemResponse(problem("not_found", "Transaction not found or not owned by caller"));
  }

  // Resolve the saver's phone via vault_decrypt. Story 6.5 will gate on
  // members.sms_opt_out here too (placeholder: we don't have that column
  // yet; the trigger has the same placeholder slot).
  const { data: member, error: memberErr } = await serviceClient
    .from("members")
    .select("id, name_encrypted, phone_number_encrypted")
    .eq("id", tx.member_id)
    .single();
  if (memberErr || !member) {
    logJson("error", "sms_dispatch.member_lookup_failed", {
      collector_id: collectorId,
      error: memberErr?.message ?? "no row",
    });
    return problemResponse(problem("internal_unexpected", "Member lookup failed"));
  }

  const { data: phoneDecrypted, error: phoneErr } = await serviceClient.rpc("vault_decrypt", {
    secret_id: member.phone_number_encrypted,
  });
  if (phoneErr) {
    logJson("error", "sms_dispatch.phone_decrypt_failed", {
      collector_id: collectorId,
      error: phoneErr.message,
    });
    return problemResponse(problem("internal_unexpected", "Phone decrypt failed"));
  }
  const phone = (phoneDecrypted ?? "").toString().trim();

  // Cash-only saver — silent skip mirrors the trigger.
  if (phone === "") {
    logJson("info", "sms_dispatch.skipped_no_phone", {
      collector_id: collectorId,
      member_id: member.id,
    });
    return new Response(JSON.stringify({ skipped: true, reason: "no_phone" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Pick template_key — same logic as the trigger function.
  const { count: priorCount, error: countErr } = await serviceClient
    .from("sms_queue")
    .select("id, transactions!inner(member_id)", { count: "exact", head: true })
    .eq("transactions.member_id", tx.member_id);
  if (countErr) {
    logJson("error", "sms_dispatch.prior_count_failed", {
      collector_id: collectorId,
      error: countErr.message,
    });
    return problemResponse(problem("internal_unexpected", "Prior SMS count failed"));
  }
  const templateKey = (priorCount ?? 0) === 0 ? "first_receipt" : "subsequent_receipt";

  // Insert the new sms_queue row (mirror the trigger's INSERT shape).
  const { data: queueRow, error: insertErr } = await serviceClient
    .from("sms_queue")
    .insert({
      collector_id: collectorId,
      transaction_id: transactionId,
      recipient_phone: phone,
      body: "[STUB] Transaction enregistrée",
      status: "queued",
      template_key: templateKey,
      retry_count: 0,
    })
    .select("id")
    .single();
  if (insertErr || !queueRow) {
    logJson("error", "sms_dispatch.insert_failed", {
      collector_id: collectorId,
      error: insertErr?.message ?? "no row",
    });
    return problemResponse(problem("internal_unexpected", "sms_queue insert failed"));
  }

  // Audit emit — sms.queued via the new helper. Use a JWT-bound client
  // so auth.uid() resolves to the collector inside the SECURITY DEFINER
  // function.
  const { headers } = req;
  const jwt = (headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const userScopedClient = (await import("jsr:@supabase/supabase-js@2")).createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    },
  );
  const { error: auditErr } = await userScopedClient.rpc("audit_append_external", {
    p_event_type: "sms.queued",
    p_entity_id: queueRow.id,
    p_entity_table: "sms_queue",
    p_payload: {
      transaction_id: transactionId,
      template_key: templateKey,
      recipient_phone_hash: hashPhone(phone),
    },
  });
  if (auditErr) {
    // Audit failure is logged but doesn't fail the request — the row is
    // already in sms_queue and Story 6.2's worker will dispatch it. The
    // missing audit event is a soft signal in observability.
    logJson("warn", "sms_dispatch.audit_emit_failed", {
      collector_id: collectorId,
      queue_id: queueRow.id,
      error: auditErr.message,
    });
  }

  logJson("info", "sms_dispatch.enqueued", {
    collector_id: collectorId,
    queue_id: queueRow.id,
    template_key: templateKey,
  });

  return new Response(JSON.stringify({ queue_id: queueRow.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
