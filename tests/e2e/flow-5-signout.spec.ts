// Story 1.7 — explicit sign-out E2E.
//
// Flow: signed-in collector → /settings → tap "Se déconnecter" → lands on
// /login with the "Vous êtes déconnecté" toast (NOT the idle-timeout
// "Session expirée" copy — those two paths must be visibly different).
//
// Session-seeding is owned by Story 1.8. Until that story wires a Playwright-
// side seedCollector helper + sets SUPABASE_TEST_SEED_READY=1, this spec
// cannot mint an authenticated session, and /settings would redirect to
// /login via ProtectedRoute. The gate is an explicit, dedicated flag (NOT
// the generic SUPABASE_TEST_* pair, which CI already sets for Supabase RPC
// tests) so the spec skips cleanly BOTH locally AND in CI until 1.8 lands.
// When Story 1.8 exports SUPABASE_TEST_SEED_READY=1 the assertions below
// light up without further spec changes.

import { expect, test } from "@playwright/test";

const CAN_SEED = process.env["SUPABASE_TEST_SEED_READY"] === "1";

test.describe("Flow 5 — explicit sign-out (Story 1.7)", () => {
  test("sign out from /settings lands on /login with the explicit toast", async ({ page }) => {
    test.skip(
      !CAN_SEED,
      "SUPABASE_TEST_SEED_READY not set — Story 1.8 wires the Playwright seedCollector fixture",
    );

    // TODO (Story 1.8): mint an authenticated session via the seedCollector
    // fixture before navigating.
    await page.goto("/settings");

    await page.getByRole("button", { name: /se déconnecter/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    // Explicit-sign-out toast copy — differentiated from idle-timeout's
    // "Session expirée" (Story 1.6) per UX spec "Toast never lies".
    await expect(page.getByText(/vous êtes déconnecté/i)).toBeVisible();
  });
});
