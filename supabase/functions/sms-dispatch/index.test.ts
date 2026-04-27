// Story 6.1 — sms-dispatch Edge Function contract tests.
//
// Spawns the Edge Function via `supabase functions serve` (assumed to
// be running on the local stack at http://127.0.0.1:54321/functions/v1).
// Asserts:
//   1. Happy path — authenticated POST → 200 + new sms_queue row +
//      audit_log sms.queued event lands.
//   2. Foreign collector → 404.
//   3. Missing JWT → 401.
//   4. Wrong method (GET) → 405.
//   5. Malformed body → 400.
//   6. Unknown transaction_id → 404.
//   7. Re-send creates a NEW row (not idempotent).
//   8. Cash-only saver → 200 + skipped, no row inserted.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

type PhoneCollector = {
  userId: string;
  phone: string;
  password: string;
  jwt: string;
};

function envOrSkip(): {
  url: string;
  anonKey: string;
  serviceKey: string;
  fnUrl: string;
} | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey, fnUrl: `${url}/functions/v1/sms-dispatch` };
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
  phoneNumber = "+221770000666",
): Promise<{ memberId: string; cycleId: string }> {
  const { data: memberId, error: createErr } = await userClient.rpc("create_member_with_cycle", {
    p_name: "Test Member",
    p_phone_number: phoneNumber,
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

async function recordContrib(
  userClient: SupabaseClient,
  memberId: string,
  cycleId: string,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: 500,
    p_cycle_day: 1,
  });
  if (error || !txId) throw new Error(`record_contribution: ${error?.message}`);
  return txId as string;
}

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.from("transactions").delete().eq("collector_id", c.userId);
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "sms-dispatch (6.1 Edge) — skip when env not set",
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
    name: "happy path — POST → 200 + new sms_queue row + audit sms.queued event",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ed1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        // Baseline row count for this transaction (the trigger inserts 1).
        const { count: countBefore } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(countBefore, 1);

        const res = await fetch(env.fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${c.jwt}`,
          },
          body: JSON.stringify({ transaction_id: txId }),
        });
        assertEquals(res.status, 200);
        const json = await res.json();
        assert(typeof json.queue_id === "string");

        // Now there should be 2 rows for this transaction (trigger + dispatch).
        const { count: countAfter } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(countAfter, 2);

        // Audit sms.queued event lands.
        const { count: auditCount } = await service
          .from("audit_log")
          .select("event_id", { count: "exact", head: true })
          .eq("entity_id", json.queue_id)
          .eq("event_type", "sms.queued");
        assertEquals(auditCount, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "foreign collector — 404",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ownerC = await seedCollector(service, anon, "ed2o");
      const intruderC = await seedCollector(service, anon, "ed2i");
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
        const txId = await recordContrib(ownerClient, memberId, cycleId);

        const res = await fetch(env.fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${intruderC.jwt}`,
          },
          body: JSON.stringify({ transaction_id: txId }),
        });
        assertEquals(res.status, 404);
      } finally {
        await cleanup(service, ownerC);
        await cleanup(service, intruderC);
      }
    },
  });

  Deno.test({
    name: "missing JWT — 401",
    ...denoOpts,
    fn: async () => {
      const res = await fetch(env.fnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction_id: "00000000-0000-4000-8000-000000000000" }),
      });
      assertEquals(res.status, 401);
    },
  });

  Deno.test({
    name: "wrong method (GET) — 405 (with auth, since Supabase Kong gateway rejects unauthenticated requests with 401 before the function runs)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ed4");
      try {
        const res = await fetch(env.fnUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${c.jwt}` },
        });
        assertEquals(res.status, 405);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "malformed body — 400",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ed5");
      try {
        const res = await fetch(env.fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${c.jwt}`,
          },
          body: JSON.stringify({}), // missing transaction_id
        });
        assertEquals(res.status, 400);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "unknown transaction_id — 404",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ed6");
      try {
        const res = await fetch(env.fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${c.jwt}`,
          },
          body: JSON.stringify({ transaction_id: "00000000-0000-4000-8000-000000000000" }),
        });
        assertEquals(res.status, 404);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "re-send creates a NEW row (not idempotent)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ed7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        // Two consecutive POSTs.
        await fetch(env.fnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.jwt}` },
          body: JSON.stringify({ transaction_id: txId }),
        });
        await fetch(env.fnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.jwt}` },
          body: JSON.stringify({ transaction_id: txId }),
        });

        // 1 trigger row + 2 dispatch rows = 3 total for this tx.
        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(count, 3);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "cash-only saver — 200 + skipped, no row inserted",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ed8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // Member created with empty phone.
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId, "");
        const txId = await recordContrib(userClient, memberId, cycleId);

        const res = await fetch(env.fnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.jwt}` },
          body: JSON.stringify({ transaction_id: txId }),
        });
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.skipped, true);

        // No sms_queue row at all (trigger skipped + dispatch skipped).
        const { count } = await service
          .from("sms_queue")
          .select("id", { count: "exact", head: true })
          .eq("transaction_id", txId);
        assertEquals(count, 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
