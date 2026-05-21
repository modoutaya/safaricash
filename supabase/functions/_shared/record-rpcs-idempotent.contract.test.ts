// Story 8.4 — Idempotency contract tests for record_* RPCs.
//
// Validates the Story 8.4 p_event_id idempotent early-return behavior
// across all 3 mutation RPCs (record_contribution / record_advance /
// record_rattrapage). For each RPC:
//   1. Fresh p_event_id → inserts a row, returns its id.
//   2. Same p_event_id repeated → returns SAME id, no second row, no
//      second audit / SMS / cycle-promotion side-effect.
//   3. Same p_event_id from a DIFFERENT collector → falls through to a
//      fresh INSERT (event_id × collector_id partitioning).
//
// All 9 cases share the same seeding boilerplate as Story 4.3's
// record-contribution.contract.test.ts.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

type Collector = {
  userId: string;
  phone: string;
  password: string;
  jwt: string;
};

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

async function seedCollector(
  service: SupabaseClient,
  anon: SupabaseClient,
  label: string,
): Promise<Collector> {
  const stamp = Date.now();
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map((b) => (b % 10).toString())
    .join("");
  const phone = `+22177${suffix}`;
  const password = `Pw-${label}-${suffix}-${stamp}`;

  const { data, error } = await service.auth.admin.createUser({
    phone,
    password,
    phone_confirm: true,
  });
  if (error || !data.user) throw new Error(`seed(${label}): ${error?.message}`);
  const userId = data.user.id;

  const { error: usersErr } = await service
    .from("users")
    .insert({ id: userId, phone_number: phone, role: "collector" });
  if (usersErr) {
    await service.auth.admin.deleteUser(userId);
    throw new Error(`seed(${label}): users insert — ${usersErr.message}`);
  }

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    phone,
    password,
  });
  if (signInErr || !signIn.session?.access_token) {
    await service.auth.admin.deleteUser(userId);
    throw new Error(`seed(${label}): signIn — ${signInErr?.message}`);
  }
  return { userId, phone, password, jwt: signIn.session.access_token };
}

async function seedMemberWithCycle(
  userClient: SupabaseClient,
  service: SupabaseClient,
  collectorId: string,
): Promise<{ memberId: string; cycleId: string }> {
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: "+221770000111",
    p_daily_amount: 500,
  });
  if (createErr || !memberId) throw new Error(`seedMember: ${createErr?.message}`);

  const { data: cycle } = await service
    .from("cycles")
    .select("id")
    .eq("member_id", memberId)
    .eq("collector_id", collectorId)
    .single();
  if (!cycle) throw new Error("seedMember: cycle not found");
  return { memberId, cycleId: cycle.id };
}

async function cleanup(service: SupabaseClient, c: Collector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

function userClientFor(env: { url: string; anonKey: string }, jwt: string): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/** Story 12.5 PR B — seed a single contribution so the cap on the
 *  follow-up advance is non-zero. record_advance now refuses to credit
 *  more than the saver has versed. amount=10_000 covers every 500-FCFA
 *  advance the idempotency tests below attempt. */
async function seedSingleContrib(
  userClient: SupabaseClient,
  memberId: string,
  cycleId: string,
): Promise<void> {
  const { error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: 10_000,
    p_cycle_day: 1,
  });
  if (error) throw new Error(`seedSingleContrib: ${error.message}`);
}

const env = envOrSkip();

