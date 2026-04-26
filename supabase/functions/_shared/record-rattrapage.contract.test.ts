// Story 4.4 — record_rattrapage RPC + cross-kind CHECK contract tests.
//
// Asserts:
//   1. Happy path → row inserted with kind=rattrapage, days_covered=N,
//      decrypted amount = dailyAmount × N, audit + sms_queue land.
//   2. Out-of-range days_covered=1 → 22000.
//   3. Out-of-range days_covered=5 → 22000.
//   4. Rattrapage exceeds cycle remaining → 22000.
//   5. Closed cycle (Story 3.4 trigger) → 23514.
//   6. Foreign collector → unauthorized.
//   7. Direct INSERT bypassing RPC violates the cross-kind CHECK.

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
): Promise<{ memberId: string; cycleId: string }> {
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: "+221770000222",
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

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "record_rattrapage (4.4) — skip when Supabase env not set",
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
    name: "happy path — rattrapage inserted with kind=rattrapage, days_covered=3, amount = 500*3 = 1500",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rat1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: txId, error: rpcErr } = await userClient.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 10,
          p_days_covered: 3,
        });
        assertEquals(rpcErr, null);
        assert(typeof txId === "string");

        const { data: tx } = await service
          .from("transactions")
          .select("id, kind, source, days_covered, cycle_day")
          .eq("id", txId)
          .single();
        assertEquals(tx?.kind, "rattrapage");
        assertEquals(tx?.source, "online");
        assertEquals(tx?.days_covered, 3);
        assertEquals(tx?.cycle_day, 10);

        // Decrypted amount = 500 × 3 = 1500.
        const { data: decrypted } = await service
          .from("transactions_decrypted")
          .select("amount")
          .eq("id", txId)
          .single();
        assertEquals(Number(decrypted?.amount), 1500);

        // Audit transaction.committed lands.
        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("entity_id", txId)
          .eq("event_type", "transaction.committed");
        assertEquals(auditCount, 1);

        // sms_queue row enqueued (member has phone).
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
    name: "out-of-range days_covered=1 → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rat2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error: rpcErr } = await userClient.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 5,
          p_days_covered: 1,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "22000");
        assertStringIncludes(rpcErr?.message ?? "", "invalid_days_covered");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "out-of-range days_covered=5 → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rat3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error: rpcErr } = await userClient.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 5,
          p_days_covered: 5,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "22000");
        assertStringIncludes(rpcErr?.message ?? "", "invalid_days_covered");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "rattrapage exceeds cycle remaining (cycle_day=29 + days_covered=4 > 30) → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rat4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { error: rpcErr } = await userClient.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 29,
          p_days_covered: 4,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "22000");
        assertStringIncludes(rpcErr?.message ?? "", "exceeds cycle");
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
      const c = await seedCollector(service, anon, "rat5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await service.from("cycles").update({ status: "completed" }).eq("id", cycleId);

        const { error: rpcErr } = await userClient.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 10,
          p_days_covered: 2,
        });
        assert(rpcErr !== null);
        assertEquals(rpcErr?.code, "23514");
        assertStringIncludes(rpcErr?.message ?? "", "cycle_closed");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "foreign collector — unauthorized",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ownerC = await seedCollector(service, anon, "rat6o");
      const intruderC = await seedCollector(service, anon, "rat6i");
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

        const { error: rpcErr } = await intruderClient.rpc("record_rattrapage", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_daily_amount: 500,
          p_cycle_day: 10,
          p_days_covered: 2,
        });
        assert(rpcErr !== null);
        assertStringIncludes(rpcErr?.message ?? "", "unauthorized");
      } finally {
        await cleanup(service, ownerC);
        await cleanup(service, intruderC);
      }
    },
  });

  Deno.test({
    name: "DB CHECK constraint — direct INSERT kind=contribution + days_covered=2 rejected",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rat7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: amountSecret } = await service.rpc("vault_encrypt", { plaintext: "1000" });

        const { error: insertErr } = await service.from("transactions").insert({
          collector_id: c.userId,
          member_id: memberId,
          cycle_id: cycleId,
          kind: "contribution",
          amount_encrypted: amountSecret,
          cycle_day: 5,
          source: "online",
          days_covered: 2, // ← invalid: contribution must have days_covered=1
        });
        assert(insertErr !== null);
        assertEquals(insertErr?.code, "23514");
        assertStringIncludes(insertErr?.message ?? "", "transactions_days_covered_kind_chk");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "DB CHECK constraint — direct INSERT kind=rattrapage + days_covered=1 rejected",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rat8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const { data: amountSecret } = await service.rpc("vault_encrypt", { plaintext: "500" });

        const { error: insertErr } = await service.from("transactions").insert({
          collector_id: c.userId,
          member_id: memberId,
          cycle_id: cycleId,
          kind: "rattrapage",
          amount_encrypted: amountSecret,
          cycle_day: 5,
          source: "online",
          days_covered: 1, // ← invalid: rattrapage must have days_covered ≥ 2
        });
        assert(insertErr !== null);
        assertEquals(insertErr?.code, "23514");
        assertStringIncludes(insertErr?.message ?? "", "transactions_days_covered_kind_chk");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
