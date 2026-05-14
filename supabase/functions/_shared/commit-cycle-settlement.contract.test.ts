// Story 7.4 — commit_cycle_settlement RPC contract tests.
//
// Covers:
//   1. Happy path — completed cycle with 2 contributions + 1 advance →
//      settled_payout = 500 × 29 − 3000 = 11500 + cycle status='settled' +
//      audit cycle.settled emitted + sms_queue settlement row + transactions
//      row with kind='settlement'.
//   2. Idempotent re-call — second commit on now-settled cycle → P0002
//      "cycle not in completed status".
//   3. Cycle not completed — status='active' → P0002 "cycle not in completed status".
//   4. Payout mismatch — wrong p_expected_payout → P0002 "payout mismatch".
//   5. Not owner — collector A tries collector B's cycle → P0002 "cycle not
//      found or not owned" via the FOR UPDATE returning no row under RLS.
//   6. Member/cycle mismatch — wrong p_member_id for the cycle → P0002.
//   7. Soft-undo advance — undone advance not counted in payout.
//   8. SMS enqueue side-effect — assert settlement template row.
//
// Note: auth.uid() null path is exercised indirectly via the "not owner"
// case — the JWT-bound client always has auth.uid() set; a service client
// would call with auth.uid()=null but RLS isn't the gate here, the explicit
// SELECT FOR UPDATE + ownership check is.

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
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
  name: "commit_cycle_settlement (7.4) — skip when env not set",
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

async function recordAdvance(
  userClient: SupabaseClient,
  memberId: string,
  cycleId: string,
  cycleDay: number,
  amount: number,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_advance", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: amount,
    p_cycle_day: cycleDay,
    p_motive: "Test advance for settlement",
    p_saver_acknowledged: true,
  });
  if (error || !txId) throw new Error(`record_advance: ${error?.message}`);
  return txId as string;
}

async function markCycleCompleted(service: SupabaseClient, cycleId: string): Promise<void> {
  // Bypass the cycle-status trigger via direct service-role UPDATE.
  const { error } = await service.from("cycles").update({ status: "completed" }).eq("id", cycleId);
  if (error) throw new Error(`markCycleCompleted: ${error.message}`);
}

type RpcRow = {
  settlement_transaction_id: string;
  settled_payout: number | string;
  settled_at: string;
};

