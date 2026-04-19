// Story 1.3 — Re-auth Edge Function tests.
//
// Tests the handler in-process (no HTTP) against the LIVE cloud Supabase
// (linked via supabase-cli). Termii is intercepted via fetch monkey-patch
// so no real SMS is sent.
//
// Required env (read from .env.local at runtime via the test wrapper —
// see scripts/run-edge-tests.sh):
//   SUPABASE_TEST_URL              (the cloud project URL)
//   SUPABASE_TEST_ANON_KEY
//   SUPABASE_TEST_SERVICE_ROLE_KEY
//   SUPABASE_URL                   (same as SUPABASE_TEST_URL — handler reads this)
//   SUPABASE_ANON_KEY              (same as SUPABASE_TEST_ANON_KEY)
//   SUPABASE_SERVICE_ROLE_KEY      (same as SUPABASE_TEST_SERVICE_ROLE_KEY)
//   TERMII_API_KEY                 (any non-empty value — never reached, mocked)
//
// Run: deno test --allow-net --allow-env --allow-read supabase/functions/re-auth/index.test.ts

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";

import {
  buildTestAnonClient,
  buildTestServiceClient,
  cleanupCollector,
  extractOtpFromSmsBody,
  installFetchRecorder,
  type SeededCollector,
  seedCollector,
} from "../_shared/test-utils.ts";
import { OTP_MAX_ATTEMPTS } from "../_shared/constants.ts";
import { consumeConfirmation } from "../_shared/reauth-check.ts";

