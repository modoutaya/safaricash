// Story 1.7 — explicit sign-out E2E.
//
// Flow: signed-in collector → /settings → tap "Se déconnecter" → lands on
// /login with the "Vous êtes déconnecté" toast (NOT the idle-timeout
// "Session expirée" copy — those two paths must be visibly different).
//
// Env-gated like every other cross-stack spec in this sprint: skips cleanly
// when SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY are unset. Story 1.8 wires
// the full CI env (seedCollector fixture + test-mode OTP extraction).
//
// The sign-in step is TODO until Story 1.8 lands the fixture; the assertion
// shape below is the contract that 1.8 will light up.

import { expect, test } from "@playwright/test";

const ENV_OK = !!process.env["SUPABASE_TEST_URL"] && !!process.env["SUPABASE_TEST_ANON_KEY"];

test.describe("Flow 5 — explicit sign-out (Story 1.7)", () => {
  test("sign out from /settings lands on /login with the explicit toast", async ({ page }) => {
    test.skip(!ENV_OK, "SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY not set — Story 1.8 wires CI");

    // TODO (Story 1.8): mint an authenticated session via the seedCollector
    // fixture before navigating. Until then this test is skipped at the
    // env-gate above.
    await page.goto("/settings");

    await page.getByRole("button", { name: /se déconnecter/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    // Explicit-sign-out toast copy — differentiated from idle-timeout's
    // "Session expirée" (Story 1.6) per UX spec "Toast never lies".
    await expect(page.getByText(/vous êtes déconnecté/i)).toBeVisible();
  });
});
