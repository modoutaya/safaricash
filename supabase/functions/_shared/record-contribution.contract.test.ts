// Story 4.3 — record_contribution RPC + sms_queue enqueue contract tests.
//
// Asserts:
//   1. Happy path → transaction inserted, audit transaction.committed lands,
//      sms_queue row enqueued (member has phone).
//   2. Member without phone → transaction inserted, NO sms_queue row.
//   3. Closed cycle (Story 3.4 trigger) → 23514 rejection.
//   4. Foreign collector via service-role → unauthorized rejection.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

type PhoneCollector = {
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
): Promise<PhoneCollector> {
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
  withPhone = true,
): Promise<{ memberId: string; cycleId: string }> {
  const phone = withPhone ? "+221770000111" : "";
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: phone,
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
  // Story 11.3 — pin the seeded cycle to a deterministic 30-day window so
  // tests asserting cycle_day ∈ [1, 30] keep working regardless of when
  // they run (post-11.3 create_member_with_cycle produces variable-length
  // calendar-month cycles by default).
  const { error: pinErr } = await service
    .from("cycles")
    .update({ start_date: "2026-04-01", end_date: "2026-04-30" })
    .eq("id", cycle.id);
  if (pinErr) throw new Error(`seedMember: pin cycle dates — ${pinErr.message}`);
  return { memberId, cycleId: cycle.id };
}

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "record_contribution (4.3) — skip when Supabase env not set",
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

  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "happy path — transaction inserted + audit + sms_queue row enqueued (member with phone)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rec1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(
          userClient,
          service,
          c.userId,
          true,
        );

        const { data: txId, error: rpcErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assertEquals(rpcErr, null);
        assert(typeof txId === "string");

        // Transaction row exists with correct fields.
        const { data: tx } = await service
          .from("transactions")
          .select("id, kind, source, member_id, cycle_id, cycle_day")
          .eq("id", txId)
          .single();
        assertEquals(tx?.kind, "contribution");
        assertEquals(tx?.source, "online");
        assertEquals(tx?.cycle_day, 1);

        // Audit transaction.committed event lands.
        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("entity_id", txId)
          .eq("event_type", "transaction.committed");
        assertEquals(auditCount, 1);

        // sms_queue row enqueued.
        const { count: smsCount } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(smsCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "member without phone — transaction inserted, NO sms_queue row",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rec2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(
          userClient,
          service,
          c.userId,
          false,
        );

        const { data: txId, error: rpcErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assertEquals(rpcErr, null);
        assert(typeof txId === "string");

        const { count: smsCount } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(smsCount, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "closed cycle — Story 3.4 trigger raises 23514",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rec3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await service.from("cycles").update({ status: "completed" }).eq("id", cycleId);

        const { data: txId, error: rpcErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 30,
        });
        assert(txId === null);
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "23514");
        assertStringIncludes(rpcErr?.message ?? "", "cycle_closed");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "foreign collector — RPC raises unauthorized",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ownerC = await seedCollector(service, anon, "rec4o");
      const intruderC = await seedCollector(service, anon, "rec4i");
      try {
        const ownerClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${ownerC.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(
          ownerClient,
          service,
          ownerC.userId,
        );

        const intruderClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${intruderC.jwt}` } },
        });

        const { data: txId, error: rpcErr } = await intruderClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assert(txId === null);
        assert(rpcErr !== null);
        assertStringIncludes(rpcErr?.message ?? "", "unauthorized");
      } finally {
        await cleanup(service, ownerC);
        await cleanup(service, intruderC);
      }
    },
  });

  // -------------------------------------------------------------------------
  // Story 11.3 AC #12 — cycle_day = 31 accepted; cycle_day = 32 rejected.
  // -------------------------------------------------------------------------
  Deno.test({
    name: "11.3 AC #12 — record_contribution accepts cycle_day=31; rejects cycle_day=32",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rec113");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // Seed + override to a 31-day cycle (January 2026 → cycleLength 31).
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { error: pinErr } = await service
          .from("cycles")
          .update({ start_date: "2026-01-01", end_date: "2026-01-31" })
          .eq("id", cycleId);
        if (pinErr) throw new Error(`pin cycle: ${pinErr.message}`);

        // cycle_day = 31 is now accepted (was rejected pre-11.3).
        const { data: txId, error: errAccept } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 31,
        });
        assertEquals(errAccept, null);
        assert(typeof txId === "string");

        // cycle_day = 32 still rejected.
        const { error: err32 } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 32,
        });
        assert(err32 !== null);
        assertEquals(err32?.code, "22000");
        assertStringIncludes(err32?.message ?? "", "invalid_cycle_day");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
