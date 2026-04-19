// NFR-S5 release-gate test: per-collector RLS isolation.
//
// This spec runs against a Supabase instance (local Docker stack via
// `supabase start`, or the linked cloud project). It bypasses the dev server
// — `webServer` is only used by the smoke spec; this file talks directly to
// Supabase via @supabase/supabase-js.
//
// Required env (read from .env.local at runtime via `dotenv` config in
// playwright.config.ts when this story's Phase 2/3 lands):
//   - SUPABASE_TEST_URL              (defaults to http://127.0.0.1:54321 for local)
//   - SUPABASE_TEST_ANON_KEY
//   - SUPABASE_TEST_SERVICE_ROLE_KEY (used to seed two collector accounts)
//
// Failing this test must block merge — wired with continue-on-error: false in
// the CI workflow.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const SUPABASE_URL = process.env["SUPABASE_TEST_URL"] ?? "http://127.0.0.1:54321";
const SUPABASE_ANON_KEY = process.env["SUPABASE_TEST_ANON_KEY"] ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_TEST_SERVICE_ROLE_KEY"] ?? "";

// In CI this gate MUST run — silently skipping defeats the NFR-S5 release
// gate the story exists to install. The CI workflow starts a local Supabase
// stack and passes the well-known anon/service-role keys via env. If those
// vars are missing in CI, fail loudly so the workflow is fixed instead of
// silently letting an RLS regression through.
if (process.env["CI"] === "true" && (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error(
    "CI=true but SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_ROLE_KEY are not set. " +
      "The RLS isolation release gate cannot be skipped in CI. " +
      "Wire the local Supabase stack in .github/workflows/ci.yml.",
  );
}

type SeededCollector = {
  email: string;
  password: string;
  userId: string;
  memberIds: string[];
  cycleIds: string[];
  transactionIds: string[];
};

async function seedCollector(
  serviceClient: SupabaseClient,
  label: "A" | "B",
): Promise<SeededCollector> {
  const email = `collector-${label.toLowerCase()}-${Date.now()}@safaricash-test.local`;
  const password = `Test${label}-${Math.random().toString(36).slice(2, 12)}!`;

  // Create the auth user via service-role admin API.
  const { data: authData, error: authError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`createUser(${label}): ${authError?.message ?? "no user"}`);
  }
  const userId = authData.user.id;

  // Insert the public.users profile row (collector role).
  // Wider entropy than 4 random digits to avoid UNIQUE collisions under
  // CI parallelism / retry. crypto.randomUUID returns 32 hex chars; first 9
  // give us 36 bits of entropy fitting a +221 mobile number length.
  const phone = `+22177${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`;
  const { error: usersError } = await serviceClient.from("users").insert({
    id: userId,
    phone_number: phone,
    role: "collector",
  });
  if (usersError) throw new Error(`insert users(${label}): ${usersError.message}`);

  // Seed 3 members (using vault_encrypt RPC for the encrypted columns).
  const memberIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { data: nameSecret, error: nameSecretErr } = await serviceClient.rpc("vault_encrypt", {
      plaintext: `Member ${label}-${i + 1}`,
    });
    if (nameSecretErr || !nameSecret) {
      throw new Error(`vault_encrypt(name) returned no secret_id: ${nameSecretErr?.message}`);
    }
    const { data: phoneSecret, error: phoneSecretErr } = await serviceClient.rpc("vault_encrypt", {
      plaintext: `+221770111${i}${i}${i}${i}`,
    });
    if (phoneSecretErr || !phoneSecret) {
      throw new Error(`vault_encrypt(phone) returned no secret_id: ${phoneSecretErr?.message}`);
    }
    const { data: member, error } = await serviceClient
      .from("members")
      .insert({
        collector_id: userId,
        name_encrypted: nameSecret,
        phone_number_encrypted: phoneSecret,
        daily_amount: 500,
        status: "active",
      })
      .select("id")
      .single();
    if (error || !member) throw new Error(`insert members(${label}, ${i}): ${error?.message}`);
    memberIds.push(member.id);
  }

  // Seed 3 cycles (one per member) and 3 transactions (one per cycle).
  const cycleIds: string[] = [];
  const transactionIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const memberId = memberIds[i] as string;
    const { data: cycle, error: cycleErr } = await serviceClient
      .from("cycles")
      .insert({
        collector_id: userId,
        member_id: memberId,
        cycle_number: 1,
        start_date: "2026-04-19",
        end_date: "2026-05-18",
        status: "active",
      })
      .select("id")
      .single();
    if (cycleErr || !cycle) throw new Error(`insert cycles(${label}, ${i}): ${cycleErr?.message}`);
    cycleIds.push(cycle.id);

    const { data: amountSecret } = await serviceClient.rpc("vault_encrypt", {
      plaintext: "500",
    });
    const { data: tx, error: txErr } = await serviceClient
      .from("transactions")
      .insert({
        collector_id: userId,
        member_id: memberId,
        cycle_id: cycle.id,
        kind: "contribution",
        amount_encrypted: amountSecret,
        cycle_day: 1,
        source: "online",
      })
      .select("id")
      .single();
    if (txErr || !tx) throw new Error(`insert transactions(${label}, ${i}): ${txErr?.message}`);
    transactionIds.push(tx.id);
  }

  return { email, password, userId, memberIds, cycleIds, transactionIds };
}

