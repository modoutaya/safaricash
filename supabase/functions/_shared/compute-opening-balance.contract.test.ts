// Story 12.3 — contract test cross-checking the SQL
// `public.compute_opening_balance` against the TypeScript
// `computeOpeningBalance` (src/domain/cycle/cycleEngine.ts).
//
// The two are NFR-R3 critical mirrors — every RPC that derives the
// projected balance reads this helper, and the client TS engine must
// produce the same number for the settlement cross-check
// (commit_cycle_settlement payout mismatch fires otherwise).
//
// Skips when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are unset. Runs
// via `npm run test:edge`.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  computeOpeningBalance,
  type OpeningBalanceCycle,
} from "../../../src/domain/cycle/cycleEngine.ts";
import { seedCollector, type PhoneCollector } from "./test-fixtures.ts";

function envOrSkip(): {
  url: string;
  anonKey: string;
  serviceKey: string;
} | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "compute_opening_balance (12.3) — skip when Supabase env not set",
  ignore: !!env,
  fn: () => {
    console.log(
      "SUPABASE_URL / *_ANON_KEY / *_SERVICE_ROLE_KEY not set — skipping SQL↔TS cross-check.",
    );
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
  const DAILY = 500;

  // Seed helpers — direct vault_encrypt + insert. Bypasses the
  // create_member_with_cycle RPC because we need precise control over
  // cycle_number / start_date / end_date / status for each scenario.

  interface SeededMember {
    memberId: string;
    cycles: { id: string; cycleNumber: number; startDate: string; endDate: string }[];
  }

  // Story 12.5 PR D — every cycle now needs a contributedTotal because
  // compute_opening_balance derives the previous balance from
  // (contrib − daily − advances − opening). Legacy fixtures used
  // `daily × cycleLength = 15_000` implicitly; the default below
  // preserves the old assertions.
  const LEGACY_CONTRIB = 15_000;

  const seedMember = async (
    collector: PhoneCollector,
    cycles: ReadonlyArray<{
      cycleNumber: number;
      startDate: string;
      endDate: string;
      status: "active" | "with_advance" | "completed" | "settled";
      advancesTotal: number;
      contributedTotal?: number;
    }>,
  ): Promise<SeededMember> => {
    const { data: nameSecret, error: nameErr } = await service.rpc("vault_encrypt", {
      plaintext: `Member ${Date.now()}`,
    });
    if (nameErr || !nameSecret) throw new Error(`vault_encrypt(name): ${nameErr?.message}`);

    const { data: phoneSecret, error: phoneErr } = await service.rpc("vault_encrypt", {
      plaintext: "+221770000000",
    });
    if (phoneErr || !phoneSecret) throw new Error(`vault_encrypt(phone): ${phoneErr?.message}`);

    const { data: member, error: memberErr } = await service
      .from("members")
      .insert({
        collector_id: collector.userId,
        name_encrypted: nameSecret,
        phone_number_encrypted: phoneSecret,
        daily_amount: DAILY,
        status: "active",
      })
      .select("id")
      .single();
    if (memberErr || !member) throw new Error(`seedMember: ${memberErr?.message}`);

    const seededCycles: SeededMember["cycles"] = [];
    for (const spec of cycles) {
      // Step 1: insert the cycle as 'active'. Story 3.4 trigger
      // `reject_transaction_on_closed_cycle` rejects any INSERT into
      // transactions when the cycle is 'completed' / 'settled' — we MUST
      // seed advances first, THEN flip the status.
      const { data: cycle, error: cycleErr } = await service
        .from("cycles")
        .insert({
          member_id: member.id,
          collector_id: collector.userId,
          cycle_number: spec.cycleNumber,
          start_date: spec.startDate,
          end_date: spec.endDate,
          status: "active",
        })
        .select("id")
        .single();
      if (cycleErr || !cycle) throw new Error(`seedCycle: ${cycleErr?.message}`);
      seededCycles.push({
        id: cycle.id,
        cycleNumber: spec.cycleNumber,
        startDate: spec.startDate,
        endDate: spec.endDate,
      });

      // Step 2: insert the advance (allowed because cycle is still active).
      if (spec.advancesTotal > 0) {
        const { data: amountSecret, error: amtErr } = await service.rpc("vault_encrypt", {
          plaintext: String(spec.advancesTotal),
        });
        if (amtErr || !amountSecret) throw new Error(`vault_encrypt(amount): ${amtErr?.message}`);
        const { error: txErr } = await service.from("transactions").insert({
          collector_id: collector.userId,
          member_id: member.id,
          cycle_id: cycle.id,
          kind: "advance",
          amount_encrypted: amountSecret,
          cycle_day: 1,
          source: "online",
          motive: "seed-fixture",
          saver_acknowledged: true,
        });
        if (txErr) throw new Error(`seedAdvance: ${txErr.message}`);
      }

      // Story 12.5 PR D — also seed a single `contribution` transaction
      // for the cycle's contributedTotal. The opening_balance recursion
      // reads this. Default = LEGACY_CONTRIB (= daily × 30) so old
      // assertions keep working.
      const contribTotal = spec.contributedTotal ?? LEGACY_CONTRIB;
      if (contribTotal > 0) {
        const { data: cSecret, error: cErr } = await service.rpc("vault_encrypt", {
          plaintext: String(contribTotal),
        });
        if (cErr || !cSecret) throw new Error(`vault_encrypt(contrib): ${cErr?.message}`);
        const { error: cTxErr } = await service.from("transactions").insert({
          collector_id: collector.userId,
          member_id: member.id,
          cycle_id: cycle.id,
          kind: "contribution",
          amount_encrypted: cSecret,
          cycle_day: 2,
          source: "online",
        });
        if (cTxErr) throw new Error(`seedContrib: ${cTxErr.message}`);
      }

      // Step 3: flip the cycle to its target status. The trigger guards
      // INSERT on transactions, NOT UPDATE on cycles → safe to update now.
      if (spec.status !== "active") {
        const { error: updateErr } = await service
          .from("cycles")
          .update({ status: spec.status })
          .eq("id", cycle.id);
        if (updateErr) throw new Error(`seedCycle status flip: ${updateErr.message}`);
      }
    }
    return { memberId: member.id, cycles: seededCycles };
  };

  const cleanup = async (collector: PhoneCollector): Promise<void> => {
    await service.from("transactions").delete().eq("collector_id", collector.userId);
    await service.from("cycles").delete().eq("collector_id", collector.userId);
    await service.from("members").delete().eq("collector_id", collector.userId);
    await service.auth.admin.deleteUser(collector.userId);
  };

  /** Build the TS-side input view from the seeded cycles + their states. */
  const tsInputs = (
    seeded: SeededMember,
    statuses: ReadonlyArray<{ cycleNumber: number; status: OpeningBalanceCycle["status"] }>,
    advancesByCycleNumber: ReadonlyArray<{ cycleNumber: number; advances: number }>,
    contributedByCycleNumber?: ReadonlyArray<{ cycleNumber: number; contributed: number }>,
  ): {
    cycles: OpeningBalanceCycle[];
    advancesByCycleId: Map<string, number>;
    contributedByCycleId: Map<string, number>;
  } => {
    const cycles: OpeningBalanceCycle[] = seeded.cycles.map((c) => ({
      id: c.id,
      cycleNumber: c.cycleNumber,
      startDate: c.startDate,
      endDate: c.endDate,
      status: statuses.find((s) => s.cycleNumber === c.cycleNumber)?.status ?? "active",
    }));
    const advancesByCycleId = new Map<string, number>();
    for (const { cycleNumber, advances } of advancesByCycleNumber) {
      const cycle = seeded.cycles.find((c) => c.cycleNumber === cycleNumber);
      if (cycle) advancesByCycleId.set(cycle.id, advances);
    }
    // Story 12.5 PR D — mirror the SQL: every seeded cycle has the
    // LEGACY_CONTRIB contribution unless explicitly overridden.
    const contributedByCycleId = new Map<string, number>();
    for (const c of seeded.cycles) {
      const override = contributedByCycleNumber?.find((x) => x.cycleNumber === c.cycleNumber);
      contributedByCycleId.set(c.id, override ? override.contributed : LEGACY_CONTRIB);
    }
    return { cycles, advancesByCycleId, contributedByCycleId };
  };

  /** Run the SQL helper as the collector (RLS-scoped). */
  const callSql = async (
    collector: PhoneCollector,
    memberId: string,
    cycleId: string,
  ): Promise<bigint> => {
    const user = createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${collector.jwt}` } },
    });
    const { data, error } = await user.rpc("compute_opening_balance", {
      p_member_id: memberId,
      p_cycle_id: cycleId,
    });
    if (error) throw new Error(`compute_opening_balance RPC: ${error.message}`);
    return BigInt(data ?? 0);
  };

  Deno.test({
    name: "12.3 #1 — first cycle (cycle_number=1) → SQL 0 == TS 0",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "oc1");
      try {
        const seeded = await seedMember(c, [
          {
            cycleNumber: 1,
            startDate: "2026-05-01",
            endDate: "2026-05-30",
            status: "active",
            advancesTotal: 5000,
          },
        ]);
        const cycleId = seeded.cycles[0]!.id;
        const sql = await callSql(c, seeded.memberId, cycleId);
        const { cycles, advancesByCycleId, contributedByCycleId } = tsInputs(
          seeded,
          [{ cycleNumber: 1, status: "active" }],
          [{ cycleNumber: 1, advances: 5000 }],
        );
        const ts = computeOpeningBalance(
          cycles,
          advancesByCycleId,
          contributedByCycleId,
          DAILY,
          cycleId,
        );
        assertEquals(sql, 0n);
        assertEquals(BigInt(ts), sql, "SQL/TS mismatch on first-cycle case");
      } finally {
        await cleanup(c);
      }
    },
  });

  Deno.test({
    name: "12.3 #2 — prev cycle 'settled' → SQL 0 == TS 0 (chain restarts)",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "oc2");
      try {
        const seeded = await seedMember(c, [
          {
            cycleNumber: 1,
            startDate: "2026-04-01",
            endDate: "2026-04-30",
            status: "settled",
            advancesTotal: 50_000,
          },
          {
            cycleNumber: 2,
            startDate: "2026-05-01",
            endDate: "2026-05-30",
            status: "active",
            advancesTotal: 0,
          },
        ]);
        const cycle2Id = seeded.cycles[1]!.id;
        const sql = await callSql(c, seeded.memberId, cycle2Id);
        const { cycles, advancesByCycleId, contributedByCycleId } = tsInputs(
          seeded,
          [
            { cycleNumber: 1, status: "settled" },
            { cycleNumber: 2, status: "active" },
          ],
          [{ cycleNumber: 1, advances: 50_000 }],
        );
        const ts = computeOpeningBalance(
          cycles,
          advancesByCycleId,
          contributedByCycleId,
          DAILY,
          cycle2Id,
        );
        assertEquals(sql, 0n);
        assertEquals(BigInt(ts), sql);
      } finally {
        await cleanup(c);
      }
    },
  });

  Deno.test({
    name: "12.3 #3 — prev cycle unsettled with debt → SQL == TS (positive carry-over)",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "oc3");
      try {
        const seeded = await seedMember(c, [
          {
            cycleNumber: 1,
            startDate: "2026-04-01",
            endDate: "2026-04-30",
            status: "completed",
            advancesTotal: 20_000, // daily × 29 = 14_500, debt = 5_500
          },
          {
            cycleNumber: 2,
            startDate: "2026-05-01",
            endDate: "2026-05-30",
            status: "active",
            advancesTotal: 0,
          },
        ]);
        const cycle2Id = seeded.cycles[1]!.id;
        const sql = await callSql(c, seeded.memberId, cycle2Id);
        const { cycles, advancesByCycleId, contributedByCycleId } = tsInputs(
          seeded,
          [
            { cycleNumber: 1, status: "completed" },
            { cycleNumber: 2, status: "active" },
          ],
          [{ cycleNumber: 1, advances: 20_000 }],
        );
        const ts = computeOpeningBalance(
          cycles,
          advancesByCycleId,
          contributedByCycleId,
          DAILY,
          cycle2Id,
        );
        assertEquals(sql, 5_500n);
        assertEquals(BigInt(ts), sql, "SQL/TS mismatch on simple-debt case");
        assert(Number(sql) === ts, "Cross-cast TS=SQL");
      } finally {
        await cleanup(c);
      }
    },
  });

  Deno.test({
    name: "12.3 #4 — 3-cycle chain (none settled) → debt recursively accumulates",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "oc4");
      try {
        const seeded = await seedMember(c, [
          {
            cycleNumber: 1,
            startDate: "2026-03-01",
            endDate: "2026-03-30",
            status: "completed",
            advancesTotal: 16_000, // c1 debt = 1_500
          },
          {
            cycleNumber: 2,
            startDate: "2026-04-01",
            endDate: "2026-04-30",
            status: "completed",
            advancesTotal: 14_500, // c2 final = 14_500 − 14_500 − 1_500 = -1_500 → c3 opening = 1_500
          },
          {
            cycleNumber: 3,
            startDate: "2026-05-01",
            endDate: "2026-05-30",
            status: "active",
            advancesTotal: 0,
          },
        ]);
        const cycle2Id = seeded.cycles[1]!.id;
        const cycle3Id = seeded.cycles[2]!.id;
        const sqlC2 = await callSql(c, seeded.memberId, cycle2Id);
        const sqlC3 = await callSql(c, seeded.memberId, cycle3Id);
        assertEquals(sqlC2, 1_500n, "c2 opening from c1 debt");
        assertEquals(sqlC3, 1_500n, "c3 opening = c2 debt (recursive)");

        const { cycles, advancesByCycleId, contributedByCycleId } = tsInputs(
          seeded,
          [
            { cycleNumber: 1, status: "completed" },
            { cycleNumber: 2, status: "completed" },
            { cycleNumber: 3, status: "active" },
          ],
          [
            { cycleNumber: 1, advances: 16_000 },
            { cycleNumber: 2, advances: 14_500 },
          ],
        );
        assertEquals(
          BigInt(
            computeOpeningBalance(cycles, advancesByCycleId, contributedByCycleId, DAILY, cycle2Id),
          ),
          sqlC2,
        );
        assertEquals(
          BigInt(
            computeOpeningBalance(cycles, advancesByCycleId, contributedByCycleId, DAILY, cycle3Id),
          ),
          sqlC3,
        );
      } finally {
        await cleanup(c);
      }
    },
  });

  Deno.test({
    name: "12.3 #5 — c2 repays past debt entirely → c3 opening = 0",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "oc5");
      try {
        const seeded = await seedMember(c, [
          {
            cycleNumber: 1,
            startDate: "2026-03-01",
            endDate: "2026-03-30",
            status: "completed",
            advancesTotal: 19_500, // c1 debt = 5_000
          },
          {
            cycleNumber: 2,
            startDate: "2026-04-01",
            endDate: "2026-04-30",
            status: "completed",
            advancesTotal: 0, // c2 balance = 14_500 − 0 − 5_000 = 9_500 → no debt
          },
          {
            cycleNumber: 3,
            startDate: "2026-05-01",
            endDate: "2026-05-30",
            status: "active",
            advancesTotal: 0,
          },
        ]);
        const cycle3Id = seeded.cycles[2]!.id;
        const sql = await callSql(c, seeded.memberId, cycle3Id);
        assertEquals(sql, 0n);

        const { cycles, advancesByCycleId, contributedByCycleId } = tsInputs(
          seeded,
          [
            { cycleNumber: 1, status: "completed" },
            { cycleNumber: 2, status: "completed" },
            { cycleNumber: 3, status: "active" },
          ],
          [{ cycleNumber: 1, advances: 19_500 }],
        );
        assertEquals(
          BigInt(
            computeOpeningBalance(cycles, advancesByCycleId, contributedByCycleId, DAILY, cycle3Id),
          ),
          sql,
        );
      } finally {
        await cleanup(c);
      }
    },
  });

  Deno.test({
    name: "2026-06-07 #6 — prev cycle ZERO cotisation, no advance → SQL 0 == TS 0 (commission capped, no phantom debt)",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "oc6");
      try {
        const seeded = await seedMember(c, [
          {
            cycleNumber: 1,
            startDate: "2026-04-01",
            endDate: "2026-04-30",
            status: "completed",
            advancesTotal: 0,
            contributedTotal: 0, // nothing versé — pre-fix this carried DAILY (500)
          },
          {
            cycleNumber: 2,
            startDate: "2026-05-01",
            endDate: "2026-05-30",
            status: "active",
            advancesTotal: 0,
            contributedTotal: 0,
          },
        ]);
        const cycle2Id = seeded.cycles[1]!.id;
        const sql = await callSql(c, seeded.memberId, cycle2Id);
        const { cycles, advancesByCycleId, contributedByCycleId } = tsInputs(
          seeded,
          [
            { cycleNumber: 1, status: "completed" },
            { cycleNumber: 2, status: "active" },
          ],
          [],
          [
            { cycleNumber: 1, contributed: 0 },
            { cycleNumber: 2, contributed: 0 },
          ],
        );
        const ts = computeOpeningBalance(
          cycles,
          advancesByCycleId,
          contributedByCycleId,
          DAILY,
          cycle2Id,
        );
        assertEquals(sql, 0n, "zero-cotisation cycle must carry no commission debt");
        assertEquals(BigInt(ts), sql, "SQL/TS mismatch on zero-cotisation case");
      } finally {
        await cleanup(c);
      }
    },
  });
}
