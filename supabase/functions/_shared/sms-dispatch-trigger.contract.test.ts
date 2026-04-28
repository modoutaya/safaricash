// Story 6.1 — enqueue_sms_on_transaction trigger contract tests.
//
// Asserts:
//   1. First commit for a member with phone → sms_queue row with
//      template_key='first_receipt', retry_count=0, next_retry_at NULL,
//      abandoned_at NULL.
//   2. Second commit for same member → template_key='subsequent_receipt'.
//   3. Member without phone → no sms_queue row.
//   4. CHECK constraint — direct UPDATE template_key to invalid value
//      → sqlstate 23514.
//   5. CHECK constraint — direct INSERT retry_count = -1 → 23514.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

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
  name: "sms-dispatch trigger (6.1) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "first commit → template_key='first_receipt' + retry_count=0 + next_retry_at NULL",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "tk1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: txId, error: rpcErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assertEquals(rpcErr, null);

        const { data: row } = await service
          .from("sms_queue")
          .select("template_key, retry_count, next_retry_at, abandoned_at, status, body")
          .eq("transaction_id", txId)
          .single();

        assertEquals(row?.template_key, "first_receipt");
        assertEquals(row?.retry_count, 0);
        assertEquals(row?.next_retry_at, null);
        assertEquals(row?.abandoned_at, null);
        assertEquals(row?.status, "queued");
        // Story 6.3 — body is now the rendered template (no longer the
        // STUB literal '[STUB] Transaction enregistrée').
        assertStringIncludes(row?.body ?? "", "SafariCash");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "second commit for same member → template_key='subsequent_receipt'",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "tk2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        // First commit.
        await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });

        // Second commit.
        const { data: tx2Id } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 2,
        });

        const { data: row2 } = await service
          .from("sms_queue")
          .select("template_key")
          .eq("transaction_id", tx2Id)
          .single();
        assertEquals(row2?.template_key, "subsequent_receipt");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "member without phone → no sms_queue row",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "tk3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId, "");

        const { data: txId } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });

        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(count, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "CHECK constraint — direct UPDATE template_key='invalid' → 23514",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "tk4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { data: txId } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });

        const { error: updateErr } = await service
          .from("sms_queue")
          .update({ template_key: "invalid_template" })
          .eq("transaction_id", txId);
        assert(updateErr !== null);
        assertEquals(updateErr?.code, "23514");
        assertStringIncludes(updateErr?.message ?? "", "sms_queue_template_key_chk");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "CHECK constraint — retry_count = -1 → 23514",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "tk5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { data: txId } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });

        const { error: updateErr } = await service
          .from("sms_queue")
          .update({ retry_count: -1 })
          .eq("transaction_id", txId);
        assert(updateErr !== null);
        assertEquals(updateErr?.code, "23514");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
