// Story 6.6 — enqueue_resend_history RPC contract tests.
//
// Covers:
//   1. Happy path — 3 contributions → 3 sms_queue rows + ONE sms.resend_initiated audit event.
//   2. Soft-undo filter — 3 contributions, 1 undone → 2 rows enqueued.
//   3. Opt-out short-circuit — (0, 'opt_out'), no rows, no audit.
//   4. Cash-only saver (no phone) — (0, 'no_phone'), no rows, no audit.
//   5. Foreign collector — P0002.
//   6. Cycle not owned by member — P0002.
//   7. Empty cycle — (0, 'no_transactions'), no audit.

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
  name: "enqueue_resend_history (6.6) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

async function recordContrib(
  userClient: SupabaseClient,
  memberId: string,
  cycleId: string,
  cycleDay: number,
  amount = 500,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: amount,
    p_cycle_day: cycleDay,
  });
  if (error || !txId) throw new Error(`record_contribution: ${error?.message}`);
  return txId as string;
}

type ResendRow = { enqueued: number; reason: string | null };

async function callRpc(
  client: SupabaseClient,
  memberId: string,
  cycleId: string,
): Promise<{ row: ResendRow | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await client.rpc("enqueue_resend_history", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
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
    name: "1. Happy path — 3 contributions → 3 rows + 1 audit event",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "erh1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await recordContrib(userClient, memberId, cycleId, 1);
        await recordContrib(userClient, memberId, cycleId, 2);
        await recordContrib(userClient, memberId, cycleId, 3);

        // Baseline sms_queue count for this collector — fresh transactions
        // also enqueue receipt rows via the trigger. We assert on the
        // DELTA introduced by enqueue_resend_history.
        const { count: beforeCount } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");

        const { row, error } = await callRpc(userClient, memberId, cycleId);
        assertEquals(error, null);
        assert(row !== null);
        assertEquals(row!.enqueued, 3);
        assertEquals(row!.reason, null);

        const { count: afterCount } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals((afterCount ?? 0) - (beforeCount ?? 0), 3);

        // All bodies start with the "Rappel" prefix.
        const { data: resendRows } = await service
          .from("sms_queue")
          .select("body, template_key, status")
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals(resendRows?.length, 3);
        for (const r of resendRows ?? []) {
          assert(
            (r.body as string).startsWith("Rappel - transaction du "),
            `body should start with "Rappel - transaction du ", got: ${r.body}`,
          );
          assertEquals(r.template_key, "resend");
          assertEquals(r.status, "queued");
        }

        // Exactly ONE sms.resend_initiated audit event.
        const { data: auditRows } = await service
          .from("audit_log")
          .select("event_type, payload, entity_id, entity_table")
          .eq("collector_id", c.userId)
          .eq("event_type", "sms.resend_initiated");
        assertEquals(auditRows?.length, 1);
        const audit = auditRows![0];
        assertEquals(audit.entity_id, memberId);
        assertEquals(audit.entity_table, "members");
        const payload = audit.payload as { member_id: string; cycle_id: string; count: number };
        assertEquals(payload.member_id, memberId);
        assertEquals(payload.cycle_id, cycleId);
        assertEquals(payload.count, 3);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "2. Soft-undo filter — undone transaction NOT resent",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "erh2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const t1 = await recordContrib(userClient, memberId, cycleId, 1);
        await recordContrib(userClient, memberId, cycleId, 2);
        await recordContrib(userClient, memberId, cycleId, 3);

        // Mark t1 as undone (Story 4.5 — set undone_at directly via service).
        await service
          .from("transactions")
          .update({ undone_at: new Date().toISOString() })
          .eq("id", t1);

        const { row, error } = await callRpc(userClient, memberId, cycleId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 2);
        assertEquals(row!.reason, null);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3. Opt-out short-circuit — (0, 'opt_out') no rows no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "erh3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await recordContrib(userClient, memberId, cycleId, 1);

        // Flip opt-out flag directly via service-role.
        await service.from("members").update({ sms_opt_out: true }).eq("id", memberId);

        const { row, error } = await callRpc(userClient, memberId, cycleId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "opt_out");

        // No 'resend' sms_queue rows.
        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("collector_id", c.userId)
          .eq("template_key", "resend");
        assertEquals(count, 0);

        // No sms.resend_initiated audit event.
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
    name: "4. Cash-only saver (no phone) — (0, 'no_phone') no rows no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "erh4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // Seed member with EMPTY phone.
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
        await recordContrib(userClient, memberId as string, cycle!.id, 1);

        const { row, error } = await callRpc(userClient, memberId as string, cycle!.id);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "no_phone");

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
    name: "5. Foreign collector — P0002",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const owner = await seedCollector(service, anon, "erh5a");
      const intruder = await seedCollector(service, anon, "erh5b");
      try {
        const ownerClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${owner.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(ownerClient, service, owner.userId);

        // Intruder tries to call enqueue_resend_history with owner's member_id.
        const intruderClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${intruder.jwt}` } },
        });
        const { row, error } = await callRpc(intruderClient, memberId, cycleId);
        assertEquals(row, null);
        assert(error !== null);
        assertEquals(error?.code, "P0002");
      } finally {
        await cleanup(service, owner);
        await cleanup(service, intruder);
      }
    },
  });

  Deno.test({
    name: "6. Cycle not owned by member — P0002",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "erh6");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const a = await seedMemberWithCycle(userClient, service, c.userId, "+221770000222");
        const b = await seedMemberWithCycle(userClient, service, c.userId, "+221770000333");

        // Call with member A's id but cycle B's id.
        const { row, error } = await callRpc(userClient, a.memberId, b.cycleId);
        assertEquals(row, null);
        assert(error !== null);
        assertEquals(error?.code, "P0002");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "7. Empty cycle — (0, 'no_transactions') no audit",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "erh7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // No transactions recorded.

        const { row, error } = await callRpc(userClient, memberId, cycleId);
        assertEquals(error, null);
        assertEquals(row!.enqueued, 0);
        assertEquals(row!.reason, "no_transactions");

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
}
