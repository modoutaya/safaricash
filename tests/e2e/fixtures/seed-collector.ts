// Story 1.8 — shared Playwright fixture for seeding an authenticated collector
// and pre-minting the Supabase-js session in localStorage BEFORE the page
// loads. Refactored out of tests/e2e/rls-isolation.spec.ts so both the
// RLS gate and the session-dependent E2E specs (flow-5-signout,
// session-idle-timeout, flow-5-login OTP-verify) reuse the SAME helper —
// a copy would drift.
//
// Storage-key contract (supabase-js v2):
//   key = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`
//   value = JSON.stringify(Session)  — plain Session object, no wrapper.
// See node_modules/@supabase/supabase-js/src/SupabaseClient.ts:294 and
// node_modules/@supabase/auth-js/src/lib/helpers.ts:124-130.
//
// The `seededCollector` fixture auto-seeds a fresh collector before each
// test AND cleans up via service-role `auth.admin.deleteUser` in teardown,
// mirroring the pattern from rls-isolation.spec.ts.

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { test as base, type Page } from "@playwright/test";

const SUPABASE_URL = process.env["SUPABASE_TEST_URL"] ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env["SUPABASE_TEST_ANON_KEY"] ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_TEST_SERVICE_ROLE_KEY"] ?? "";

export type SeededCollector = {
  email: string;
  password: string;
  userId: string;
  session: Session;
};

export type MemberSeed = {
  memberId: string;
  cycleId: string;
  transactionId: string;
};

/** Build a service-role client. Throws if test env is missing. */
export function buildServiceClient(): SupabaseClient {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_TEST_SERVICE_ROLE_KEY required — set in .env.local or via CI env.");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Build an anon client (used to obtain a fresh JWT via signInWithPassword). */
export function buildAnonClient(): SupabaseClient {
  if (!SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_TEST_ANON_KEY required — set in .env.local or via CI env.");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Derive the supabase-js localStorage key for the test Supabase URL.
 *  Matches supabase-js SupabaseClient constructor:
 *    `sb-${new URL(url).hostname.split('.')[0]}-auth-token` */
export function deriveStorageKey(url: string = SUPABASE_URL): string {
  const host = new URL(url).hostname;
  const ref = host.split(".")[0];
  return `sb-${ref}-auth-token`;
}

/** Create a fresh collector (auth.users + public.users) and sign them in to
 *  obtain a Session. Each call generates a unique email / phone. Caller is
 *  responsible for cleanup via `cleanupCollector`. */
export async function seedCollectorViaAdmin(
  service: SupabaseClient,
  anon: SupabaseClient,
  label = "E2E",
): Promise<SeededCollector> {
  const stamp = Date.now();
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const email = `${label.toLowerCase()}-${stamp}-${rand}@safaricash-test.local`;
  const password = `Pwd-${label}-${rand}-${stamp}`;
  // +221 + 9 digits; first two fixed to "77" (valid Senegalese mobile prefix),
  // remaining 7 random. Wide entropy avoids UNIQUE collisions under parallel
  // CI runs.
  const phone = `+22177${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`;

  const { data: authData, error: authError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`seedCollectorViaAdmin(${label}): createUser — ${authError?.message}`);
  }
  const userId = authData.user.id;

  const { error: usersError } = await service.from("users").insert({
    id: userId,
    phone_number: phone,
    role: "collector",
  });
  if (usersError) {
    throw new Error(`seedCollectorViaAdmin(${label}): users insert — ${usersError.message}`);
  }

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr || !signIn.session) {
    throw new Error(`seedCollectorViaAdmin(${label}): signIn — ${signInErr?.message}`);
  }

  return { email, password, userId, session: signIn.session };
}

/** Seed N members + one cycle + one transaction per member for the given
 *  collector. Used by rls-isolation.spec.ts and by Epic 2+ E2Es that need
 *  pre-populated data. Uses the vault_encrypt RPC pattern shared with
 *  migration 0005. */
export async function seedMembersForCollector(
  service: SupabaseClient,
  collector: SeededCollector,
  count: number,
  label = "M",
): Promise<MemberSeed[]> {
  const seeds: MemberSeed[] = [];
  for (let i = 0; i < count; i++) {
    const { data: nameSecret, error: nameErr } = await service.rpc("vault_encrypt", {
      plaintext: `Member ${label}-${i + 1}`,
    });
    if (nameErr || !nameSecret) {
      throw new Error(`vault_encrypt(name) — ${nameErr?.message ?? "no secret_id"}`);
    }
    const { data: phoneSecret, error: phoneErr } = await service.rpc("vault_encrypt", {
      plaintext: `+221770111${i}${i}${i}${i}`,
    });
    if (phoneErr || !phoneSecret) {
      throw new Error(`vault_encrypt(phone) — ${phoneErr?.message ?? "no secret_id"}`);
    }

    const { data: member, error: memberErr } = await service
      .from("members")
      .insert({
        collector_id: collector.userId,
        name_encrypted: nameSecret,
        phone_number_encrypted: phoneSecret,
        daily_amount: 500,
        status: "active",
      })
      .select("id")
      .single();
    if (memberErr || !member) {
      throw new Error(`insert members(${label}, ${i}) — ${memberErr?.message}`);
    }

    const { data: cycle, error: cycleErr } = await service
      .from("cycles")
      .insert({
        collector_id: collector.userId,
        member_id: member.id,
        cycle_number: 1,
        start_date: "2026-04-19",
        end_date: "2026-05-18",
        status: "active",
      })
      .select("id")
      .single();
    if (cycleErr || !cycle) {
      throw new Error(`insert cycles(${label}, ${i}) — ${cycleErr?.message}`);
    }

    const { data: amountSecret } = await service.rpc("vault_encrypt", { plaintext: "500" });
    const { data: tx, error: txErr } = await service
      .from("transactions")
      .insert({
        collector_id: collector.userId,
        member_id: member.id,
        cycle_id: cycle.id,
        kind: "contribution",
        amount_encrypted: amountSecret,
        cycle_day: 1,
        source: "online",
      })
      .select("id")
      .single();
    if (txErr || !tx) {
      throw new Error(`insert transactions(${label}, ${i}) — ${txErr?.message}`);
    }

    seeds.push({ memberId: member.id, cycleId: cycle.id, transactionId: tx.id });
  }
  return seeds;
}

/** Clean up a seeded collector — deletes the auth user (CASCADE removes the
 *  public.users row + members + cycles + transactions via FK). */
export async function cleanupCollector(
  service: SupabaseClient,
  collector: SeededCollector,
): Promise<void> {
  await service.auth.admin.deleteUser(collector.userId);
}

/** Write the collector's session into localStorage BEFORE the page loads —
 *  supabase-js's PublicRoute-side `getSession()` must find it on the first
 *  render, otherwise `ProtectedRoute` redirects to /login and the spec's
 *  premise collapses.
 *
 *  Must be called AFTER the page is created but BEFORE `page.goto()`. */
export async function mintAuthenticatedSession(
  page: Page,
  collector: SeededCollector,
  url: string = SUPABASE_URL,
): Promise<void> {
  const storageKey = deriveStorageKey(url);
  const sessionJson = JSON.stringify(collector.session);
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: sessionJson },
  );
}

