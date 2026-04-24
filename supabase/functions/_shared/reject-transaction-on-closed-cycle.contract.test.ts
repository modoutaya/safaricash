// Story 3.4 — reject_transaction_on_closed_cycle trigger contract test.
//
// Asserts FR19: BEFORE INSERT trigger on transactions rejects ALL kinds
// (contribution, rattrapage, advance) on completed/settled cycles via
// sqlstate 23514 → PostgREST 409.
//
//   1. Insert contribution on `active` → succeeds.
//   2. Insert contribution on `with_advance` → succeeds.
//   3. Insert contribution on `completed` → 23514 with the expected
//      message + hint.
//   4. Insert rattrapage on `completed` → 23514.
//   5. Insert advance on `completed` → 23514.
//   6. Insert advance on `settled` → 23514.
//
// Pattern mirrors promote-cycle-on-advance.contract.test.ts (Story 3.3).

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
    p_phone_number: "",
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

type TxKind = "contribution" | "rattrapage" | "advance";

async function tryInsertTransaction(
  service: SupabaseClient,
  args: {
    collectorId: string;
    memberId: string;
    cycleId: string;
    kind: TxKind;
    cycleDay: number;
  },
): Promise<{ ok: true } | { ok: false; code: string; message: string; hint: string | null }> {
  const { data: secret, error: vaultErr } = await service.rpc("vault_encrypt", {
    plaintext: "500",
  });
  if (vaultErr || !secret) throw new Error(`tryInsert: vault_encrypt — ${vaultErr?.message}`);

  const { error: txErr } = await service.from("transactions").insert({
    collector_id: args.collectorId,
    member_id: args.memberId,
    cycle_id: args.cycleId,
    kind: args.kind,
    amount_encrypted: secret,
    cycle_day: args.cycleDay,
    source: "online",
  });
  if (txErr) {
    return {
      ok: false,
      code: txErr.code ?? "",
      message: txErr.message ?? "",
      hint: txErr.hint ?? null,
    };
  }
  return { ok: true };
}

async function setCycleStatus(
  service: SupabaseClient,
  cycleId: string,
  status: "active" | "with_advance" | "completed" | "settled",
): Promise<void> {
  const { error } = await service.from("cycles").update({ status }).eq("id", cycleId);
  if (error) throw new Error(`setCycleStatus: ${error.message}`);
}

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "reject_transaction_on_closed_cycle (3.4) — skip when Supabase env not set",
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
    name: "contribution on active cycle succeeds",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rej1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        const result = await tryInsertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "contribution",
          cycleDay: 1,
        });
        assertEquals(result.ok, true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "contribution on with_advance cycle succeeds",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rej2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await setCycleStatus(service, cycleId, "with_advance");

        const result = await tryInsertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "contribution",
          cycleDay: 5,
        });
        assertEquals(result.ok, true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "contribution on completed cycle is rejected with 23514 + hint",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rej3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await setCycleStatus(service, cycleId, "completed");

        const result = await tryInsertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "contribution",
          cycleDay: 30,
        });
        assert(!result.ok, "expected rejection on completed cycle");
        if (result.ok) return;
        assertEquals(result.code, "23514");
        assertStringIncludes(result.message, "cycle_closed");
        assertStringIncludes(result.message, "contribution");
        assertStringIncludes(result.message, "completed");
        assert(result.hint?.includes("restart_member_cycle"), "expected hint to mention restart");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "rattrapage on completed cycle is rejected with 23514",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rej4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await setCycleStatus(service, cycleId, "completed");

        const result = await tryInsertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "rattrapage",
          cycleDay: 30,
        });
        assert(!result.ok);
        if (result.ok) return;
        assertEquals(result.code, "23514");
        assertStringIncludes(result.message, "rattrapage");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "advance on completed cycle is rejected with 23514 (BEFORE trigger pre-empts AFTER promote)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rej5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await setCycleStatus(service, cycleId, "completed");

        const result = await tryInsertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "advance",
          cycleDay: 30,
        });
        assert(!result.ok);
        if (result.ok) return;
        assertEquals(result.code, "23514");
        assertStringIncludes(result.message, "advance");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "advance on settled cycle is rejected with 23514",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "rej6");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        await setCycleStatus(service, cycleId, "settled");

        const result = await tryInsertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "advance",
          cycleDay: 30,
        });
        assert(!result.ok);
        if (result.ok) return;
        assertEquals(result.code, "23514");
        assertStringIncludes(result.message, "settled");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
