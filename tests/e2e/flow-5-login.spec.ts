// Story 1.5b — Flow 5 login end-to-end (PRD v1.3 password pivot).
//
// What this spec covers:
//   1. The public /login page renders the welcome copy + phone + password
//      fields + "Se connecter" CTA (disabled).
//   2. CTA remains disabled until BOTH the phone is a valid +221 mobile
//      AND the password field has a character.
//   3. The "Mot de passe oublié ?" link is a tel: anchor pointing at the
//      founder support phone (R-OP1).
//   4. A pre-authenticated collector (seeded via the shared fixture) lands
//      on the protected tree and the /members empty-state renders + is
//      axe-clean.
//
// What is intentionally NOT covered:
//   - Full "drive the form with a real phone+password sign-in" integration
//     is out of scope at this iteration — the shared seed fixture uses
//     email-based seeding, and a parallel phone-seed fixture is scope
//     creep for this story. The Supabase-side signInWithPassword path is
//     covered by supabase/functions/re-auth/index.test.ts.
//
// Env contract:
//   - Tests 1–3 (public-surface assertions) always run, no env needed.
//   - Test 4 requires SUPABASE_TEST_SEED_READY=1 (Story 1.8's CI fixture).

import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test";

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

playwrightTest.describe("Flow 5 — collector login (public surface, password flow)", () => {
  playwrightTest(
    "loads /login welcome screen with phone + password + sign-in CTA",
    async ({ page }) => {
      await page.goto("/login");
      await playwrightExpect(
        page.getByRole("heading", { level: 1, name: /bienvenue sur safaricash/i }),
      ).toBeVisible();
      await playwrightExpect(page.getByLabel("Numéro de téléphone")).toBeVisible();
      // exact: true — the show/hide toggle's aria-label is
      // "Afficher le mot de passe" which would substring-match "Mot de passe".
      await playwrightExpect(page.getByLabel("Mot de passe", { exact: true })).toBeVisible();
      await playwrightExpect(page.getByRole("button", { name: /se connecter/i })).toBeDisabled();
      await expectNoA11yViolations(page, "/login phone-password screen");
    },
  );

  playwrightTest(
    "enables the CTA only when phone is valid AND password is non-empty",
    async ({ page }) => {
      await page.goto("/login");
      const cta = page.getByRole("button", { name: /se connecter/i });
      const phone = page.getByLabel("Numéro de téléphone");
      // exact: true — see note in the previous test.
      const password = page.getByLabel("Mot de passe", { exact: true });

      await phone.fill("+221777915898");
      await playwrightExpect(cta).toBeDisabled(); // still no password
      await password.fill("anything");
      await playwrightExpect(cta).toBeEnabled();

      // Clearing the password re-disables.
      await password.fill("");
      await playwrightExpect(cta).toBeDisabled();
    },
  );

  playwrightTest("'Mot de passe oublié ?' link opens a tel: to the founder", async ({ page }) => {
    await page.goto("/login");
    const link = page.getByRole("link", { name: /mot de passe oublié/i });
    // FOUNDER_SUPPORT_PHONE lives in src/lib/contact.ts; validated by the
    // unit tests. Here we only assert the tel: prefix + +221 country code.
    await playwrightExpect(link).toHaveAttribute("href", /^tel:\+221/);
  });
});

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
    await page.goto("/members");

    await expect(
      page.getByRole("heading", { level: 1, name: /aucun membre pour l'instant/i }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /ajouter mon premier membre/i })).toBeVisible();

    await expectNoA11yViolations(page, "/members empty-state");
  });
});
