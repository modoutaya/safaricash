// Story 2.2 — Flow: collector creates a member manually.
//
// Coverage (BOTH tests env-gated via SUPABASE_TEST_SEED_READY because
// /members/new is wrapped in <ProtectedRoute> and redirects to /login
// without an authenticated session — there is no env-free assertion
// surface for this route):
//   1. Form renders the 3 labelled fields + disabled CTA + axe-clean.
//   2. Collector fills the form → submits → lands on /members → the new
//      member's name is visible. Cleanup deletes the seeded collector
//      (cascade FK removes the member + cycle).
//
// Env contract: SUPABASE_TEST_SEED_READY=1 (Story 1.8 CI fixture).

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow 2.2 — create member manually", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the CI seedCollector wiring (Story 1.8)",
  );

  test("/members/new renders the 3-field form + disabled CTA + axe-clean", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured for fixture effect
    seededCollector: _seededCollector,
  }) => {
    await page.goto("/members/new");
    await expect(page.getByRole("heading", { level: 1, name: /nouveau membre/i })).toBeVisible();
    await expect(page.getByLabel("Nom")).toBeVisible();
    await expect(page.getByLabel("Numéro de téléphone")).toBeVisible();
    await expect(page.getByLabel("Cotisation quotidienne (FCFA)")).toBeVisible();
    await expect(page.getByRole("button", { name: /ajouter ce membre/i })).toBeDisabled();
    await expectNoA11yViolations(page, "/members/new manual create form");
  });

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
    await page.getByLabel("Numéro de téléphone").fill("+221770000000");
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
