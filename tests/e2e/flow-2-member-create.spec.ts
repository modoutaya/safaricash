// Story 2.2 — Flow: collector creates a member manually.
//
// Coverage:
//   1. /members/new (public-surface assertions, env-free) renders the form
//      with the 3 labelled fields + the disabled CTA.
//   2. Pre-authenticated collector creates a member end-to-end via the
//      RHF + Zod + RPC pipeline → lands on /members → the new member's
//      name is visible in the populated list. Cleanup deletes the seeded
//      collector + the member it just created (cascade FK).
//
// Env contract:
//   - Test 1 always runs.
//   - Test 2 requires SUPABASE_TEST_SEED_READY=1 (Story 1.8 CI fixture).

import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test";

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

playwrightTest.describe("Flow 2.2 — create member manually (public surface)", () => {
  playwrightTest(
    "/members/new renders the 3-field form + disabled CTA + axe-clean",
    async ({ page }) => {
      await page.goto("/members/new");
      await playwrightExpect(
        page.getByRole("heading", { level: 1, name: /nouveau membre/i }),
      ).toBeVisible();
      await playwrightExpect(page.getByLabel("Nom")).toBeVisible();
      await playwrightExpect(page.getByLabel("Numéro de téléphone (optionnel)")).toBeVisible();
      await playwrightExpect(page.getByLabel("Cotisation quotidienne (FCFA)")).toBeVisible();
      await playwrightExpect(
        page.getByRole("button", { name: /ajouter ce membre/i }),
      ).toBeDisabled();
      await expectNoA11yViolations(page, "/members/new manual create form");
    },
  );
});

test.describe("Flow 2.2 — authenticated create-member happy path", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the CI seedCollector wiring (Story 1.8)",
  );

  test("collector fills the form, submits, and the new member appears on /members", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured for fixture effect
    seededCollector: _seededCollector,
  }) => {
    // Fresh collector → /members empty state → click EmptyState CTA →
    // /members/new → fill form → submit → assert /members shows the new
    // member. The empty-state CTA route navigation is the canonical entry
    // point exercised in Story 1.5; the header "Ajouter un membre" CTA is
    // covered by the Vitest MemberList tests.
    await page.goto("/members");
    await page.getByRole("button", { name: /ajouter mon premier membre/i }).click();
    await expect(page).toHaveURL(/\/members\/new$/);

    const memberName = `E2E Member ${Date.now()}`;
    await page.getByLabel("Nom").fill(memberName);
    // Skip phone — exercises the empty-phone path.
    await page.getByLabel("Cotisation quotidienne (FCFA)").fill("500");

    const cta = page.getByRole("button", { name: /ajouter ce membre/i });
    await expect(cta).toBeEnabled();
    await cta.click();

    // Lands on /members; the success toast briefly shows the name.
    await expect(page).toHaveURL(/\/members$/);
    await expect(page.getByRole("heading", { level: 2, name: memberName })).toBeVisible({
      timeout: 5000,
    });
  });
});
