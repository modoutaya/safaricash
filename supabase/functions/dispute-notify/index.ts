// Story 10.2 / FR33b / AR12 — dispute-notify Edge Function.
//
// POST /functions/v1/dispute-notify  { dispute_id, transaction_id, collector_id }
//
// Invoked by the dispute_notify_after_insert trigger (pg_net) when a
// public.disputes row is created (by Story 10.1's flag_transaction_dispute).
// Fans the dispute out to four parties — each output INDEPENDENT best-effort;
// a single failure never aborts the others and never 500s the function:
//   1. SMS      — enqueue a dispute_ack SMS to the saver (enqueue_dispute_ack
//                 RPC → sms_queue → the existing sms-worker sends it).
//   2. Email    — notify the founder via Resend.
//   3. Realtime — broadcast on disputes:{collector_id} for the collector app
//                 (emit-only; the client subscription is Story 10.3).
//   4. Push     — a logged no-op stub (real push is Growth).
//
// Service-role-only (invoked server-side by pg_net, never by a browser).
// NEVER logs saver PII (phone, name, dispute notes).
//
// See: _bmad-output/implementation-artifacts/10-2-dispute-notify-edge-function.md

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { sendEmail } from "../_shared/email-client.ts";
import { problem, problemResponse } from "../_shared/rfc7807.ts";

type OutputStatus = "sent" | "queued" | "skipped" | "failed";

type Outputs = {
  sms: OutputStatus;
  email: OutputStatus;
  realtime: OutputStatus;
  push: "stub";
};

const REALTIME_SUBSCRIBE_TIMEOUT_MS = 5_000;

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

type DisputeRow = {
  id: string;
  notes: string | null;
  flagged_at: string;
  collector_id: string;
  transaction_id: string;
};

