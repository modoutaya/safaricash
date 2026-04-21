// Story 2.1 — /members list E2E.
//
// Consumes the seedCollector fixture + seedMembersForCollector helper
// exported by Story 1.8's tests/e2e/fixtures/seed-collector.ts — Story 2.1
// is the first real consumer of the members helper.
//
// Env contract (set by Story 1.8 CI, flipped locally via .env.local):
//   - SUPABASE_TEST_SEED_READY=1 (enables the fixture)
//   - SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY / SUPABASE_TEST_SERVICE_ROLE_KEY
//
// The 2nd test escalates one seeded member's cycle to `with_advance` via
// service-role so the chip filter can be asserted against a non-uniform
// set of statuses (`seedMembersForCollector` only creates active cycles).

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow — /members list + search + filters (Story 2.1)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("lists 3 seeded members, filters by search, filters by status chip", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 3, "LIST");

    // Escalate one cycle to 'with_advance' so the chip filter has something
    // to narrow against. seedMembersForCollector creates 'active' cycles by
    // default.
    const { error: updErr } = await service
      .from("cycles")
      .update({ status: "with_advance" })
      .eq("id", members[0]!.cycleId);
    expect(updErr, updErr?.message).toBeNull();

    await page.goto("/members");

    // Wait for the list to render (h1 = "Membres") and for 3 member cards.
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();
    const memberCards = page.getByRole("heading", { level: 2 });
    await expect(memberCards).toHaveCount(3);

    await expectNoA11yViolations(page, "/members list loaded");

    // --- Search filter (substring, diacritic-insensitive against seeded
    // names that look like "Member LIST-1" / "Member LIST-2" / etc.) ---
    const searchBox = page.getByLabel(/rechercher un membre/i);
    await searchBox.fill("list-1");
    // Only one member's name contains "LIST-1".
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);

    // Clear and assert back to 3.
    await searchBox.fill("");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(3);

    // --- Status-chip filter: "Avance" narrows to the escalated member. ---
    await page.getByRole("button", { name: /^avance$/i }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(1);

    // Toggle chip off → back to 3.
    await page.getByRole("button", { name: /^avance$/i }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(3);
  });
});
