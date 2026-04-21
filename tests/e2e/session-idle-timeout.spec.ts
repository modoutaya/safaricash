// Story 1.6 — Flow 5 idle-timeout end-to-end test.
//
// Exercises the NFR-S4 30-min idle policy against the real UI and a live
// Supabase instance. Uses Playwright's clock API (`page.clock`) to compress
// 30 minutes into milliseconds without actually waiting.
//
// Session-seeding is owned by Story 1.8. The spec needs an authenticated
// session BEFORE advancing the clock (otherwise ProtectedRoute redirects to
// /login and no idle timer ever arms). We gate on SUPABASE_TEST_SEED_READY
// (a dedicated flag Story 1.8 will set when the Playwright seedCollector
// fixture lands) so this spec skips cleanly both locally and in CI until
// then — the generic SUPABASE_TEST_* pair CI already sets is not enough.
//
// `page.clock.install()` MUST be called BEFORE `page.goto()` — installing
// after a page is loaded cannot patch the already-loaded Date/setTimeout.

import { expect, test } from "@playwright/test";

const CAN_SEED = process.env["SUPABASE_TEST_SEED_READY"] === "1";

test.describe("Flow 5 — idle-timeout (NFR-S4)", () => {
  test("30 min idle → auto sign-out → lands on /login with session-expired toast", async ({
    page,
  }) => {
    test.skip(
      !CAN_SEED,
      "SUPABASE_TEST_SEED_READY not set — Story 1.8 wires the Playwright seedCollector fixture",
    );

    // Install the synthetic clock BEFORE any navigation so Date + setTimeout
    // inside the app are patched from the first render.
    await page.clock.install();

    // Sign-in path is TODO: Story 1.8 will add a `seedCollector` fixture that
    // mints a Supabase session directly via the admin API and sets the
    // storage cookies/localStorage. Until then, this test is skipped at the
    // env-gate above. The shape of the assertion below is the contract
    // Story 1.8 will light up.
    await page.goto("/members");

    // Advance wall-clock past the 30-min idle window.
    await page.clock.fastForward(30 * 60_000 + 1_000);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/session expirée/i)).toBeVisible();
  });
});
