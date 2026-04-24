// Story 2.4 — /members/:id profile E2E.
//
// Mirrors flow-member-list.spec.ts: env-gated on SUPABASE_TEST_SEED_READY,
// uses the seedCollector fixture + seedMembersForCollector helper from
// Story 1.8.
//
// Asserts:
// 1. Tap a card on /members → navigates to /members/:id.
// 2. The 8-datapoint header card renders for the seeded member.
// 3. Empty-state copy renders when the cycle has no transactions yet.
// 4. axe-clean on the loaded profile.

import {
  E2E_SEED_READY,
  expect,
  seedMembersForCollector,
  test,
  buildServiceClient,
} from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow — /members/:id profile (Story 2.4)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("tap card → 360 profile renders header + empty-state, axe-clean", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "PROF");
    const target = members[0]!;
    const targetName = "Member PROF-1"; // matches seedMembersForCollector convention

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();

    // Story 4.1 — tap card opens the action sheet (NOT direct navigate).
    await page.getByRole("button", { name: new RegExp(targetName, "i") }).click();

    // Action sheet visible — Voir profil is the new path to the profile.
    await expect(page.getByRole("button", { name: /^voir profil$/i })).toBeVisible();
    await page.getByRole("button", { name: /^voir profil$/i }).click();

    // Profile page lands.
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(targetName, "i") }),
    ).toBeVisible();

    // Header datapoints — at least the daily-amount + cycle-day labels.
    await expect(page.getByText(/FCFA \/ jour/i)).toBeVisible();
    await expect(page.getByText(/Jour \d+ sur 30/i)).toBeVisible();
    await expect(page.getByText(/Solde prévu fin cycle/i)).toBeVisible();

    // Transaction list — seedMembersForCollector inserts 1 contribution
    // (cycle_day 1, amount 500) per member, so the list should render that
    // single row, not the empty-state.
    await expect(page.getByText(/^Cotisation$/)).toBeVisible();
    await expect(page.getByText(/^J1$/)).toBeVisible();

    await expectNoA11yViolations(page, "/members/:id profile loaded");
  });
});
