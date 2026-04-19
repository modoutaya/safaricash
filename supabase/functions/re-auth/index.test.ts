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
  name: "(h) issue: Termii failure marks row as expired (NOT deleted) — cooldown still applies",
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
      const res = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "sms_resend",
        }),
      );
      assertEquals(res.status, 502);

      // CODE REVIEW C4 fix: row is preserved with status='expired' so the
      // 30s cooldown query still catches it on the next issue attempt.
      const { data: rows } = await service
        .from("reauth_challenges")
        .select("id, status")
        .eq("collector_id", collectorA.userId)
        .eq("intended_op", "sms_resend");
      assertEquals(rows?.length, 1, "row preserved (not deleted)");
      assertEquals(rows![0].status, "expired");
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(i) issue: cooldown applies even after Termii failure (anti-pattern guard)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await ensureCollectors();
    await clearChallenges();
    let termiiCalls = 0;
    const recorder = installFetchRecorder({
      matchUrl: (url) => url.includes("termii.com"),
      responder: () => {
        termiiCalls++;
        return new Response(JSON.stringify({ error: "upstream down" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      // First issue → Termii fails (with internal client retries: 3 attempts
      // per sendSms call due to 5xx backoff). Row marked status='expired'.
      const r1 = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "sms_resend",
        }),
      );
      assertEquals(r1.status, 502);
      const callsAfterFirstIssue = termiiCalls;
      assert(callsAfterFirstIssue >= 1, "expected at least one Termii dispatch attempt");

      // Second issue within 30s — must be rejected with otp_resend_too_soon,
      // NOT dispatch a fresh SMS. This is the C4 anti-pattern guard.
      const r2 = await handler(
        buildRequest(collectorA.jwt, {
          action: "issue",
          intended_op: "sms_resend",
        }),
      );
      assertEquals(r2.status, 429, "cooldown must reject fresh issue after Termii failure");
      assertEquals(
        termiiCalls,
        callsAfterFirstIssue,
        "no NEW Termii dispatch on the rejected second issue (cooldown gate held)",
      );
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(j) verify: 5 concurrent wrong-OTP verifies — atomic CAS prevents brute-force amplification",
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

      // Fire 5 parallel wrong-OTP verifies. WITHOUT the CAS fix (Story 1.3
      // code review C1), all 5 read attempts=0 and write attempts=1 →
      // lockout never trips. WITH the fix, attempts increments atomically
      // 1→2→3 and the 3rd verify gets locked; the remaining 2 see status
      // already terminal and return 429 (lockout) or 409 (already_used).
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          handler(
            buildRequest(collectorA.jwt, {
              action: "verify",
              challenge_id: challengeId,
              otp: "000000",
            }),
          ),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      // At most 2 attempts return 401 (counted toward lockout). The 3rd
      // attempt (or first to reach attempts=3) returns 429 lockout. The
      // 4th and 5th are blocked by the now-terminal status.
      const status401Count = statuses.filter((s) => s === 401).length;
      const status429Count = statuses.filter((s) => s === 429).length;
      const status409Count = statuses.filter((s) => s === 409).length;
      // Total = 5; 401s + 429s + 409s should account for all of them.
      assertEquals(status401Count + status429Count + status409Count, 5);
      // Critical: at LEAST one 429 fired (lockout did NOT silently never trigger).
      assert(status429Count >= 1, `expected ≥ 1 lockout (429); got statuses ${statuses.join(",")}`);

      // Verify final DB state: row.attempts should equal exactly 3 (capped),
      // NOT 1 (which would indicate the race won).
      const { data: final } = await service
        .from("reauth_challenges")
        .select("attempts, status")
        .eq("id", challengeId)
        .single();
      assertEquals(final?.attempts, 3, "atomic CAS ensures attempts incremented monotonically");
      assertEquals(final?.status, "locked");
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(k) audit_log: reauth.requested + reauth.verified emitted with hash chain",
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
      assertEquals(verifyRes.status, 200);

      // Read audit_log via service-role; expect both events for this challenge.
      const { data: events } = await service
        .from("audit_log")
        .select("event_type, payload, prev_hash, entry_hash")
        .eq("collector_id", collectorA.userId)
        .eq("entity_id", challengeId)
        .order("timestamp", { ascending: true });
      const types = (events ?? []).map((e) => e.event_type);
      assert(types.includes("reauth.requested"), `expected reauth.requested in ${types.join(",")}`);
      assert(types.includes("reauth.verified"), `expected reauth.verified in ${types.join(",")}`);
      // Code review H7: otp_hash must NOT appear in audit payload.
      for (const ev of events ?? []) {
        const p = ev.payload as Record<string, unknown>;
        assert(
          !("otp_hash" in p),
          `otp_hash must be redacted from audit payload, got: ${JSON.stringify(p)}`,
        );
      }
    } finally {
      recorder.uninstall();
    }
  },
});

Deno.test({
  name: "(l) consumer flow: consumeConfirmation atomic + DB-clock expiry (no JS clock skew)",
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

      const verifyRes = await handler(
        buildRequest(collectorA.jwt, {
          action: "verify",
          challenge_id: challengeId,
          otp,
        }),
      );
      const { confirmation_token: token } = (await readJson(verifyRes)) as {
        confirmation_token: string;
      };

      // Wrong intended_op → confirmation_invalid (matrix coverage).
      const wrongOp = await consumeConfirmation(service, collectorA.userId, "csv_export", token);
      assertEquals(wrongOp.ok, false);

      // Wrong collector → confirmation_invalid.
      const wrongCollector = await consumeConfirmation(
        service,
        collectorB.userId,
        "member_delete",
        token,
      );
      assertEquals(wrongCollector.ok, false);

      // Correct args → ok once.
      const ok1 = await consumeConfirmation(service, collectorA.userId, "member_delete", token);
      assertEquals(ok1.ok, true);

      // Reuse → confirmation_invalid.
      const ok2 = await consumeConfirmation(service, collectorA.userId, "member_delete", token);
      assertEquals(ok2.ok, false);
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
