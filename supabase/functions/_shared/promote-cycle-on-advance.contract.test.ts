// Story 3.3 — promote_cycle_on_advance trigger contract test.
//
// Runs against LIVE local/cloud Supabase (env-gated like the other
// contract tests). Asserts the FR18-partial invariant:
//
//   1. Insert advance on an `active` cycle → cycle becomes `with_advance`
//      + 1 `cycle.transitioned` audit event lands.
//   2. Insert second advance on the same (now `with_advance`) cycle →
//      no second `cycle.transitioned` event (idempotent).
//   3. Insert contribution on `active` cycle → status stays `active`,
//      no audit `cycle.transitioned`.
//   4. Insert advance on a manually-completed cycle → status stays
//      `completed`, no audit `cycle.transitioned`.
//
// Pattern mirrors create-member-with-cycle.contract.test.ts.

import { assertEquals } from "jsr:@std/assert@1";
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
  // Use the existing create_member_with_cycle RPC for consistency with
  // Story 2.2's flow.
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

async function insertTransaction(
  service: SupabaseClient,
  args: {
    collectorId: string;
    memberId: string;
    cycleId: string;
    kind: "contribution" | "rattrapage" | "advance";
    cycleDay: number;
  },
): Promise<void> {
  const { data: secret, error: vaultErr } = await service.rpc("vault_encrypt", {
    plaintext: "500",
  });
  if (vaultErr || !secret) throw new Error(`insertTx: vault_encrypt — ${vaultErr?.message}`);

  const { error: txErr } = await service.from("transactions").insert({
    collector_id: args.collectorId,
    member_id: args.memberId,
    cycle_id: args.cycleId,
    kind: args.kind,
    amount_encrypted: secret,
    cycle_day: args.cycleDay,
    source: "online",
  });
  if (txErr) throw new Error(`insertTx(${args.kind}): ${txErr.message}`);
}

async function countCycleTransitionedEvents(
  service: SupabaseClient,
  cycleId: string,
): Promise<number> {
  const { data, error } = await service
    .from("audit_log")
    .select("event_id", { count: "exact", head: true })
    .eq("entity_table", "cycles")
    .eq("entity_id", cycleId)
    .eq("event_type", "cycle.transitioned");
  if (error) throw new Error(`countAudit: ${error.message}`);
  return data === null ? 0 : 0; // placeholder — real count comes from `count` field below
}

async function getCycleStatus(service: SupabaseClient, cycleId: string): Promise<string> {
  const { data, error } = await service.from("cycles").select("status").eq("id", cycleId).single();
  if (error || !data) throw new Error(`getCycleStatus: ${error?.message}`);
  return data.status;
}

async function getCycleTransitionedCount(
  service: SupabaseClient,
  cycleId: string,
): Promise<number> {
  const { count, error } = await service
    .from("audit_log")
    .select("event_id", { count: "exact", head: true })
    .eq("entity_table", "cycles")
    .eq("entity_id", cycleId)
    .eq("event_type", "cycle.transitioned");
  if (error) throw new Error(`countAudit: ${error.message}`);
  return count ?? 0;
}

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  // ON DELETE RESTRICT on all FKs — clean up children first.
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "promote_cycle_on_advance (3.3) — skip when Supabase env not set",
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
    name: "advance INSERT on active cycle → status flips + cycle.transitioned audit fires",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "trans1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        // Pre-condition: cycle is active, no cycle.transitioned events yet.
        assertEquals(await getCycleStatus(service, cycleId), "active");
        assertEquals(await getCycleTransitionedCount(service, cycleId), 0);

        await insertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "advance",
          cycleDay: 5,
        });

        assertEquals(await getCycleStatus(service, cycleId), "with_advance");
        assertEquals(await getCycleTransitionedCount(service, cycleId), 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "second advance on with_advance cycle is idempotent (no extra audit row)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "trans2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        // First advance — promotes the cycle.
        await insertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "advance",
          cycleDay: 5,
        });
        assertEquals(await getCycleStatus(service, cycleId), "with_advance");
        assertEquals(await getCycleTransitionedCount(service, cycleId), 1);

        // Second advance — must be a no-op for status + audit.
        await insertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "advance",
          cycleDay: 6,
        });
        assertEquals(await getCycleStatus(service, cycleId), "with_advance");
        assertEquals(await getCycleTransitionedCount(service, cycleId), 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "contribution on active cycle is a no-op (status stays active, no transition audit)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "trans3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        await insertTransaction(service, {
          collectorId: c.userId,
          memberId,
          cycleId,
          kind: "contribution",
          cycleDay: 1,
        });

        assertEquals(await getCycleStatus(service, cycleId), "active");
        assertEquals(await getCycleTransitionedCount(service, cycleId), 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  // NOTE — Story 3.3's "advance on completed cycle is a no-op" test was
  // removed in Story 3.4. The Story 3.4 BEFORE INSERT trigger
  // (reject_transaction_on_closed_cycle) now rejects the INSERT with
  // sqlstate 23514 BEFORE this story's AFTER trigger fires, so the no-op
  // behaviour can no longer be observed from the application layer. The
  // equivalent contract is now asserted in
  // reject-transaction-on-closed-cycle.contract.test.ts (Story 3.4).
  Deno.test({
    name: "(Story 3.4) — advance on completed cycle is REJECTED upstream (see reject-transaction-on-closed-cycle.contract.test.ts)",
    ignore: true,
    fn: () => {
      // Intentionally a no-op test kept as a discoverability marker.
      // Delete this stub when the Story 3.3/3.4 transition is well-established.
    },
  });
}

// Suppress the linter on the placeholder helper — it's left in case
// callers prefer the typed form over the generic count() pattern.
void countCycleTransitionedEvents;
