// Story 1.4 — rate-limit Worker E2E gate.
//
// Hits the deployed (or `wrangler dev`-served) worker URL 101 times in
// rapid succession with the same collector JWT and asserts the 101st
// returns 429 + Retry-After. The worker proxies passes through to
// Supabase; the request body is intentionally invalid so the downstream
// Edge Function rejects fast (we're testing the rate-limit gate, not
// re-auth correctness).
//
// Required env (auto-skipped if absent — Story 1.8 will wire `wrangler dev`
// into CI):
//   WORKER_BASE_URL                  — e.g. http://localhost:8787
//   SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_ROLE_KEY
//                                    — used to seed a collector + JWT.
//
// Local run:
//   1. Terminal A: `npm run worker:rate-limit:dev`
//      (starts wrangler dev on http://localhost:8787 with a Miniflare KV)
//   2. Terminal B: `WORKER_BASE_URL=http://localhost:8787 npx playwright test tests/e2e/rate-limit.spec.ts`
//
// Mutation-test (manual): set `RATE_LIMIT_PER_MINUTE=1000` in wrangler.toml
// → re-run → spec should fail (101st returns 200 not 429). Restore.

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const WORKER_BASE_URL = process.env["WORKER_BASE_URL"];
const SUPABASE_URL = process.env["SUPABASE_TEST_URL"];
const SUPABASE_ANON_KEY = process.env["SUPABASE_TEST_ANON_KEY"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_TEST_SERVICE_ROLE_KEY"];

const ENV_OK =
  Boolean(WORKER_BASE_URL) &&
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) &&
  Boolean(SUPABASE_SERVICE_ROLE_KEY);

test.describe("rate-limit worker (NFR-S9 100 req/min/collector gate)", () => {
  test.describe.configure({ mode: "serial" });

  test.skip(
    !ENV_OK,
    "WORKER_BASE_URL + SUPABASE_TEST_* required (run `npm run worker:rate-limit:dev` then export WORKER_BASE_URL=http://localhost:8787)",
  );

  test("101st request from same collector within 60s returns 429 + Retry-After", async () => {
    const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anon = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Seed a fresh collector for this test.
    const stamp = Date.now();
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const email = `ratelimit-${stamp}-${rand}@safaricash-test.local`;
    const password = `Pwd-${rand}-${stamp}`;
    const phone = `+22177${crypto.randomUUID().replace(/-/g, "").slice(0, 9)}`;

    const { data: authData, error: authErr } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(authErr, authErr?.message).toBeNull();
    const userId = authData.user!.id;

    const { error: usersErr } = await service.from("users").insert({
      id: userId,
      phone_number: phone,
      role: "collector",
    });
    expect(usersErr, usersErr?.message).toBeNull();

    try {
      const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
        email,
        password,
      });
      expect(signInErr, signInErr?.message).toBeNull();
      const jwt = signIn.session!.access_token;

      // Fire 101 requests sequentially through the worker. The body shape
      // doesn't matter — we expect Supabase to reject as invalid request,
      // but the rate-limit fires before reaching Supabase on the 101st.
      const url = `${WORKER_BASE_URL!.replace(/\/$/, "")}/functions/v1/re-auth`;
      const headers = {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({ action: "issue", intended_op: "cycle_settlement" });

      const responses: Response[] = [];
      for (let i = 0; i < 101; i++) {
        const r = await fetch(url, { method: "POST", headers, body });
        responses.push(r);
        // Drain body so the connection can be reused.
        await r.text();
      }

      // First 100 responses came from Supabase (any status, NOT 429 from
      // our worker). The 101st must be the worker's 429.
      const last = responses[100]!;
      expect(last.status).toBe(429);
      expect(last.headers.get("Content-Type")).toBe("application/problem+json");
      const retryAfter = last.headers.get("Retry-After");
      expect(retryAfter).toMatch(/^\d+$/);
      const retryAfterNum = Number.parseInt(retryAfter!, 10);
      expect(retryAfterNum).toBeGreaterThan(0);
      expect(retryAfterNum).toBeLessThanOrEqual(60);
    } finally {
      await service.auth.admin.deleteUser(userId);
    }
  });
});
