// Story 12.1 — Flow 12 Journal tab E2E.
//
// Smoke check: the new 4th BottomNav item links to /journal, the page
// renders the title + period selector + search input, and an empty-state
// shows when the seeded collector has no members. The richer per-member
// section + lazy fetch + period switching surface is covered by the
// vitest component tests (JournalMemberSection.test.tsx +
// JournalPeriodSelector.test.tsx + sortFilterPaginate.test.ts).
//
// A heavier seed-3-members-with-mixed-transactions scenario is deferred
// to a follow-up Story 12.2 alongside the export-from-Journal CTA.

import { expect, test, E2E_SEED_READY } from "./fixtures/seed-collector";

import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow 12 — Journal tab", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the CI seedCollector wiring (Story 1.8)",
  );

  test("BottomNav 4th item → /journal renders title, period selector, search", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured for fixture effect
    seededCollector: _seededCollector,
  }) => {
    await page.goto("/dashboard");

    // Tap the new "Journal" tab in the BottomNav.
    const journalLink = page.getByRole("link", { name: "Journal" });
    await expect(journalLink).toHaveAttribute("href", "/journal");
    await journalLink.click();

    await expect(page).toHaveURL(/\/journal$/);

    // Title + period selector + search input.
    await expect(page.getByRole("heading", { level: 1, name: /journal/i })).toBeVisible();
    const periodGroup = page.getByRole("radiogroup", { name: /période affichée/i });
    await expect(periodGroup).toBeVisible();
    await expect(page.getByRole("radio", { name: "Cycle précédent" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("radio", { name: "Cycle en cours" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "7 derniers jours" })).toBeVisible();
    await expect(page.getByPlaceholder(/rechercher un membre/i)).toBeVisible();

    // Seeded collector has no members yet → empty-state copy renders.
    await expect(
      page.getByText(/aucun membre — ajoutez-en un depuis l'onglet membres/i),
    ).toBeVisible();

    await expectNoA11yViolations(page, "/journal empty-state");
  });

  test("switching period to '7 derniers jours' updates aria-checked", async ({
    page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    seededCollector: _seededCollector,
  }) => {
    await page.goto("/journal");
    const lastSevenDays = page.getByRole("radio", { name: "7 derniers jours" });
    await lastSevenDays.click();
    await expect(lastSevenDays).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("radio", { name: "Cycle précédent" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
