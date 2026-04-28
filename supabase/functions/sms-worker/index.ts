// Story 6.2 / FR27 — sms-worker Edge Function (drains sms_queue via Termii).
//
// POST /functions/v1/sms-worker  { batch_size?: number, dry_run?: boolean }
//
// Service-role-only entry point. Scheduled every 30 s by pg_cron (migration
// 0038). Drains up to batch_size ready rows from sms_queue via the
// claim_sms_queue_batch RPC (FOR UPDATE SKIP LOCKED), dispatches each row
// in parallel via Termii's `sendSmsNoRetry`, and updates row status:
//   - 200 from Termii          → status='sent', emit 'sms.sent'
//   - 5xx / network / timeout  → retry_count++, next_retry_at = now() +
//                                 backoff(retry_count) up to 600s cap;
//                                 if age >= 24h, status='abandoned', emit
//                                 'sms.abandoned'.
//   - 4xx from Termii          → status='failed', emit 'sms.failed'
//   - transaction soft-undone  → status='abandoned', NO audit (the undo
//                                 path already emitted 'transaction.undone')
//
// NEVER logs plaintext phone numbers or SMS bodies.

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { problem, problemResponse } from "../_shared/rfc7807.ts";
import { sendSmsNoRetry, TermiiError } from "../_shared/termii-client.ts";
import { backoffDelaySeconds } from "./backoff.ts";

const ABANDON_AGE_SECONDS = 24 * 60 * 60; // 24 hours
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;
const CLAIM_TTL_SECONDS = 90;

type ClaimedRow = {
  id: string;
  collector_id: string;
  transaction_id: string | null;
  recipient_phone: string;
  body: string;
  template_key: "first_receipt" | "subsequent_receipt" | "settlement" | "dispute_ack";
  retry_count: number;
  age_seconds: number;
};

type Outcome = "sent" | "failed" | "scheduled_retry" | "abandoned" | "skipped";

type RowResult = {
  queue_id: string;
  outcome: Outcome;
};

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

function isServiceRole(req: Request): boolean {
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!expected) return false;
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return constantTimeEquals(m[1] ?? "", expected);
}

type RequestBody = { batch_size?: unknown; dry_run?: unknown };

type ParsedBody = { batch_size: number; dry_run: boolean };

