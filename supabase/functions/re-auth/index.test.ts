// Story 1.5b — Re-auth Edge Function tests (password flow).
//
// PRD v1.3 auth pivot. Runs against LIVE cloud Supabase (linked via
// supabase-cli). Each test seeds a phone+password collector via
// admin.createUser and cleans up afterwards.
//
// Run: ./scripts/run-edge-tests.sh  (or npm run test:edge)
//
// Env (from .env.local via the wrapper):
//   SUPABASE_URL                / SUPABASE_TEST_URL
//   SUPABASE_ANON_KEY           / SUPABASE_TEST_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY   / SUPABASE_TEST_SERVICE_ROLE_KEY

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { handler } from "./index.ts";

// ---------------------------------------------------------------------------
// Test fixture — phone+password collector, disposable per test run.
// ---------------------------------------------------------------------------

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

async function seedPhonePasswordCollector(
  service: SupabaseClient,
  anon: SupabaseClient,
  label: string,
): Promise<PhoneCollector> {
  const stamp = Date.now();
  // E.164 Senegal mobile needs DIGITS only — crypto.randomUUID() returns
  // hex (includes a-f) and would fail the phone validator. Generate 7
  // random digits from a Uint8Array.
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
  if (error || !data.user) {
    throw new Error(`seed(${label}): admin.createUser failed — ${error?.message}`);
  }
  const userId = data.user.id;

  const { error: usersErr } = await service
    .from("users")
    .insert({ id: userId, phone_number: phone, role: "collector" });
  if (usersErr) {
    await service.auth.admin.deleteUser(userId);
    throw new Error(`seed(${label}): users insert failed — ${usersErr.message}`);
  }

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    phone,
    password,
  });
  if (signInErr || !signIn.session?.access_token) {
    await service.auth.admin.deleteUser(userId);
    throw new Error(`seed(${label}): signIn failed — ${signInErr?.message}`);
  }

  return { userId, phone, password, jwt: signIn.session.access_token };
}

async function cleanup(service: SupabaseClient, c: PhoneCollector): Promise<void> {
  await service.auth.admin.deleteUser(c.userId);
}

function buildReq(jwt: string | null, body: unknown, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  return new Request("https://safaricash-test.local/functions/v1/re-auth", {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const env = envOrSkip();

Deno.test({
  name: "re-auth (1.5b) — skip when Supabase env not set",
  ignore: !!env,
  fn: () => {
    console.log(
      "SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY not set — skipping integration tests.",
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

  Deno.test("POST with valid JWT + correct password → 200 { ok: true, scope }", async () => {
    const c = await seedPhonePasswordCollector(service, anon, "ok");
    try {
      const res = await handler(
        buildReq(c.jwt, { password: c.password, operation_intent: "member_delete" }),
      );
      assertEquals(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assertEquals(body.ok, true);
      assertEquals(body.scope, "member_delete");
    } finally {
      await cleanup(service, c);
    }
  });

  Deno.test("POST with valid JWT + wrong password → 401 credentials_invalid", async () => {
    const c = await seedPhonePasswordCollector(service, anon, "bad");
    try {
      const res = await handler(
        buildReq(c.jwt, { password: "totally-wrong", operation_intent: "csv_export" }),
      );
      assertEquals(res.status, 401);
      const body = (await res.json()) as Record<string, unknown>;
      assert((body.type as string).includes("credentials/invalid"));
    } finally {
      await cleanup(service, c);
    }
  });

  Deno.test("POST without Authorization header → 401 auth_unauthenticated", async () => {
    const res = await handler(
      buildReq(null, { password: "anything", operation_intent: "cycle_settlement" }),
    );
    assertEquals(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert((body.type as string).includes("auth/unauthenticated"));
  });

  Deno.test("POST with bogus JWT → 401 auth_unauthenticated", async () => {
    const res = await handler(
      buildReq("bogus.jwt.value", { password: "x", operation_intent: "cycle_settlement" }),
    );
    assertEquals(res.status, 401);
  });

  Deno.test("POST with missing operation_intent → 400 request_invalid", async () => {
    const c = await seedPhonePasswordCollector(service, anon, "req");
    try {
      const res = await handler(buildReq(c.jwt, { password: c.password }));
      assertEquals(res.status, 400);
      const body = (await res.json()) as Record<string, unknown>;
      assert((body.type as string).includes("request/invalid"));
    } finally {
      await cleanup(service, c);
    }
  });

  Deno.test("POST with unknown operation_intent → 400 request_invalid", async () => {
    const c = await seedPhonePasswordCollector(service, anon, "op");
    try {
      const res = await handler(
        buildReq(c.jwt, { password: c.password, operation_intent: "nuclear_launch" }),
      );
      assertEquals(res.status, 400);
    } finally {
      await cleanup(service, c);
    }
  });

  Deno.test("GET method → 400 request_invalid + Allow: POST", async () => {
    const res = await handler(buildReq(null, {}, "GET"));
    assertEquals(res.status, 400);
    assertEquals(res.headers.get("Allow"), "POST");
  });
}
