// Test fixtures for Edge Function Deno tests.
//
// USAGE: Tests import these helpers to spin up a service-role client,
// seed a fresh collector, and capture Termii dispatches via a mock fetch.
//
// The helpers run against the LIVE cloud Supabase (linked via supabase-cli)
// — no local Docker stack required. Each test seeds a unique collector
// (timestamp + crypto.randomUUID) and cleans up in afterAll/afterEach.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type SeededCollector = {
  email: string;
  password: string;
  userId: string;
  jwt: string;
  phone: string;
};

/** Build a service-role client from test env. Required env: SUPABASE_TEST_URL,
 *  SUPABASE_TEST_SERVICE_ROLE_KEY. */
export function buildTestServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_TEST_URL");
  const key = Deno.env.get("SUPABASE_TEST_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Build an anon client from test env (used to obtain a JWT via signInWithPassword). */
export function buildTestAnonClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_TEST_URL");
  const key = Deno.env.get("SUPABASE_TEST_ANON_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY must be set");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Seeds a fresh collector account (auth.users + public.users) and returns
 *  the active JWT for HTTP calls. Each call generates unique email/phone. */
export async function seedCollector(
  service: SupabaseClient,
  anon: SupabaseClient,
  label = "T",
): Promise<SeededCollector> {
  const stamp = Date.now();
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const email = `reauth-${label}-${stamp}-${rand}@safaricash-test.local`;
  const password = `Pwd-${label}-${rand}-${stamp}`;
  const phone = `+22177${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`;

  const { data: authData, error: authErr } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authErr || !authData.user) {
    throw new Error(`seedCollector(${label}): admin.createUser failed — ${authErr?.message}`);
  }
  const userId = authData.user.id;

  const { error: usersErr } = await service.from("users").insert({
    id: userId,
    phone_number: phone,
    role: "collector",
  });
  if (usersErr) {
    throw new Error(`seedCollector(${label}): users insert failed — ${usersErr.message}`);
  }

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !signIn.session?.access_token) {
    throw new Error(`seedCollector(${label}): signInWithPassword failed — ${signInErr?.message}`);
  }

  return {
    email,
    password,
    userId,
    phone,
    jwt: signIn.session.access_token,
  };
}

export async function cleanupCollector(service: SupabaseClient, c: SeededCollector): Promise<void> {
  await service.auth.admin.deleteUser(c.userId);
}

/** Records every fetch call made during the test's scope.
 *  Pattern:
 *    const recorder = installFetchRecorder({ url: 'api.ng.termii.com', responder: () => ... });
 *    ... run code that calls fetch ...
 *    recorder.uninstall();
 *    expect(recorder.calls).toHaveLength(1);
 */
export type RecordedCall = {
  url: string;
  method: string;
  body: string | null;
};

export type FetchRecorder = {
  calls: RecordedCall[];
  uninstall: () => void;
};

export function installFetchRecorder(opts: {
  matchUrl: (url: string) => boolean;
  responder: (call: RecordedCall) => Response | Promise<Response>;
}): FetchRecorder {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: string | null = null;
    if (init?.body) {
      body = typeof init.body === "string" ? init.body : await new Response(init.body).text();
    }
    if (opts.matchUrl(url)) {
      const call: RecordedCall = { url, method, body };
      calls.push(call);
      return Promise.resolve(opts.responder(call));
    }
    return original(input as RequestInfo, init);
  };
  return {
    calls,
    uninstall: () => {
      globalThis.fetch = original;
    },
  };
}

/** Extract the OTP digits from the canonical SMS body. The Edge Function
 *  body template is "Code SafariCash: NNNNNN — valide N min."  */
export function extractOtpFromSmsBody(body: string): string {
  const m = body.match(/(\d{6})/);
  if (!m) throw new Error(`extractOtpFromSmsBody: no 6-digit OTP found in: ${body}`);
  return m[1];
}