function parseBody(raw: RequestBody): ParsedBody | { error: string } {
  let batchSize: number = DEFAULT_BATCH_SIZE;
  if (raw.batch_size !== undefined) {
    if (typeof raw.batch_size !== "number" || !Number.isInteger(raw.batch_size)) {
      return { error: "batch_size must be an integer" };
    }
    if (raw.batch_size < 1 || raw.batch_size > MAX_BATCH_SIZE) {
      return { error: `batch_size must be in [1, ${MAX_BATCH_SIZE}]` };
    }
    batchSize = raw.batch_size;
  }
  let dryRun = false;
  if (raw.dry_run !== undefined) {
    if (typeof raw.dry_run !== "boolean") {
      return { error: "dry_run must be a boolean" };
    }
    dryRun = raw.dry_run;
  }
  return { batch_size: batchSize, dry_run: dryRun };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return problemResponse(problem("method_not_allowed", `Method ${req.method} not allowed`));
  }

  if (!isServiceRole(req)) {
    return problemResponse(
      problem(
        "auth_service_role_required",
        "sms-worker is invocable only with the service role key",
      ),
    );
  }

  let raw: RequestBody;
  try {
    const txt = await req.text();
    raw = txt ? (JSON.parse(txt) as RequestBody) : ({} as RequestBody);
  } catch {
    return problemResponse(problem("request_invalid", "Body is not valid JSON"));
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return problemResponse(problem("request_invalid", parsed.error));
  }
  const { batch_size, dry_run } = parsed;

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    logJson("error", "sms_worker.env_missing", {});
    return problemResponse(problem("internal_unexpected", "Edge function env not configured"));
  }
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const t0 = Date.now();
  logJson("info", "sms_worker.drain_started", { batch_size, dry_run });

  // Claim a batch.
  const { data: claimed, error: claimErr } = await service.rpc("claim_sms_queue_batch", {
    p_batch_size: batch_size,
    p_claim_ttl_seconds: CLAIM_TTL_SECONDS,
  });
  if (claimErr) {
    logJson("error", "sms_worker.claim_failed", { error: claimErr.message });
    return problemResponse(problem("internal_unexpected", "Claim batch failed"));
  }
  const rows = (claimed ?? []) as ClaimedRow[];

  if (rows.length === 0) {
    const elapsed = Date.now() - t0;
    logJson("info", "sms_worker.drain_completed", {
      batch_size,
      rows_drained: 0,
      sent: 0,
      scheduled_retry: 0,
      abandoned: 0,
      failed: 0,
      skipped: 0,
      total_duration_ms: elapsed,
      dry_run,
    });
    return new Response(
      JSON.stringify({
        drained: 0,
        sent: 0,
        scheduled_retry: 0,
        abandoned: 0,
        failed: 0,
        skipped: 0,
        ...(dry_run ? { dry_run: true } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Process rows in parallel.
  const results = await Promise.all(rows.map((row) => processRow(service, row, dry_run)));

  const tally = {
    sent: 0,
    scheduled_retry: 0,
    abandoned: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of results) {
    tally[r.outcome] += 1;
  }

  const totalMs = Date.now() - t0;
  logJson("info", "sms_worker.drain_completed", {
    batch_size,
    rows_drained: rows.length,
    ...tally,
    total_duration_ms: totalMs,
    dry_run,
  });

  return new Response(
    JSON.stringify({
      drained: rows.length,
      ...tally,
      ...(dry_run ? { dry_run: true } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

async function processRow(
  service: SupabaseClient,
  row: ClaimedRow,
  dryRun: boolean,
): Promise<RowResult> {
  const t0 = Date.now();
  const phoneHash = hashPhone(row.recipient_phone);

  // Story 6.5 placeholder — sms_opt_out wire-in slot. Replace
  // `optedOut` with `row.member.sms_opt_out` once Story 6.5 ships the column.
  const optedOut = false as boolean;
  if (optedOut) {
    return abandonRow(service, row, "skipped", "skipped_opt_out", phoneHash, t0);
  }

  // Re-check undone (the claim filter already excludes; this is defence in depth).
  if (row.transaction_id !== null) {
    const { data: tx } = await service
      .from("transactions")
      .select("id, undone_at")
      .eq("id", row.transaction_id)
      .maybeSingle();
    if (tx?.undone_at !== null && tx?.undone_at !== undefined) {
      return abandonSkippedUndone(service, row, phoneHash, t0);
    }
  }

  if (dryRun) {
    logJson("info", "sms_worker.row_processed", {
      queue_id: row.id,
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      outcome: "skipped",
      retry_count: row.retry_count,
      duration_ms: Date.now() - t0,
      dry_run: true,
    });
    return { queue_id: row.id, outcome: "skipped" };
  }

  // Fire Termii.
  let messageId: string | null = null;
  let termiiErr: TermiiError | null = null;
  try {
    const result = await sendSmsNoRetry({ to: row.recipient_phone, body: row.body });
    messageId = result.message_id;
  } catch (err) {
    if (err instanceof TermiiError) {
      termiiErr = err;
    } else {
      // Unexpected error class — treat as transient (retryable).
      termiiErr = new TermiiError(
        `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        503,
        "",
      );
    }
  }

  // Termii success — mark sent.
  if (messageId !== null) {
    const { error: upErr } = await service
      .from("sms_queue")
      .update({ status: "sent", last_attempt_at: new Date().toISOString(), next_retry_at: null })
      .eq("id", row.id);
    if (upErr) {
      logJson("error", "sms_worker.update_sent_failed", {
        queue_id: row.id,
        error: upErr.message,
      });
    }
    await emitAudit(service, row.collector_id, "sms.sent", row.id, {
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      message_id: messageId,
    });
    logJson("info", "sms_worker.row_processed", {
      queue_id: row.id,
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      outcome: "sent",
      retry_count: row.retry_count,
      duration_ms: Date.now() - t0,
    });
    return { queue_id: row.id, outcome: "sent" };
  }

  // Termii error path.
  const httpStatus = termiiErr?.httpStatus ?? 503;
  const errExcerpt = (termiiErr?.bodyExcerpt ?? "").slice(0, 200);

  // 4xx — terminal failure.
  if (httpStatus >= 400 && httpStatus < 500) {
    const { error: upErr } = await service
      .from("sms_queue")
      .update({ status: "failed", last_attempt_at: new Date().toISOString() })
      .eq("id", row.id);
    if (upErr) {
      logJson("error", "sms_worker.update_failed_failed", {
        queue_id: row.id,
        error: upErr.message,
      });
    }
    await emitAudit(service, row.collector_id, "sms.failed", row.id, {
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      http_status: httpStatus,
      error_excerpt: errExcerpt,
    });
    logJson("warn", "sms_worker.row_processed", {
      queue_id: row.id,
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      outcome: "failed",
      retry_count: row.retry_count,
      http_status: httpStatus,
      duration_ms: Date.now() - t0,
    });
    return { queue_id: row.id, outcome: "failed" };
  }

  // 5xx / network / timeout — abandon if 24h+, else schedule retry.
  if (row.age_seconds >= ABANDON_AGE_SECONDS) {
    const { error: upErr } = await service
      .from("sms_queue")
      .update({
        status: "abandoned",
        abandoned_at: new Date().toISOString(),
        last_attempt_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (upErr) {
      logJson("error", "sms_worker.update_abandoned_failed", {
        queue_id: row.id,
        error: upErr.message,
      });
    }
    await emitAudit(service, row.collector_id, "sms.abandoned", row.id, {
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      retry_count: row.retry_count,
      age_seconds: row.age_seconds,
    });
    logJson("warn", "sms_worker.row_processed", {
      queue_id: row.id,
      template_key: row.template_key,
      recipient_phone_hash: phoneHash,
      outcome: "abandoned",
      retry_count: row.retry_count,
      age_seconds: row.age_seconds,
      duration_ms: Date.now() - t0,
    });
    return { queue_id: row.id, outcome: "abandoned" };
  }

  const delaySec = backoffDelaySeconds(row.retry_count);
  const nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
  const { error: upErr } = await service
    .from("sms_queue")
    .update({
      retry_count: row.retry_count + 1,
      next_retry_at: nextRetryAt,
      last_attempt_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (upErr) {
    logJson("error", "sms_worker.update_retry_failed", {
      queue_id: row.id,
      error: upErr.message,
    });
  }
  logJson("info", "sms_worker.row_processed", {
    queue_id: row.id,
    template_key: row.template_key,
    recipient_phone_hash: phoneHash,
    outcome: "scheduled_retry",
    retry_count: row.retry_count + 1,
    next_retry_at: nextRetryAt,
    http_status: httpStatus,
    duration_ms: Date.now() - t0,
  });
  return { queue_id: row.id, outcome: "scheduled_retry" };
}

async function abandonSkippedUndone(
  service: SupabaseClient,
  row: ClaimedRow,
  phoneHash: string,
  t0: number,
): Promise<RowResult> {
  // No audit event — the undo path already emitted transaction.undone.
  await service
    .from("sms_queue")
    .update({
      status: "abandoned",
      abandoned_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  logJson("info", "sms_worker.row_processed", {
    queue_id: row.id,
    template_key: row.template_key,
    recipient_phone_hash: phoneHash,
    outcome: "skipped",
    reason: "transaction_undone",
    duration_ms: Date.now() - t0,
  });
  return { queue_id: row.id, outcome: "skipped" };
}

async function abandonRow(
  service: SupabaseClient,
  row: ClaimedRow,
  outcome: Outcome,
  reason: string,
  phoneHash: string,
  t0: number,
): Promise<RowResult> {
  await service
    .from("sms_queue")
    .update({
      status: "abandoned",
      abandoned_at: new Date().toISOString(),
      last_attempt_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  logJson("info", "sms_worker.row_processed", {
    queue_id: row.id,
    template_key: row.template_key,
    recipient_phone_hash: phoneHash,
    outcome,
    reason,
    duration_ms: Date.now() - t0,
  });
  return { queue_id: row.id, outcome };
}

async function emitAudit(
  service: SupabaseClient,
  collectorId: string,
  eventType: "sms.sent" | "sms.failed" | "sms.abandoned",
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await service.rpc("audit_append_external", {
    p_event_type: eventType,
    p_entity_id: entityId,
    p_entity_table: "sms_queue",
    p_payload: payload,
    p_collector_id: collectorId,
  });
  if (error) {
    logJson("warn", "sms_worker.audit_emit_failed", {
      collector_id: collectorId,
      queue_id: entityId,
      event_type: eventType,
      error: error.message,
    });
  }
}
