// Story 10.2 — enqueue_dispute_ack RPC contract test.
//
// Asserts the SECURITY DEFINER RPC that the dispute-notify Edge Function
// calls to enqueue the saver's dispute-acknowledgment SMS:
//   - happy path → (1, NULL) + a queued dispute_ack sms_queue row
//   - unknown transaction → (0, 'not_found'), no row
//
// Run: ./scripts/run-edge-tests.sh

import { assert, assertEquals } from "jsr:@std/assert@1";
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
const denoOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: "enqueue_dispute_ack — skip when env not set",
  ignore: !!env,
  fn: () => console.log("Skip — Supabase env not set."),
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  Deno.test({
    name: "enqueue_dispute_ack — happy path: (1, NULL) + a queued dispute_ack row",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "eda-happy");
      const userClient = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${c.jwt}` } },
      });
      try {
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { data: txId, error: txErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assertEquals(txErr, null);

        const { data, error } = await service.rpc("enqueue_dispute_ack", {
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        const row = (Array.isArray(data) ? data[0] : data) as {
          enqueued: number;
          reason: string | null;
        };
        assertEquals(row.enqueued, 1);
        assertEquals(row.reason, null);

        const { data: queued } = await service
          .from("sms_queue")
          .select("template_key, status, body, recipient_phone")
          .eq("transaction_id", txId)
          .eq("template_key", "dispute_ack");
        assertEquals((queued ?? []).length, 1);
        assertEquals(queued![0]!.status, "queued");
        assert((queued![0]!.body as string).includes("signalement"));
        assert((queued![0]!.recipient_phone as string).length > 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "enqueue_dispute_ack — ignores members.sms_opt_out (transactional ack)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "eda-optout");
      const userClient = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${c.jwt}` } },
      });
      try {
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // Opt the saver out — the dispute_ack ack must STILL enqueue.
        const { error: optErr } = await service
          .from("members")
          .update({ sms_opt_out: true })
          .eq("id", memberId);
        assertEquals(optErr, null);
        const { data: txId } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });

        const { data, error } = await service.rpc("enqueue_dispute_ack", {
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        const row = (Array.isArray(data) ? data[0] : data) as {
          enqueued: number;
          reason: string | null;
        };
        assertEquals(row.enqueued, 1);
        assertEquals(row.reason, null);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "enqueue_dispute_ack — unknown transaction → (0, 'not_found')",
    ...denoOpts,
    fn: async () => {
      const { data, error } = await service.rpc("enqueue_dispute_ack", {
        p_transaction_id: crypto.randomUUID(),
      });
      assertEquals(error, null);
      const row = (Array.isArray(data) ? data[0] : data) as {
        enqueued: number;
        reason: string | null;
      };
      assertEquals(row.enqueued, 0);
      assertEquals(row.reason, "not_found");
    },
  });
}