/** Output 1 — enqueue the saver's dispute_ack SMS. */
async function enqueueAck(service: SupabaseClient, transactionId: string): Promise<OutputStatus> {
  try {
    const { data, error } = await service.rpc("enqueue_dispute_ack", {
      p_transaction_id: transactionId,
    });
    if (error) {
      logJson("error", "dispute_notify.sms_rpc_failed", { error: error.message });
      return "failed";
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { enqueued?: number; reason?: string | null }
      | undefined;
    if (row?.enqueued === 1) return "queued";
    logJson("info", "dispute_notify.sms_skipped", { reason: row?.reason ?? "unknown" });
    return "skipped";
  } catch (err) {
    logJson("error", "dispute_notify.sms_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

/** Output 2 — email the founder. */
async function emailFounder(
  service: SupabaseClient,
  dispute: DisputeRow,
  transactionId: string,
  collectorId: string,
): Promise<OutputStatus> {
  const founderEmail = Deno.env.get("FOUNDER_SUPPORT_EMAIL");
  if (!founderEmail) {
    logJson("warn", "dispute_notify.email_skipped_no_recipient", {});
    return "skipped";
  }
  try {
    const { data: tx } = await service
      .from("transactions_decrypted")
      .select("amount, created_at")
      .eq("id", transactionId)
      .maybeSingle();
    // Resolve a human-readable collector identifier — a bare UUID is opaque
    // to the founder who must act on the dispute within minutes.
    const { data: collector } = await service
      .from("users")
      .select("phone_number")
      .eq("id", collectorId)
      .maybeSingle();
    const collectorLabel = collector?.phone_number
      ? `${collector.phone_number} (${collectorId})`
      : collectorId;
    const ref = dispute.id.slice(0, 8);
    const amountStr =
      tx?.amount !== null && tx?.amount !== undefined ? `${tx.amount} FCFA` : "indisponible";
    const subject = `SafariCash — litige signalé (réf. ${ref})`;
    const text = [
      "Un saver a signalé un litige sur une transaction via la page de reçu.",
      "",
      `Référence : ${ref}`,
      `Collecteur : ${collectorLabel}`,
      `Transaction : ${transactionId}`,
      `Montant : ${amountStr}`,
      `Signalé le : ${dispute.flagged_at}`,
      `Message du saver : ${dispute.notes && dispute.notes.trim() !== "" ? dispute.notes : "(aucun)"}`,
      "",
      "Délai de réponse cible : 48 h. Adjudication manuelle (MVP).",
    ].join("\n");
    return await sendEmail({ to: founderEmail, subject, text });
  } catch (err) {
    logJson("error", "dispute_notify.email_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

/** Output 3 — emit a Realtime broadcast on the collector's dispute channel.
 *  Emit-only; the client subscription is Story 10.3. Best-effort. */
async function emitRealtime(
  service: SupabaseClient,
  collectorId: string,
  dispute: DisputeRow,
  transactionId: string,
): Promise<OutputStatus> {
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;
  try {
    const { data: tx } = await service
      .from("transactions")
      .select("member_id")
      .eq("id", transactionId)
      .maybeSingle();

    channel = service.channel(`disputes:${collectorId}`);
    const ch = channel;
    const subscribed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), REALTIME_SUBSCRIBE_TIMEOUT_MS);
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve(true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
    if (!subscribed) return "failed";
    // channel.send() RESOLVES with an "ok" | "error" | "timed out" status —
    // it does not throw — so the result must be inspected.
    const sendResult = await ch.send({
      type: "broadcast",
      event: "dispute_flagged",
      payload: {
        dispute_id: dispute.id,
        transaction_id: transactionId,
        member_id: tx?.member_id ?? null,
        flagged_at: dispute.flagged_at,
      },
    });
    return sendResult === "ok" ? "sent" : "failed";
  } catch (err) {
    logJson("error", "dispute_notify.realtime_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  } finally {
    if (channel) await service.removeChannel(channel).catch(() => {});
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return problemResponse(problem("method_not_allowed", `Method ${req.method} not allowed`));
  }
  if (!isServiceRole(req)) {
    return problemResponse(
      problem(
        "auth_service_role_required",
        "dispute-notify is invocable only with the service role key",
      ),
    );
  }

  let raw: { dispute_id?: unknown; transaction_id?: unknown; collector_id?: unknown };
  try {
    const txt = await req.text();
    raw = txt ? JSON.parse(txt) : {};
  } catch {
    return problemResponse(problem("request_invalid", "Body is not valid JSON"));
  }
  const disputeId = typeof raw.dispute_id === "string" ? raw.dispute_id : null;
  const transactionId = typeof raw.transaction_id === "string" ? raw.transaction_id : null;
  const collectorId = typeof raw.collector_id === "string" ? raw.collector_id : null;
  if (!disputeId || !transactionId || !collectorId) {
    return problemResponse(
      problem("request_invalid", "dispute_id, transaction_id and collector_id are required"),
    );
  }

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    logJson("error", "dispute_notify.env_missing", {});
    return problemResponse(problem("internal_unexpected", "Edge function env not configured"));
  }
  const service = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const outputs: Outputs = { sms: "skipped", email: "skipped", realtime: "skipped", push: "stub" };

  // Resolve the dispute — also the existence check (an unknown id → all skipped).
  const { data: dispute } = await service
    .from("disputes")
    .select("id, notes, flagged_at, collector_id, transaction_id")
    .eq("id", disputeId)
    .maybeSingle<DisputeRow>();

  if (!dispute) {
    logJson("warn", "dispute_notify.unknown_dispute", { dispute_id_prefix: disputeId.slice(0, 8) });
    return new Response(JSON.stringify({ ok: true, outputs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Three independent best-effort outputs, run concurrently — none depends
  // on another's result, and each resolves to a status without throwing.
  const [sms, email, realtime] = await Promise.all([
    enqueueAck(service, transactionId),
    emailFounder(service, dispute, transactionId, collectorId),
    emitRealtime(service, collectorId, dispute, transactionId),
  ]);
  outputs.sms = sms;
  outputs.email = email;
  outputs.realtime = realtime;
  // Output 4 — push: a logged no-op stub. Real push (Web Push / VAPID) is Growth.
  logJson("info", "dispute_notify.push_stub", {
    collector_id: collectorId,
    dispute_id_prefix: disputeId.slice(0, 8),
  });

  logJson("info", "dispute_notify.completed", {
    collector_id: collectorId,
    dispute_id_prefix: disputeId.slice(0, 8),
    sms: outputs.sms,
    email: outputs.email,
    realtime: outputs.realtime,
  });

  return new Response(JSON.stringify({ ok: true, outputs }), {
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