import { handler } from "./index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildRequest(jwt: string, body: unknown): Request {
  return new Request("https://safaricash-test.local/functions/v1/re-auth", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function termiiMock(otpHolder: { lastBody: string }) {
  return installFetchRecorder({
    matchUrl: (url) => url.includes("termii.com"),
    responder: (call) => {
      const parsed = call.body ? JSON.parse(call.body) : {};
      otpHolder.lastBody = parsed.sms ?? "";
      return new Response(JSON.stringify({ message_id: `mock-${crypto.randomUUID()}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared setup (one collector for all tests; fresh challenge per test).
// ---------------------------------------------------------------------------

const service = buildTestServiceClient();
const anon = buildTestAnonClient();

let collectorA: SeededCollector;
let collectorB: SeededCollector;

async function ensureCollectors(): Promise<void> {
  if (!collectorA) collectorA = await seedCollector(service, anon, "A");
  if (!collectorB) collectorB = await seedCollector(service, anon, "B");
}

/** Clears any prior reauth_challenges rows for these collectors so each test
 *  starts clean (avoids 30s resend-cooldown carry-over between tests). */
async function clearChallenges(): Promise<void> {
  await ensureCollectors();
  await service
    .from("reauth_challenges")
    .delete()
    .in("collector_id", [collectorA.userId, collectorB.userId]);
}

async function teardownAll(): Promise<void> {
  if (collectorA) await cleanupCollector(service, collectorA);
  if (collectorB) await cleanupCollector(service, collectorB);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "(a) issue: happy path returns challenge_id and dispatches SMS",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const res = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "cycle_settlement",
        }),
      );
      assertEquals(res.status, 200);
      const body = await readJson(res);
      assertExists(body.challenge_id);
      assertExists(body.expires_at);
      assertExists(body.resend_available_at);
      assertEquals(recorder.calls.length, 1, "exactly one Termii dispatch expected");
      const otp = extractOtpFromSmsBody(otpHolder.lastBody);
      assertEquals(otp.length, 6);
      assert(/^\d{6}$/.test(otp));
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(b) verify: happy path returns confirmation_token",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const issueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "member_delete",
        }),
      );
      assertEquals(issueRes.status, 200);
      const issueBody = await readJson(issueRes);
      const challengeId = issueBody.challenge_id as string;
      const otp = extractOtpFromSmsBody(otpHolder.lastBody);

      const verifyRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp,
        }),
      );
      assertEquals(verifyRes.status, 200);
      const verifyBody = await readJson(verifyRes);
      assertExists(verifyBody.confirmation_token);
      assertExists(verifyBody.confirmation_expires_at);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(c) verify: wrong OTP returns 401 with attempts_remaining",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const issueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "csv_export",
        }),
      );
      const issueBody = await readJson(issueRes);
      const challengeId = issueBody.challenge_id as string;

      const verifyRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp: "000000",
        }),
      );
      assertEquals(verifyRes.status, 401);
      assertEquals(verifyRes.headers.get("Content-Type"), "application/problem+json");
      const body = await readJson(verifyRes);
      assertEquals(body.attempts_remaining, OTP_MAX_ATTEMPTS - 1);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(d) verify: expired challenge returns 410",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const issueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "sms_resend",
        }),
      );
      const challengeId = (await readJson(issueRes)).challenge_id as string;

      // Fast-forward both created_at AND expires_at to the past (must
      // satisfy reauth_challenges_expires_after_created_chk: expires_at >
      // created_at). 10 min ago + 60s → expires 9 min ago.
      const past = new Date(Date.now() - 10 * 60 * 1000);
      const { error: updErr } = await service
        .from("reauth_challenges")
        .update({
          created_at: past.toISOString(),
          expires_at: new Date(past.getTime() + 60_000).toISOString(),
        })
        .eq("id", challengeId)
        .select("id")
        .single();
      if (updErr) throw new Error(`expires_at backdate failed: ${updErr.message}`);

      const verifyRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp: extractOtpFromSmsBody(otpHolder.lastBody),
        }),
      );
      assertEquals(verifyRes.status, 410);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(e) verify: 3rd wrong attempt locks the challenge (429 + Retry-After)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const issueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "cycle_settlement",
        }),
      );
      const challengeId = (await readJson(issueRes)).challenge_id as string;

      // Two failed attempts.
      for (let i = 0; i < 2; i++) {
        const r = await handler(
          buildRequest(collectorA.jwt, {
            action: "verify",
            challenge_id: challengeId,
            otp: "000000",
          }),
        );
        assertEquals(r.status, 401);
      }
      // Third attempt → lockout (429).
      const lockedRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp: "000000",
        }),
      );
      assertEquals(lockedRes.status, 429);
      assertExists(lockedRes.headers.get("Retry-After"));

      // Fresh issue for same (collector, intended_op) is rejected.
      const reissueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "cycle_settlement",
        }),
      );
      assertEquals(reissueRes.status, 429);
      // Termii dispatched ONLY for the original issue — the locked re-issue
      // must not have triggered a second SMS.
      assertEquals(recorder.calls.length, 1);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(f) verify: cross-collector challenge returns 404 (no enumeration)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const issueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "member_delete",
        }),
      );
      const challengeId = (await readJson(issueRes)).challenge_id as string;
      const otp = extractOtpFromSmsBody(otpHolder.lastBody);

      // Collector B tries to verify A's challenge.
      const verifyRes = await handler(
        buildRequest(collectorB.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp,
        }),
      );
      assertEquals(verifyRes.status, 404);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(g) consumer flow: verify → consumeConfirmation succeeds; second consume fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const otpHolder = { lastBody: "" };
    const recorder = termiiMock(otpHolder);
    try {
      const issueRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "csv_export",
        }),
      );
      const challengeId = (await readJson(issueRes)).challenge_id as string;
      const otp = extractOtpFromSmsBody(otpHolder.lastBody);

      const verifyRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp,
        }),
      );
      const confirmationToken = (await readJson(verifyRes)).confirmation_token as string;

      const first = await consumeConfirmation(
        service,
        collectorA.userId,
        "csv_export",
        confirmationToken,
      );
      assertEquals(first.ok, true);

      // Second consume must fail (single-use).
      const second = await consumeConfirmation(
        service,
        collectorA.userId,
        "csv_export",
        confirmationToken,
      );
      assertEquals(second.ok, false);
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(h) issue: Termii failure rolls back the row (no audit emission)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    const recorder = installFetchRecorder({
      matchUrl: (url) => url.includes("termii.com"),
      responder: () =>
        new Response(JSON.stringify({ error: "upstream down" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    });
    try {
      // Snapshot row count BEFORE the failed issue.
      const { count: before } = await service
        .from("reauth_challenges")
        .select("id", { count: "exact", head: true })
        .eq("collector_id", collectorA.userId)
        .eq("intended_op", "sms_resend");

      const res = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "sms_resend",
        }),
      );
      assertEquals(res.status, 502);

      // No new row should have landed (insert was deleted on Termii failure).
      const { count: after } = await service
        .from("reauth_challenges")
        .select("id", { count: "exact", head: true })
        .eq("collector_id", collectorA.userId)
        .eq("intended_op", "sms_resend");
      assertEquals(after, before);
    } finally {
      recorder.uninstall();
    }
  },
});

// ---------------------------------------------------------------------------
// Cleanup. Deno test runner doesn't have an afterAll; cleanup runs in the
// process exit hook so it always fires even on test failure.
// ---------------------------------------------------------------------------

addEventListener("unload", () => {
  // Fire-and-forget — best-effort cleanup so we don't accumulate test users.
  teardownAll().catch(() => {
    // ignore
  });
});
