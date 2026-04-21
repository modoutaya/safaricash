// Story 1.6 — Flow 5 idle-timeout end-to-end test.
// Story 1.8 — wired to seedCollector fixture so the test runs in CI.
//
// Exercises the NFR-S4 30-min idle policy against the real UI and a live
// Supabase instance. Uses Playwright's clock API (`page.clock`) to compress
// 30 minutes into milliseconds without actually waiting.
//
// `page.clock.install()` MUST be called BEFORE `page.goto()` — installing
// after a page is loaded cannot patch the already-loaded Date/setTimeout.
// It also MUST be called AFTER the fixture's `mintAuthenticatedSession`
// (which itself uses `page.addInitScript`) — both queue onto the next
// navigation, and Playwright preserves order of addInitScript calls.

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow 5 — idle-timeout (NFR-S4)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the CI seedCollector wiring (Story 1.8)",
  );

  test("30 min idle → auto sign-out → lands on /login with session-expired toast", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured for fixture effect
    seededCollector: _seededCollector,
  }) => {
    // Install the synthetic clock AFTER the fixture's session pre-write but
    // BEFORE the navigation so Date + setTimeout inside the app are patched
    // from the first render.
    await page.clock.install();

    await page.goto("/members");

    await expectNoA11yViolations(page, "/members pre-idle");

    // Advance wall-clock past the 30-min idle window.
    await page.clock.fastForward(30 * 60_000 + 1_000);

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText(/session expirée/i)).toBeVisible();

    // Same sonner toast → `color-contrast` waiver as in flow-5-signout.
    // See that file's TODO — audit belongs to a later toast / token pass.
    await expectNoA11yViolations(page, "/login post-idle", {
      disableRules: ["color-contrast"],
    });
  });
});