async function callRpc(
  client: SupabaseClient,
  memberId: string,
  cycleId: string,
  expectedPayout: number,
): Promise<{ row: RpcRow | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await client.rpc("commit_cycle_settlement", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_expected_payout: expectedPayout,
  });
  if (error) return { row: null, error: error as { code?: string; message: string } };
  const row: RpcRow = Array.isArray(data) ? (data[0] as RpcRow) : (data as RpcRow);
  return { row, error: null };
}

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "1. Happy path — completed cycle → settled + audit + SMS + transaction",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await recordContrib(userClient, memberId, cycleId, 1, 500);
        await recordContrib(userClient, memberId, cycleId, 2, 500);
        await recordAdvance(userClient, memberId, cycleId, 3, 3000);

        // Mark cycle completed so it's settleable.
        await markCycleCompleted(service, cycleId);

        // Expected: 500 × 29 − 3000 = 11500.
        const { row, error } = await callRpc(userClient, memberId, cycleId, 11500);
        assertEquals(error, null);
        assertExists(row);
        assertEquals(Number(row!.settled_payout), 11500);
        assert(typeof row!.settlement_transaction_id === "string");
        assert(row!.settled_at.length > 0);

        // Cycle is now settled.
        const { data: cycleRow } = await service
          .from("cycles")
          .select("status, settled_at")
          .eq("id", cycleId)
          .single();
        assertEquals(cycleRow?.status, "settled");
        assertExists(cycleRow?.settled_at);

        // Audit emitted cycle.settled.
        const { data: auditRows } = await service
          .from("audit_log")
          .select("event_type")
          .eq("collector_id", c.userId)
          .eq("event_type", "cycle.settled");
        assertEquals(auditRows?.length, 1);

        // sms_queue has one row with template_key='settlement' for this cycle.
        const { data: smsRows } = await service
          .from("sms_queue")
          .select("template_key, body, transaction_id, status")
          .eq("collector_id", c.userId)
          .eq("template_key", "settlement");
        assertEquals(smsRows?.length, 1);
        // Story 7.5 — template content updated. Match the new shape: firstName
        // + DD/MM cycle range. (Pre-Story-7.5 body started with 'Cycle clos.';
        // Story 7.5 moved that and added firstName + period.)
        const body = smsRows![0].body as string;
        assert(
          body.startsWith("SafariCash. "),
          `body must start with 'SafariCash. ', got: ${body}`,
        );
        assert(
          /votre cycle du \d{2}\/\d{2} au \d{2}\/\d{2} est clos\./.test(body),
          `body must contain the DD/MM cycle range, got: ${body}`,
        );
        assertEquals(smsRows![0].status, "queued");

        // transactions has one row with kind='settlement' for this cycle.
        const { data: settlementTxs } = await service
          .from("transactions")
          .select("id, kind, cycle_day")
          .eq("cycle_id", cycleId)
          .eq("kind", "settlement");
        assertEquals(settlementTxs?.length, 1);
        assertEquals(settlementTxs![0].id, row!.settlement_transaction_id);
        assertEquals(settlementTxs![0].cycle_day, 30);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "2. Idempotent — second commit on settled cycle → P0002 cycle not in completed",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await markCycleCompleted(service, cycleId);

        // First commit — expected payout = 500 × 29 = 14500 (no advances).
        const first = await callRpc(userClient, memberId, cycleId, 14500);
        assertEquals(first.error, null);

        // Second commit on the now-settled cycle.
        const second = await callRpc(userClient, memberId, cycleId, 14500);
        assertExists(second.error);
        assertEquals(second.error!.code, "P0002");
        assert(second.error!.message.includes("cycle not in completed status"));
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3. Cycle not completed (status=active) → P0002 cycle not in completed",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // Cycle defaults to 'active' (no markCycleCompleted call).

        const { row, error } = await callRpc(userClient, memberId, cycleId, 14500);
        assertEquals(row, null);
        assertExists(error);
        assertEquals(error!.code, "P0002");
        assert(error!.message.includes("cycle not in completed status"));
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4. Payout mismatch — wrong expected_payout → P0002 payout mismatch",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await markCycleCompleted(service, cycleId);

        // Real payout = 14500; pass 99999 instead.
        const { row, error } = await callRpc(userClient, memberId, cycleId, 99999);
        assertEquals(row, null);
        assertExists(error);
        assertEquals(error!.code, "P0002");
        assert(error!.message.includes("payout mismatch"));
        // Detail should mention both numbers.
        assert(error!.message.includes("99999"));
        assert(error!.message.includes("14500"));
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "5. Not owner — collector B's cycle, collector A calls → P0002 not found",
    ...denoOpts,
    fn: async () => {
      const anonA = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anonB = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const cA = await seedCollector(service, anonA, "ccs5a");
      const cB = await seedCollector(service, anonB, "ccs5b");
      try {
        const userB = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${cB.jwt}` } },
        });
        // Seed B's cycle, mark completed.
        const { memberId, cycleId } = await seedMemberWithCycle(userB, service, cB.userId);
        await markCycleCompleted(service, cycleId);

        // A tries to settle B's cycle.
        const userA = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${cA.jwt}` } },
        });
        const { row, error } = await callRpc(userA, memberId, cycleId, 14500);
        assertEquals(row, null);
        assertExists(error);
        // Either P0002 (RLS gives no row → "not found") OR RLS rejects upstream.
        // Both are acceptable; the message should mention "not found or not owned".
        assert(error!.message.includes("cycle not found or not owned") || error!.code === "P0002");
      } finally {
        await cleanup(service, cA);
        await cleanup(service, cB);
      }
    },
  });

  Deno.test({
    name: "6. Member/cycle mismatch — wrong member_id → P0002 cycle/member mismatch",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs6");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId: _memberId, cycleId } = await seedMemberWithCycle(
          userClient,
          service,
          c.userId,
        );
        const other = await seedMemberWithCycle(userClient, service, c.userId, "+221770000777");
        await markCycleCompleted(service, cycleId);

        // Call with cycleId from member A but pass other.memberId.
        const { row, error } = await callRpc(userClient, other.memberId, cycleId, 14500);
        assertEquals(row, null);
        assertExists(error);
        assertEquals(error!.code, "P0002");
        assert(error!.message.includes("cycle/member mismatch"));
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "7. Soft-undo advance NOT counted in payout",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const advA = await recordAdvance(userClient, memberId, cycleId, 1, 2000);
        await recordAdvance(userClient, memberId, cycleId, 2, 1000);

        // Soft-undo advA (2000). Real advances sum = 1000. Payout = 14500 − 1000 = 13500.
        await service
          .from("transactions")
          .update({ undone_at: new Date().toISOString() })
          .eq("id", advA);

        await markCycleCompleted(service, cycleId);

        const { row, error } = await callRpc(userClient, memberId, cycleId, 13500);
        assertEquals(error, null);
        assertExists(row);
        assertEquals(Number(row!.settled_payout), 13500);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "8. SMS enqueue side-effect — settlement row body matches template",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await markCycleCompleted(service, cycleId);

        const { row, error } = await callRpc(userClient, memberId, cycleId, 14500);
        assertEquals(error, null);
        assertExists(row);

        const { data: smsRows } = await service
          .from("sms_queue")
          .select("template_key, body")
          .eq("transaction_id", row!.settlement_transaction_id);
        assertEquals(smsRows?.length, 1);
        assertEquals(smsRows![0].template_key, "settlement");
        // Story 7.5 template:
        //   'SafariCash. {firstName}, votre cycle du {DD/MM} au {DD/MM} est
        //    clos. Vous avez recu X FCFA. Detail: <url>.'
        assert((smsRows![0].body as string).includes("Vous avez recu"));
        assert((smsRows![0].body as string).includes("FCFA"));
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "9. No JWT — auth.uid() null → errcode 28000 auth required",
    ...denoOpts,
    fn: async () => {
      // Code-review patch #5 — verify the RPC's auth.uid() null guard
      // directly. In production this path is defensively unreachable
      // because the Edge Function's assertAuthenticated blocks JWT-less
      // requests upstream; this test pins the RPC contract independently.
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ccs9");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await markCycleCompleted(service, cycleId);

        // Call via the SERVICE client — auth.uid() is null outside a session,
        // so the RPC's first guard raises 'auth required' (errcode 28000).
        const { data, error } = await service.rpc("commit_cycle_settlement", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_expected_payout: 14500,
        });
        assertEquals(data, null);
        assertExists(error);
        assertEquals((error as { code?: string }).code, "28000");
        assert((error as { message: string }).message.includes("auth required"));
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
