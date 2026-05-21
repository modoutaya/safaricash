// Story 12.3 Phase B — contract tests for the
// `public.restart_active_cycles_for_month(p_today date)` RPC.
//
// Verifies the batch restart behaviour scheduled by the pg_cron job:
//   - Only `members.status='active'` participate (Q4 — paused/deleted skipped).
//   - Previous 'active' / 'with_advance' cycles flip to 'completed';
//     'completed' / 'settled' stay as-is.
//   - New cycle gets cycle_number = prev + 1, start_date = p_today,
//     end_date from derive_cycle_bounds (cap-30 Story 11.5).
//   - Idempotent: a second invocation on the same date is a no-op.
//
// Skips when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { seedCollector, type PhoneCollector } from "./test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "restart_active_cycles_for_month (12.3 Phase B) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("SUPABASE_URL / *_ANON_KEY / *_SERVICE_ROLE_KEY not set — skipping.");
  },
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  type CycleStatus = "active" | "with_advance" | "completed" | "settled";

  /** Seed a member + their cycle 1 with a target status. The cycle is
   *  always inserted as 'active' first, then flipped — the Story 3.4
   *  trigger only guards transaction INSERTs, not cycle UPDATEs (the
   *  same pattern as compute-opening-balance.contract.test.ts). */
  const seedMemberWithStatus = async (
    collector: PhoneCollector,
    memberStatus: "active" | "paused",
    cycleStatus: CycleStatus,
  ): Promise<{ memberId: string; cycleId: string }> => {
    const { data: nameSecret } = await service.rpc("vault_encrypt", {
      plaintext: `Member ${crypto.randomUUID()}`,
    });
    const { data: phoneSecret } = await service.rpc("vault_encrypt", {
      plaintext: "+221770000000",
    });
    const { data: member, error: memberErr } = await service
      .from("members")
      .insert({
        collector_id: collector.userId,
        name_encrypted: nameSecret,
        phone_number_encrypted: phoneSecret,
        daily_amount: 500,
        status: memberStatus,
      })
      .select("id")
      .single();
    if (memberErr || !member) throw new Error(`seedMember: ${memberErr?.message}`);

    const { data: cycle, error: cycleErr } = await service
      .from("cycles")
      .insert({
        member_id: member.id,
        collector_id: collector.userId,
        cycle_number: 1,
        start_date: "2026-05-01",
        end_date: "2026-05-30",
        status: "active",
      })
      .select("id")
      .single();
    if (cycleErr || !cycle) throw new Error(`seedCycle: ${cycleErr?.message}`);

    if (cycleStatus !== "active") {
      const { error: updateErr } = await service
        .from("cycles")
        .update({ status: cycleStatus })
        .eq("id", cycle.id);
      if (updateErr) throw new Error(`seedCycle status flip: ${updateErr.message}`);
    }

    return { memberId: member.id, cycleId: cycle.id };
  };

  const cleanup = async (collector: PhoneCollector): Promise<void> => {
    await service.from("transactions").delete().eq("collector_id", collector.userId);
    await service.from("cycles").delete().eq("collector_id", collector.userId);
    await service.from("members").delete().eq("collector_id", collector.userId);
    await service.auth.admin.deleteUser(collector.userId);
  };

  type RpcResult = {
    members_processed: number;
    cycles_restarted: number;
    cycles_skipped: number;
  };

  const callRpc = async (today: string): Promise<RpcResult> => {
    const { data, error } = await service.rpc("restart_active_cycles_for_month", {
      p_today: today,
    });
    if (error) throw new Error(`RPC: ${error.message}`);
    return Array.isArray(data) ? (data[0] as RpcResult) : (data as RpcResult);
  };

  // Note on counters: the RPC iterates members globally (service-role
  // bypasses RLS). If other test files left active members in the shared
  // DB, the counters reflect them. The assertions below check our
  // seeded members' EFFECTS specifically (per-collector cycle counts +
  // status transitions) rather than the global counters.

  Deno.test({
    name: "12.3 Phase B #1 — happy path: 4 active (mixed statuses) + 1 paused → 4 restarted, paused untouched",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "rac1");
      try {
        const a = await seedMemberWithStatus(c, "active", "active");
        const b = await seedMemberWithStatus(c, "active", "with_advance");
        const cMember = await seedMemberWithStatus(c, "active", "completed");
        const d = await seedMemberWithStatus(c, "active", "settled");
        const e = await seedMemberWithStatus(c, "paused", "active");

        const result = await callRpc("2026-06-01");

        // Lower-bound on the global counters — we seeded 4 active members
        // + 1 paused under THIS collector. Other tests' residue may
        // inflate the totals, but the restart logic must process AT
        // LEAST our 4.
        assert(result.members_processed >= 4, `members_processed=${result.members_processed}`);
        assert(result.cycles_restarted >= 4, `cycles_restarted=${result.cycles_restarted}`);

        // Previous cycles: 'active' and 'with_advance' flip to 'completed';
        // 'completed' / 'settled' stay as-is.
        const checkPrev = async (cycleId: string, expected: CycleStatus) => {
          const { data } = await service.from("cycles").select("status").eq("id", cycleId).single();
          assertEquals(data?.status, expected);
        };
        await checkPrev(a.cycleId, "completed");
        await checkPrev(b.cycleId, "completed");
        await checkPrev(cMember.cycleId, "completed");
        await checkPrev(d.cycleId, "settled");
        // Paused member's cycle untouched (status='active' is the seed state).
        await checkPrev(e.cycleId, "active");

        // New cycle exists for each active member with start_date=2026-06-01,
        // cycle_number=2, status='active'. End derived via derive_cycle_bounds:
        // June 1 → June 30 (length 30, cap-30 inert for June).
        const checkNew = async (memberId: string) => {
          const { data } = await service
            .from("cycles")
            .select("cycle_number, start_date, end_date, status")
            .eq("member_id", memberId)
            .eq("cycle_number", 2)
            .single();
          assert(data !== null, "new cycle missing");
          assertEquals(data!.start_date, "2026-06-01");
          assertEquals(data!.end_date, "2026-06-30");
          assertEquals(data!.status, "active");
        };
        await checkNew(a.memberId);
        await checkNew(b.memberId);
        await checkNew(cMember.memberId);
        await checkNew(d.memberId);

        // Paused member has NO cycle 2.
        const { data: pausedCycles } = await service
          .from("cycles")
          .select("cycle_number")
          .eq("member_id", e.memberId);
        assertEquals(pausedCycles?.length, 1, "paused member must have only the original cycle");
      } finally {
        await cleanup(c);
      }
    },
  });

  Deno.test({
    name: "12.3 Phase B #2 — idempotent: 2nd call same day → no duplicate cycle for our members",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "rac2");
      try {
        const a = await seedMemberWithStatus(c, "active", "active");
        const b = await seedMemberWithStatus(c, "active", "completed");

        await callRpc("2026-06-01");
        await callRpc("2026-06-01");

        // Each active member of THIS collector has exactly 2 cycles
        // (the original seed + 1 new restart on 2026-06-01). No
        // triplication despite two cron invocations.
        const checkCount = async (memberId: string) => {
          const { data } = await service
            .from("cycles")
            .select("cycle_number")
            .eq("member_id", memberId);
          assertEquals(data?.length, 2, `member ${memberId} must have exactly 2 cycles`);
        };
        await checkCount(a.memberId);
        await checkCount(b.memberId);

        // The cycle on 2026-06-01 has cycle_number=2 (not 3 from a
        // duplicate insert).
        const { data: newCycles } = await service
          .from("cycles")
          .select("cycle_number, member_id")
          .eq("collector_id", c.userId)
          .eq("start_date", "2026-06-01");
        assertEquals(newCycles?.length, 2);
        for (const row of newCycles!) {
          assertEquals(row.cycle_number, 2);
        }
      } finally {
        await cleanup(c);
      }
    },
  });
}
