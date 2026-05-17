// Story 6.5 — set_member_sms_opt_out RPC contract tests.
//
// Asserts:
//   1. Happy path: flips sms_opt_out + observability cols + emits 1 audit.
//   2. Idempotency: second call is a no-op (only 1 audit event total).
//   3. Cancels in-flight queued sms_queue rows for the member.
//   4. Already-sent / failed / abandoned rows are NOT touched.
//   5. Invalid p_via → 22000.
//   6. Unknown p_member_id → P0002.

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
  name: "set_member_sms_opt_out (6.5) — skip when env not set",
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
    name: "1. happy path → sms_opt_out=true, sms_opt_out_at populated, 1 audit event",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error } = await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "stop_keyword",
        });
        assertEquals(error, null);

        const { data: row } = await service
          .from("members")
          .select("sms_opt_out, sms_opt_out_at, sms_opt_out_via")
          .eq("id", memberId)
          .single();
        assertEquals(row?.sms_opt_out, true);
        assertEquals(row?.sms_opt_out_via, "stop_keyword");
        assert(row?.sms_opt_out_at !== null);

        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.opt_out");
        assertEquals(auditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "2. idempotency — second call is no-op (1 audit total)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(userClient, service, c.userId);

        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "stop_keyword",
        });
        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "receipt_url",
        });

        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.opt_out");
        assertEquals(auditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3. cancels in-flight queued sms_queue rows for this member",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo3");
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
        // Trigger inserted a queued row.
        const { data: rowBefore } = await service
          .from("sms_queue")
          .select("status")
          .eq("transaction_id", txId)
          .single();
        assertEquals(rowBefore?.status, "queued");

        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "stop_keyword",
        });

        const { data: rowAfter } = await service
          .from("sms_queue")
          .select("status, abandoned_at")
          .eq("transaction_id", txId)
          .single();
        assertEquals(rowAfter?.status, "abandoned");
        assert(rowAfter?.abandoned_at !== null);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4. already-sent rows are NOT touched (only status='queued' flips)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo4");
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

        // Pretend the worker already sent the message.
        await service.from("sms_queue").update({ status: "sent" }).eq("transaction_id", txId);

        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "stop_keyword",
        });

        const { data: row } = await service
          .from("sms_queue")
          .select("status")
          .eq("transaction_id", txId)
          .single();
        // Still 'sent' — opt-out doesn't rewrite history.
        assertEquals(row?.status, "sent");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "5. invalid p_via → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error } = await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "facebook",
        });
        assert(error !== null);
        assertEquals(error?.code, "22000");
        assertStringIncludes(error?.message ?? "", "invalid_via");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "6. unknown p_member_id → P0002",
    ...denoOpts,
    fn: async () => {
      const { error } = await service.rpc("set_member_sms_opt_out", {
        p_member_id: "00000000-0000-0000-0000-000000000000",
        p_via: "stop_keyword",
      });
      assert(error !== null);
      assertEquals(error?.code, "P0002");
    },
  });

  // Story 10.5 — the final confirmation SMS.
  Deno.test({
    name: "7. receipt_url opt-out enqueues exactly one opt_out_confirmation SMS (idempotent)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(userClient, service, c.userId);

        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "receipt_url",
        });

        const { data: rows } = await service
          .from("sms_queue")
          .select("status, body, transaction_id, recipient_phone")
          .eq("collector_id", c.userId)
          .eq("template_key", "opt_out_confirmation");
        assertEquals((rows ?? []).length, 1);
        assertEquals(rows![0]!.status, "queued");
        assertEquals(rows![0]!.transaction_id, null);
        // seedMemberWithCycle seeds the member with this phone.
        assertEquals(rows![0]!.recipient_phone, "+221770000666");
        assertStringIncludes(rows![0]!.body as string, "SafariCash");

        // Idempotent — a second receipt_url call enqueues nothing further.
        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "receipt_url",
        });
        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "opt_out_confirmation");
        assertEquals(count, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "8. stop_keyword opt-out enqueues NO opt_out_confirmation SMS",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "oo8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId } = await seedMemberWithCycle(userClient, service, c.userId);

        await service.rpc("set_member_sms_opt_out", {
          p_member_id: memberId,
          p_via: "stop_keyword",
        });

        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "opt_out_confirmation");
        assertEquals(count, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
