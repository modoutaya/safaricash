// Story 1.6 — Flow 5 idle-timeout end-to-end test.
//
// Exercises the NFR-S4 30-min idle policy against the real UI and a live
// Supabase instance. Uses Playwright's clock API (`page.clock`) to compress
// 30 minutes into milliseconds without actually waiting.
//
// Env-gated for the same reason as Stories 1.3 / 1.4 / 1.5: CI doesn't yet
// wire a pre-provisioned seed collector + test-mode OTP read. Story 1.8 owns
// the full CI wiring; until then this spec runs locally when SUPABASE_TEST_URL
// and SUPABASE_TEST_ANON_KEY are set, and skips cleanly otherwise.
//
// `page.clock.install()` MUST be called BEFORE `page.goto()` — installing
// after a page is loaded cannot patch the already-loaded Date/setTimeout.

import { expect, test } from "@playwright/test";

const ENV_OK = !!process.env["SUPABASE_TEST_URL"] && !!process.env["SUPABASE_TEST_ANON_KEY"];

test.describe("Flow 5 — idle-timeout (NFR-S4)", () => {
  test("30 min idle → auto sign-out → lands on /login with session-expired toast", async ({
    page,
  }) => {
    test.skip(!ENV_OK, "SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY not set — Story 1.8 wires CI");

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
