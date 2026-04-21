// NFR-S5 release-gate test: per-collector RLS isolation.
//
// This spec runs against a Supabase instance (local Docker stack via
// `supabase start`, or the linked cloud project). It bypasses the dev server
// — `webServer` is only used by the smoke spec; this file talks directly to
// Supabase via @supabase/supabase-js.
//
// No UI — axe-core excluded from this spec (Story 1.8 AC 4).
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

import {
  buildServiceClient,
  buildAnonClient,
  cleanupCollector,
  seedCollectorViaAdmin,
  seedMembersForCollector,
  type SeededCollector,
  type MemberSeed,
} from "./fixtures/seed-collector";

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

type RlsFixture = { collector: SeededCollector; members: MemberSeed[] };

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
  let collectorA: RlsFixture;
  let collectorB: RlsFixture;

  test.beforeAll(async () => {
    serviceClient = buildServiceClient();
    const anon = buildAnonClient();
    const seededA = await seedCollectorViaAdmin(serviceClient, anon, "A");
    const seededB = await seedCollectorViaAdmin(serviceClient, anon, "B");
    const membersA = await seedMembersForCollector(serviceClient, seededA, 3, "A");
    const membersB = await seedMembersForCollector(serviceClient, seededB, 3, "B");
    collectorA = { collector: seededA, members: membersA };
    collectorB = { collector: seededB, members: membersB };
  });

  test.afterAll(async () => {
    if (collectorA?.collector?.userId) {
      await cleanupCollector(serviceClient, collectorA.collector);
    }
    if (collectorB?.collector?.userId) {
      await cleanupCollector(serviceClient, collectorB.collector);
    }
  });

  test("collector A reads only collector A's rows", async () => {
    const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await clientA.auth.signInWithPassword({
      email: collectorA.collector.email,
      password: collectorA.collector.password,
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
        expect(row.collector_id).toBe(collectorA.collector.userId);
      }
    }
    // sms_queue and disputes weren't seeded by this test — assert empty
    // (RLS still applies; collector A should see 0 of B's hypothetical rows).
    for (const table of ["sms_queue", "disputes"] as const) {
      const { data, error } = await clientA.from(table).select("collector_id");
      expect(error, `select ${table}: ${error?.message}`).toBeNull();
      for (const row of data ?? []) {
        expect(row.collector_id).toBe(collectorA.collector.userId);
      }
    }

    // audit_log: collector A may SELECT only their own chain.
    const { data: auditRows, error: auditErr } = await clientA
      .from("audit_log")
      .select("collector_id");
    expect(auditErr).toBeNull();
    for (const row of auditRows ?? []) {
      expect(row.collector_id).toBe(collectorA.collector.userId);
    }
  });

  test("collector A cannot UPDATE collector B's member row (RLS filter)", async () => {
    const clientA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await clientA.auth.signInWithPassword({
      email: collectorA.collector.email,
      password: collectorA.collector.password,
    });

    const targetMember = collectorB.members[0]!.memberId;
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
      email: collectorA.collector.email,
      password: collectorA.collector.password,
    });

    const targetMember = collectorB.members[0]!.memberId;
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
      email: collectorA.collector.email,
      password: collectorA.collector.password,
    });

    const { error } = await clientA.from("audit_log").insert({
      event_id: "00000000-0000-4000-8000-000000000099",
      event_type: "member.created",
      collector_id: collectorA.collector.userId,
      entity_id: collectorA.members[0]!.memberId,
      entity_table: "members",
      timestamp: new Date().toISOString(),
      actor: collectorA.collector.userId,
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