test.describe("RLS per-collector isolation (NFR-S5 release gate)", () => {
  // Tests share seeded collector accounts via beforeAll/afterAll. Must run
  // serially in a single worker so the seed is created once and torn down
  // once — `fullyParallel: true` in playwright.config.ts would otherwise
  // re-run beforeAll per test in separate workers and race on auth user
  // creation.
  test.describe.configure({ mode: "serial" });

  test.skip(
    !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_TEST_ANON_KEY + SUPABASE_TEST_SERVICE_ROLE_KEY required (set via .env.local for local Supabase, or in CI secrets)",
  );

  let serviceClient: SupabaseClient;
  let collectorA: SeededCollector;
  let collectorB: SeededCollector;

  test.beforeAll(async () => {
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    collectorA = await seedCollector(serviceClient, "A");
    collectorB = await seedCollector(serviceClient, "B");
  });

  test.afterAll(async () => {
    if (collectorA?.userId) {
      await serviceClient.auth.admin.deleteUser(collectorA.userId);
    }
    if (collectorB?.userId) {
      await serviceClient.auth.admin.deleteUser(collectorB.userId);
    }
  });

  test("collector A reads only collector A's rows", async () => {
    const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await clientA.auth.signInWithPassword({
      email: collectorA.email,
      password: collectorA.password,
    });
    expect(signInErr).toBeNull();

    for (const table of ["members", "cycles", "transactions"] as const) {
      const { data, error } = await clientA.from(table).select("collector_id");
      expect(error, `select ${table}: ${error?.message}`).toBeNull();
      // Non-tautological assertion: the seed inserted 3 rows per collector
      // for these tables. If RLS were misconfigured to return ZERO rows,
      // the previous "filter == data" check would pass vacuously. Confirm
      // we actually got our rows back.
      expect(data!.length, `${table}: expected exactly 3 rows for collector A`).toBe(3);
      for (const row of data!) {
        expect(row.collector_id).toBe(collectorA.userId);
      }
    }
    // sms_queue and disputes weren't seeded by this test — assert empty
    // (RLS still applies; collector A should see 0 of B's hypothetical rows).
    for (const table of ["sms_queue", "disputes"] as const) {
      const { data, error } = await clientA.from(table).select("collector_id");
      expect(error, `select ${table}: ${error?.message}`).toBeNull();
      for (const row of data ?? []) {
        expect(row.collector_id).toBe(collectorA.userId);
      }
    }

    // audit_log: collector A may SELECT only their own chain.
    const { data: auditRows, error: auditErr } = await clientA
      .from("audit_log")
      .select("collector_id");
    expect(auditErr).toBeNull();
    for (const row of auditRows ?? []) {
      expect(row.collector_id).toBe(collectorA.userId);
    }
  });

  test("collector A cannot UPDATE collector B's member row (RLS filter)", async () => {
    const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await clientA.auth.signInWithPassword({
      email: collectorA.email,
      password: collectorA.password,
    });

    const targetMember = collectorB.memberIds[0] as string;
    const { data, error } = await clientA
      .from("members")
      .update({ daily_amount: 9999 })
      .eq("id", targetMember)
      .select();

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0); // RLS filtered the row out — no rows updated.

    // Sanity: collector B's row is untouched.
    const { data: untouched } = await serviceClient
      .from("members")
      .select("daily_amount")
      .eq("id", targetMember)
      .single();
    expect(untouched?.daily_amount).toBe(500);
  });

  test("collector A cannot DELETE collector B's member row", async () => {
    const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await clientA.auth.signInWithPassword({
      email: collectorA.email,
      password: collectorA.password,
    });

    const targetMember = collectorB.memberIds[0] as string;
    const { data, error } = await clientA.from("members").delete().eq("id", targetMember).select();

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0); // RLS filter — zero rows deleted.

    const { data: stillThere } = await serviceClient
      .from("members")
      .select("id")
      .eq("id", targetMember)
      .single();
    expect(stillThere?.id).toBe(targetMember);
  });

  test("authenticated client cannot INSERT into audit_log directly", async () => {
    const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await clientA.auth.signInWithPassword({
      email: collectorA.email,
      password: collectorA.password,
    });

    const { error } = await clientA.from("audit_log").insert({
      event_id: "00000000-0000-4000-8000-000000000099",
      event_type: "member.created",
      collector_id: collectorA.userId,
      entity_id: collectorA.memberIds[0],
      entity_table: "members",
      timestamp: new Date().toISOString(),
      actor: collectorA.userId,
      source: "online",
      payload: {},
      entry_hash: "\\x00",
    });

    // PostgREST returns an error (REVOKE + no policy). Even if it didn't
    // (Supabase silently no-op), confirm zero rows landed via a service-role
    // count query — this is the binding gate.
    expect(error).not.toBeNull();
    const { count } = await serviceClient
      .from("audit_log")
      .select("*", { count: "exact", head: true })
      .eq("event_id", "00000000-0000-4000-8000-000000000099");
    expect(count, "audit_log INSERT must NOT have landed").toBe(0);
  });
});
