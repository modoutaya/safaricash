// Story 2.2 — create_member_with_cycle RPC contract test.
//
// Runs against LIVE cloud/local Supabase. Env-gated same as the Story 1.5b
// re-auth tests. Seeds a phone+password collector inline, signs in to
// obtain a JWT, invokes the RPC, asserts both inserts landed + the audit
// event fired.

import { assertEquals, assertExists } from "jsr:@std/assert@1";
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

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  // ON DELETE RESTRICT on all FKs — clean up children first.
  await service.from("cycles").delete().eq("collector_id", c.userId);
  await service.from("members").delete().eq("collector_id", c.userId);
  await service.auth.admin.deleteUser(c.userId);
}

const env = envOrSkip();

Deno.test({
  name: "create_member_with_cycle (2.2) — skip when Supabase env not set",
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
    name: "valid call inserts member + day-1 cycle + audit event",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "ok");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { data: memberId, error: rpcErr } = await userClient.rpc("create_member_with_cycle", {
          p_name: "Awa Diallo",
          p_phone_number: "+221777915899",
          p_daily_amount: 500,
        });
        assertEquals(rpcErr, null);
        assertExists(memberId);

        const { data: member } = await service
          .from("members")
          .select("id, collector_id, daily_amount, status, created_via")
          .eq("id", memberId as string)
          .maybeSingle();
        assertExists(member);
        assertEquals(member!.collector_id, c.userId);
        assertEquals(Number(member!.daily_amount), 500);
        assertEquals(member!.status, "active");
        assertEquals(member!.created_via, "manual");

        const { data: cycle } = await service
          .from("cycles")
          .select("cycle_number, status, member_id")
          .eq("member_id", memberId as string)
          .maybeSingle();
        assertExists(cycle);
        assertEquals(cycle!.cycle_number, 1);
        assertEquals(cycle!.status, "active");

        const { data: audit } = await service
          .from("audit_log")
          .select("event_type, entity_id")
          .eq("entity_id", memberId as string)
          .eq("event_type", "member.created")
          .maybeSingle();
        assertExists(audit);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "empty phone is accepted and stored as encrypted empty string",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "nophone");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { data: memberId, error } = await userClient.rpc("create_member_with_cycle", {
          p_name: "Cash Only",
          p_phone_number: "",
          p_daily_amount: 200,
        });
        assertEquals(error, null);
        assertExists(memberId);

        const { data: decrypted } = await service
          .from("members_decrypted")
          .select("name, phone_number")
          .eq("id", memberId as string)
          .maybeSingle();
        assertExists(decrypted);
        assertEquals(decrypted!.name, "Cash Only");
        assertEquals(decrypted!.phone_number, "");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "invalid_amount (≤0) raises 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "amt");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { data, error } = await userClient.rpc("create_member_with_cycle", {
          p_name: "Nope",
          p_phone_number: "",
          p_daily_amount: 0,
        });
        assertEquals(data, null);
        assertExists(error);
        // Message contains our "invalid_amount" prefix.
        const msg = (error!.message ?? "").toLowerCase();
        assertEquals(msg.includes("invalid_amount"), true);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "anonymous caller is rejected (auth_required)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.rpc("create_member_with_cycle", {
        p_name: "Nobody",
        p_phone_number: "",
        p_daily_amount: 100,
      });
      assertEquals(data, null);
      assertExists(error);
    },
  });
}
