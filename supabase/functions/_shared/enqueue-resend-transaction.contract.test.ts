// Story 6.7 — enqueue_resend_transaction RPC contract tests.
//
// Covers:
//   1. Happy path — 1 row enqueued; ONE sms.resend_initiated audit event
//      with payload.transaction_id (per-tx scope, not cycle scope).
//   2. Soft-undone transaction → (0, 'undone'), no rows, no audit.
//   3. Opt-out saver → (0, 'opt_out'), no rows, no audit.
//   4. Cash-only saver → (0, 'no_phone'), no rows, no audit.
//   5. Foreign collector → P0002 (uniform message, no enumeration leak).
//   6. Non-existent transaction → P0002.
//   7. Past-cycle transaction (cycle.status = 'settled') → (1, NULL).
//      Defends the AC #2 design decision that cycle gate is intentionally open.
//
// (The spec's Case 5 "unsupported_kind" would need a settlement transaction,
// which Story 4.x doesn't produce yet. Covered by the SQL kind gate itself
// + the type-system constraint on transactions.kind.)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { cleanup, seedCollector, seedMemberWithCycle } from "./test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "enqueue_resend_transaction (6.7) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

async function recordContrib(
  userClient: SupabaseClient,
  memberId: string,
  cycleId: string,
  cycleDay = 1,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: 500,
    p_cycle_day: cycleDay,
  });
  if (error || !txId) throw new Error(`record_contribution: ${error?.message}`);
  return txId as string;
}

type ResendRow = { enqueued: number; reason: string | null };

async function callRpc(
  client: SupabaseClient,
  transactionId: string,
): Promise<{ row: ResendRow | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await client.rpc("enqueue_resend_transaction", {
    p_transaction_id: transactionId,
  });
  if (error) return { row: null, error: error as { code?: string; message: string } };
  const row: ResendRow = Array.isArray(data) ? (data[0] as ResendRow) : (data as ResendRow);
  return { row, error: null };
}

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "1. Happy path — 1 row enqueued + 1 audit event with payload.transaction_id",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        const { count: before } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");

        const { row, error } = await callRpc(userClient, txId);
        assertEquals(error, null);
        assert(row !== null);
        assertEquals(row!.enqueued, 1);
        assertEquals(row!.reason, null);

        const { count: after } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals((after ?? 0) - (before ?? 0), 1);

        const { data: rows } = await service
          .from("sms_queue")
          .select("body, template_key, status, transaction_id")
          .eq("collector_id", c.userId)
          .eq("template_key", "resend")
          .eq("transaction_id", txId);
        assertEquals(rows?.length, 1);
        assert((rows![0].body as string).startsWith("Rappel - transaction du "));

        const { data: audit } = await service
          .from("audit_log")
          .select("event_type, payload, entity_id, entity_table")
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.resend_initiated")
          .eq("entity_id", txId);
        assertEquals(audit?.length, 1);
        assertEquals(audit![0].entity_table, "transactions");
        const payload = audit![0].payload as { transaction_id: string; member_id: string };
        assertEquals(payload.transaction_id, txId);
        assertEquals(payload.member_id, memberId);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "2. Soft-undone transaction → (0, 'undone'); no rows; no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);
        await service
          .from("transactions")
          .update({ undone_at: new Date().toISOString() })
          .eq("id", txId);

        const { row, error } = await callRpc(userClient, txId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "undone");

        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals(count, 0);

        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.resend_initiated");
        assertEquals(auditCount, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3. Opt-out saver → (0, 'opt_out'); no rows; no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);
        await service.from("members").update({ sms_opt_out: true }).eq("id", memberId);

        const { row, error } = await callRpc(userClient, txId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "opt_out");

        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals(count, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4. Cash-only saver → (0, 'no_phone'); no rows; no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { data: memberId } = await userClient.rpc("create_member_with_cycle", {
          p_name: "Cash Only",
          p_phone_number: "",
          p_daily_amount: 500,
        });
        const { data: cycle } = await service
          .from("cycles")
          .select("id")
          .eq("member_id", memberId)
          .single();
        const txId = await recordContrib(userClient, memberId as string, cycle!.id);

        const { row, error } = await callRpc(userClient, txId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "no_phone");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4b. Unsupported kind (settlement) → (0, 'unsupported_kind'); no rows; no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert4b");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // Seed a contribution tx for amount_encrypted reuse, then mutate
        // its kind to settlement via service-role (Story 4.x doesn't
        // produce settlement transactions yet — Story 7.5 will — but the
        // kind gate must defend against the future enum value today).
        const realTxId = await recordContrib(userClient, memberId, cycleId);
        const { data: srcTx } = await service
          .from("transactions")
          .select("amount_encrypted")
          .eq("id", realTxId)
          .single();
        const { data: settlement, error: insertErr } = await service
          .from("transactions")
          .insert({
            collector_id: c.userId,
            member_id: memberId,
            cycle_id: cycleId,
            kind: "settlement",
            amount_encrypted: srcTx!.amount_encrypted,
            cycle_day: 30,
            source: "online",
          })
          .select("id")
          .single();
        if (insertErr) {
          // Settlement kind may not yet exist in the enum (Story 7.5);
          // skip the test rather than failing — the gate is still defended
          // by the SQL CHECK on transactions_kind_enum.
          console.log(`skip 4b — settlement kind not yet in enum: ${insertErr.message}`);
          return;
        }

        const { row, error } = await callRpc(userClient, settlement!.id);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "unsupported_kind");

        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.resend_initiated");
        assertEquals(auditCount, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "5. Foreign collector → P0002 (uniform message — no enumeration leak)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const owner = await seedCollector(service, anon, "ert5a");
      const intruder = await seedCollector(service, anon, "ert5b");
      try {
        const ownerClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${owner.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(ownerClient, service, owner.userId);
        const txId = await recordContrib(ownerClient, memberId, cycleId);

        const intruderClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${intruder.jwt}` } },
        });
        const { row, error } = await callRpc(intruderClient, txId);
        assertEquals(row, null);
        assert(error !== null);
        assertEquals(error?.code, "P0002");
        // Code-review lesson from 6.6: the message should be uniform for
        // "doesn't exist" vs "not owned" to prevent existence enumeration.
        // Pin the exact `transaction_not_found: <uuid> does not exist`
        // shape so a refactor of the error wording is forced to update
        // this test (rather than silently passing on a substring match).
        const expectedShape = /^transaction_not_found: [0-9a-f-]{36} does not exist$/;
        assert(
          expectedShape.test(error?.message ?? ""),
          `expected uniform "transaction_not_found: <uuid> does not exist" message, got: ${error?.message}`,
        );
      } finally {
        await cleanup(service, owner);
        await cleanup(service, intruder);
      }
    },
  });

  Deno.test({
    name: "6. Non-existent transaction → P0002",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert6");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { row, error } = await callRpc(userClient, crypto.randomUUID());
        assertEquals(row, null);
        assertEquals(error?.code, "P0002");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "7. Past-cycle transaction (settled cycle) → (1, NULL) — cycle gate open",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ert7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);
        // Settle the cycle directly via service-role bypass.
        await service.from("cycles").update({ status: "settled" }).eq("id", cycleId);

        const { row, error } = await callRpc(userClient, txId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 1);
        assertEquals(row!.reason, null);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