Deno.test({
  name: "Story 8.4 idempotent RPCs — skip when Supabase env not set",
  ignore: !!env,
  fn: () => {
    console.log(
      "SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not set — skipping contract tests.",
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

  // -------------------------------------------------------------------------
  // record_contribution — 3 cases
  // -------------------------------------------------------------------------

  Deno.test({
    name: "record_contribution — fresh p_event_id inserts a row",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "ctr1");
      try {
        const user = userClientFor(env, c.jwt);
        const { memberId, cycleId } = await seedMemberWithCycle(user, service, c.userId);
        const eventId = crypto.randomUUID();
        const { data: txId, error } = await user.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
          p_event_id: eventId,
        });
        assertEquals(error, null);
        assert(typeof txId === "string");

        // event_id stored alongside the row.
        const { data: row } = await service
          .from("transactions")
          .select("id, event_id, source")
          .eq("id", txId!)
          .single();
        assertEquals(row?.event_id, eventId);
        assertEquals(row?.source, "offline_reconciled");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "record_contribution — same p_event_id replayed returns SAME id, no second row, no second audit",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "ctr2");
      try {
        const user = userClientFor(env, c.jwt);
        const { memberId, cycleId } = await seedMemberWithCycle(user, service, c.userId);
        const eventId = crypto.randomUUID();
        const args = {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
          p_event_id: eventId,
        };

        const { data: firstId } = await user.rpc("record_contribution", args);
        const { data: secondId, error } = await user.rpc("record_contribution", args);
        assertEquals(error, null);
        assertEquals(secondId, firstId);

        // Exactly ONE row exists for this event_id.
        const { count: rowCount } = await service
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("event_id", eventId);
        assertEquals(rowCount, 1);

        // Exactly ONE audit event for this transaction (no double emission).
        const { count: auditCount, error: auditErr } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("entity_id", firstId!)
          .eq("event_type", "transaction.committed");
        // Story 8.4 code-review patch — guard against misconfigured CI
        // where the service role can't read audit_log (would silently
        // return null + fail the equality below with a confusing error).
        assert(auditErr === null, `audit_log query failed: ${auditErr?.message}`);
        assert(auditCount !== null, "audit_log must be accessible to service role");
        assertEquals(auditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "record_contribution — same p_event_id from a DIFFERENT collector falls through to fresh INSERT (partial UNIQUE partitioned by collector_id)",
    ...denoOpts,
    fn: async () => {
      const a = await seedCollector(service, anon, "ctr3a");
      const b = await seedCollector(service, anon, "ctr3b");
      try {
        const userA = userClientFor(env, a.jwt);
        const userB = userClientFor(env, b.jwt);
        const seedA = await seedMemberWithCycle(userA, service, a.userId);
        const seedB = await seedMemberWithCycle(userB, service, b.userId);
        const sharedEventId = crypto.randomUUID();

        const { data: txA } = await userA.rpc("record_contribution", {
          p_member_id: seedA.memberId,
          p_cycle_id: seedA.cycleId,
          p_amount: 500,
          p_cycle_day: 1,
          p_event_id: sharedEventId,
        });

        // Story 8.4 code-review patch — migration 0060 re-partitioned
        // the UNIQUE index on (collector_id, event_id) so cross-
        // collector event_id reuse now produces DISTINCT rows (matches
        // AC #20 "fresh INSERT via RLS-aware WHERE clause" semantic).
        const { data: txB, error: errB } = await userB.rpc("record_contribution", {
          p_member_id: seedB.memberId,
          p_cycle_id: seedB.cycleId,
          p_amount: 500,
          p_cycle_day: 1,
          p_event_id: sharedEventId,
        });
        assertEquals(errB, null);
        assert(typeof txA === "string");
        assert(typeof txB === "string");
        assert(txA !== txB, "cross-collector p_event_id reuse must produce distinct tx ids");

        // Both rows exist, both carry the same event_id but different collector_id.
        const { count: rowCount } = await service
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("event_id", sharedEventId);
        assertEquals(rowCount, 2);
      } finally {
        await cleanup(service, a);
        await cleanup(service, b);
      }
    },
  });

  // -------------------------------------------------------------------------
  // record_rattrapage — 3 cases
  // -------------------------------------------------------------------------

  Deno.test({
    name: "record_rattrapage — fresh p_event_id inserts a row",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "rat1");
      try {
        const user = userClientFor(env, c.jwt);
        const { memberId, cycleId } = await seedMemberWithCycle(user, service, c.userId);
        const eventId = crypto.randomUUID();
        const { data: txId, error } = await user.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 5,
          p_days_covered: 3,
          p_event_id: eventId,
        });
        assertEquals(error, null);
        assert(typeof txId === "string");

        const { data: row } = await service
          .from("transactions")
          .select("event_id, source, kind, days_covered")
          .eq("id", txId!)
          .single();
        assertEquals(row?.event_id, eventId);
        assertEquals(row?.source, "offline_reconciled");
        assertEquals(row?.kind, "rattrapage");
        assertEquals(row?.days_covered, 3);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "record_rattrapage — replay with same p_event_id returns same id",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "rat2");
      try {
        const user = userClientFor(env, c.jwt);
        const { memberId, cycleId } = await seedMemberWithCycle(user, service, c.userId);
        const eventId = crypto.randomUUID();
        const args = {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 5,
          p_days_covered: 3,
          p_event_id: eventId,
        };
        const { data: firstId } = await user.rpc("record_rattrapage", args);
        const { data: secondId } = await user.rpc("record_rattrapage", args);
        assertEquals(secondId, firstId);

        const { count: rowCount } = await service
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("event_id", eventId);
        assertEquals(rowCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "record_rattrapage — cross-collector p_event_id reuse falls through to fresh INSERT",
    ...denoOpts,
    fn: async () => {
      const a = await seedCollector(service, anon, "rat3a");
      const b = await seedCollector(service, anon, "rat3b");
      try {
        const userA = userClientFor(env, a.jwt);
        const userB = userClientFor(env, b.jwt);
        const seedA = await seedMemberWithCycle(userA, service, a.userId);
        const seedB = await seedMemberWithCycle(userB, service, b.userId);
        const shared = crypto.randomUUID();
        const { data: txA } = await userA.rpc("record_rattrapage", {
          p_member_id: seedA.memberId,
          p_cycle_id: seedA.cycleId,
          p_daily_amount: 500,
          p_cycle_day: 5,
          p_days_covered: 3,
          p_event_id: shared,
        });
        const { data: txB, error: errB } = await userB.rpc("record_rattrapage", {
          p_member_id: seedB.memberId,
          p_cycle_id: seedB.cycleId,
          p_daily_amount: 500,
          p_cycle_day: 5,
          p_days_covered: 3,
          p_event_id: shared,
        });
        assertEquals(errB, null);
        assert(typeof txA === "string" && typeof txB === "string" && txA !== txB);
      } finally {
        await cleanup(service, a);
        await cleanup(service, b);
      }
    },
  });

  // -------------------------------------------------------------------------
  // record_advance — 3 cases
  // -------------------------------------------------------------------------

  Deno.test({
    name: "record_advance — fresh p_event_id inserts a row",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "adv1");
      try {
        const user = userClientFor(env, c.jwt);
        const { memberId, cycleId } = await seedMemberWithCycle(user, service, c.userId);
        await seedSingleContrib(user, memberId, cycleId);
        const eventId = crypto.randomUUID();
        const { data: txId, error } = await user.rpc("record_advance", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 5,
          p_motive: "urgence familiale",
          p_saver_acknowledged: true,
          p_event_id: eventId,
        });
        assertEquals(error, null);
        assert(typeof txId === "string");

        const { data: row } = await service
          .from("transactions")
          .select("event_id, source, kind, motive, saver_acknowledged")
          .eq("id", txId!)
          .single();
        assertEquals(row?.event_id, eventId);
        assertEquals(row?.source, "offline_reconciled");
        assertEquals(row?.kind, "advance");
        assertEquals(row?.motive, "urgence familiale");
        assertEquals(row?.saver_acknowledged, true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "record_advance — replay with same p_event_id returns same id",
    ...denoOpts,
    fn: async () => {
      const c = await seedCollector(service, anon, "adv2");
      try {
        const user = userClientFor(env, c.jwt);
        const { memberId, cycleId } = await seedMemberWithCycle(user, service, c.userId);
        await seedSingleContrib(user, memberId, cycleId);
        const eventId = crypto.randomUUID();
        const args = {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 5,
          p_motive: "urgence familiale",
          p_saver_acknowledged: true,
          p_event_id: eventId,
        };
        const { data: firstId } = await user.rpc("record_advance", args);
        const { data: secondId } = await user.rpc("record_advance", args);
        assertEquals(secondId, firstId);

        const { count: rowCount } = await service
          .from("transactions")
          .select("id", { count: "exact", head: true })
          .eq("event_id", eventId);
        assertEquals(rowCount, 1);

        // The promote_cycle_on_advance trigger must NOT fire twice
        // (no second cycle.transitioned audit event for the same tx).
        const { count: cycleTransitionAuditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("event_type", "cycle.transitioned")
          .eq("collector_id", c.userId);
        // Exactly ONE transition: active → with_advance from the
        // first call. The second (idempotent-replay) doesn't re-trigger.
        assertEquals(cycleTransitionAuditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "record_advance — cross-collector p_event_id reuse falls through to fresh INSERT",
    ...denoOpts,
    fn: async () => {
      const a = await seedCollector(service, anon, "adv3a");
      const b = await seedCollector(service, anon, "adv3b");
      try {
        const userA = userClientFor(env, a.jwt);
        const userB = userClientFor(env, b.jwt);
        const seedA = await seedMemberWithCycle(userA, service, a.userId);
        const seedB = await seedMemberWithCycle(userB, service, b.userId);
        await seedSingleContrib(userA, seedA.memberId, seedA.cycleId);
        await seedSingleContrib(userB, seedB.memberId, seedB.cycleId);
        const shared = crypto.randomUUID();
        const { data: txA } = await userA.rpc("record_advance", {
          p_member_id: seedA.memberId,
          p_cycle_id: seedA.cycleId,
          p_amount: 500,
          p_cycle_day: 5,
          p_motive: "urgence familiale",
          p_saver_acknowledged: true,
          p_event_id: shared,
        });
        const { data: txB, error: errB } = await userB.rpc("record_advance", {
          p_member_id: seedB.memberId,
          p_cycle_id: seedB.cycleId,
          p_amount: 500,
          p_cycle_day: 5,
          p_motive: "urgence familiale",
          p_saver_acknowledged: true,
          p_event_id: shared,
        });
        assertEquals(errB, null);
        assert(typeof txA === "string" && typeof txB === "string" && txA !== txB);
      } finally {
        await cleanup(service, a);
        await cleanup(service, b);
      }
    },
  });
}