/** Playwright fixture — auto-seeds a collector + mints a session on `page`
 *  before each test AND cleans up in teardown. Consume it by destructuring:
 *
 *    import { test, expect } from "./fixtures/seed-collector";
 *    test("my auth flow", async ({ page, seededCollector }) => { ... });
 *
 *  If `SUPABASE_TEST_SEED_READY` is not "1", the fixture throws — specs that
 *  depend on it should EITHER (a) set `test.skip(!CAN_SEED, ...)` at the
 *  describe level BEFORE the fixture resolves, OR (b) run only in CI where
 *  the flag is wired. */
const CAN_SEED = process.env["SUPABASE_TEST_SEED_READY"] === "1";

export const test = base.extend<{ seededCollector: SeededCollector }>({
  seededCollector: async ({ page }, use) => {
    if (!CAN_SEED) {
      throw new Error(
        "seededCollector fixture requires SUPABASE_TEST_SEED_READY=1 (plus SUPABASE_TEST_URL + SUPABASE_TEST_ANON_KEY + SUPABASE_TEST_SERVICE_ROLE_KEY). " +
          "Add a `test.skip(!CAN_SEED, ...)` guard at the spec level, or run in CI where Story 1.8 wires the flag.",
      );
    }
    const service = buildServiceClient();
    const anon = buildAnonClient();
    const collector = await seedCollectorViaAdmin(service, anon, "E2E");
    await mintAuthenticatedSession(page, collector);
    try {
      await use(collector);
    } finally {
      await cleanupCollector(service, collector);
    }
  },
});

export { expect } from "@playwright/test";

/** Exposed so specs can early-skip on local dev without the env wired. */
export const E2E_SEED_READY = CAN_SEED;
