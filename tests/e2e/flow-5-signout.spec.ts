// Story 1.7 — explicit sign-out E2E.
// Story 1.8 — wired to seedCollector fixture so the test runs in CI.
//
// Flow: signed-in collector → /settings → tap "Se déconnecter" → lands on
// /login with the "Vous êtes déconnecté" toast (NOT the idle-timeout
// "Session expirée" copy — those two paths must be visibly different).
//
// Session-seeding comes from tests/e2e/fixtures/seed-collector.ts. The
// fixture pre-writes the Supabase session into localStorage via
// `page.addInitScript` BEFORE `page.goto()` so `ProtectedRoute` finds a
// session on the first render. Local runs without SUPABASE_TEST_SEED_READY=1
// skip at the describe level.

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow 5 — explicit sign-out (Story 1.7)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the CI seedCollector wiring (Story 1.8)",
  );

  test("sign out from /settings lands on /login with the explicit toast", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured for fixture effect
    seededCollector: _seededCollector,
  }) => {
    await page.goto("/settings");

    // Axe scan on /settings BEFORE the destructive click — this is where UX
    // copy + focus order matter the most.
    await expectNoA11yViolations(page, "/settings pre-signout");

    await page.getByRole("button", { name: /se déconnecter/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    // Explicit-sign-out toast copy — differentiated from idle-timeout's
    // "Session expirée" (Story 1.6) per UX spec "Toast never lies".
    // Diacritic-tolerant: matches "é" or "e" on each accented letter so a
    // future copy tweak that normalizes diacritics doesn't silently turn
    // the gate red.
    await expect(page.getByText(/vous\s+[eé]tes\s+d[eé]connect[eé]/i)).toBeVisible();

    await expectNoA11yViolations(page, "/login post-signout");
  });
});
