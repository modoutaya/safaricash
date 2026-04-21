// Story 1.5 — Flow 5 login end-to-end test.
// Story 1.8 — axe-core a11y scans + a 4th authenticated-session E2E.
//
// What this spec covers today:
//   1. The public /login page renders the welcome copy and phone input.
//   2. An unregistered phone lands on /non-registered via the RPC gate
//      (no Termii call — verified by watching for the dead-end screen).
//   3. The "Appeler SafariCash" CTA exposes a tel: link with the full
//      +221 prefix (R-OP1 / AC #4).
//   4. A pre-authenticated collector lands on the protected tree and the
//      /members empty-state renders its CTA. The full "enter 6 digits via
//      the OtpStep UI" drive-through remains deferred (OTP read-out of
//      Supabase's auth schema requires either a test-only RPC or direct
//      `auth.one_time_tokens` exposure via PostgREST; both are plan-
//      dependent — the OtpStep UI is covered by Vitest component tests).
//      This 4th test validates the post-auth handoff end-to-end: session
//      present in localStorage → `ProtectedRoute` accepts → `/members` +
//      empty-state render + axe-clean.
//
// Env contract:
//   - Tests 1 and 2 (no-env branches) always run.
//   - Test 3 (unregistered phone) requires SUPABASE_TEST_URL + ANON_KEY.
//   - Test 4 requires SUPABASE_TEST_SEED_READY=1 (Story 1.8's CI fixture).

import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test";

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

const ENV_OK = !!process.env["SUPABASE_TEST_URL"] && !!process.env["SUPABASE_TEST_ANON_KEY"];

// Tests 1–3 don't need the seedCollector fixture (no authenticated session
// required). Use the plain Playwright `test` for them to avoid firing the
// fixture's setup/teardown needlessly.
playwrightTest.describe("Flow 5 — collector login (public surface)", () => {
  playwrightTest(
    "loads /login welcome screen with phone input + send-code CTA",
    async ({ page }) => {
      await page.goto("/login");
      await playwrightExpect(
        page.getByRole("heading", { level: 1, name: /bienvenue sur safaricash/i }),
      ).toBeVisible();
      await playwrightExpect(page.getByLabel("Numéro de téléphone")).toBeVisible();
      await playwrightExpect(
        page.getByRole("button", { name: /recevoir le code/i }),
      ).toBeDisabled();
      await expectNoA11yViolations(page, "/login phone-step");
    },
  );

  playwrightTest("disables the CTA until a valid +221 phone is entered", async ({ page }) => {
    await page.goto("/login");
    const cta = page.getByRole("button", { name: /recevoir le code/i });
    const input = page.getByLabel("Numéro de téléphone");
    await input.fill("123");
    await playwrightExpect(cta).toBeDisabled();
    await input.fill("+221777915898");
    await playwrightExpect(cta).toBeEnabled();
  });

  playwrightTest("routes an unregistered phone to /non-registered dead-end", async ({ page }) => {
    playwrightTest.skip(!ENV_OK, "SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY not set");

    await page.goto("/login");
    const input = page.getByLabel("Numéro de téléphone");
    // A random +221 phone that (almost certainly) is not provisioned.
    // Senegal E.164 = +221 + 9 digits; we lock the first two ("77", a valid
    // mobile prefix) and generate the remaining 7 randomly.
    const randomPhone = `+22177${Math.floor(1e6 + Math.random() * 9e6)
      .toString()
      .slice(-7)}`;
    await input.fill(randomPhone);
    await page.getByRole("button", { name: /recevoir le code/i }).click();

    await playwrightExpect(page).toHaveURL(/\/non-registered$/);
    await playwrightExpect(
      page.getByRole("heading", { name: /numéro non enregistré/i }),
    ).toBeVisible();

    // Founder support phone exposed as tel:+221777915898 (single-source-of-
    // truth constant in src/lib/contact.ts).
    const callCta = page.getByRole("link", { name: /appeler safaricash/i });
    await playwrightExpect(callCta).toHaveAttribute("href", "tel:+221777915898");
    await expectNoA11yViolations(page, "/non-registered dead-end");
  });
});

// Test 4 uses the seedCollector fixture (pre-auth session). Different
// describe so we don't pay the seed/teardown on the no-auth tests above.
test.describe("Flow 5 — post-authenticated-session landing", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the CI seedCollector wiring (Story 1.8)",
  );

  test("authenticated session lands on /members empty-state", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured for fixture effect
    seededCollector: _seededCollector,
  }) => {
    // `/` → ProtectedRoute (session present) → Navigate to /dashboard
    // (router.tsx:41). Navigate explicitly to /members so we hit the
    // empty-state branch — the newly seeded collector has 0 members.
    await page.goto("/members");

    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();
    // EmptyState CTA from UX spec § Member list empty state.
    await expect(page.getByRole("button", { name: /ajouter mon premier membre/i })).toBeVisible();

    await expectNoA11yViolations(page, "/members empty-state");
  });
});
