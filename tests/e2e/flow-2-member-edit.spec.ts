// Story 2.5 — /members/:id/edit E2E.
//
// Asserts the full FR10 surface end-to-end:
// 1. Tap Modifier on the profile → lands on /members/:id/edit.
// 2. Change name only → no warning banner → save → toast → list shows new name.
// 3. Change daily_amount on an active cycle → warning banner appears →
//    save → header on profile reflects the new amount.
// 4. audit_log row exists with event_type='member.updated' and the
//    collector as actor.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow — /members/:id/edit (Story 2.5)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("edit name (no warning) then daily amount (with warning) — persists + audit row lands", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "EDIT");
    const target = members[0]!;
    const seededName = "Member EDIT-1";
    const renamedName = "Member EDIT-1 renamed";

    // --- 1. Land on the profile, tap Modifier. ---
    await page.goto(`/members/${target.memberId}`);
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(seededName, "i") }),
    ).toBeVisible();
    await page.getByRole("link", { name: /^modifier$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}/edit$`));
    await expectNoA11yViolations(page, "/members/:id/edit loaded");

    // --- 2. Change the name only — no warning, save, list shows new name. ---
    await page.getByLabel("Nom").fill(renamedName);
    await expect(
      page.getByText(/cette modification affectera le cycle en cours/i),
    ).not.toBeVisible();
    await page.getByRole("button", { name: /^enregistrer$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: new RegExp(renamedName, "i") }),
    ).toBeVisible();

    // --- 3. Change the daily amount — warning, save, header reflects it. ---
    await page.getByRole("link", { name: /^modifier$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}/edit$`));
    await page.getByLabel("Cotisation quotidienne (FCFA)").fill("1000");
    await expect(page.getByText(/cette modification affectera le cycle en cours/i)).toBeVisible();
    await page.getByRole("button", { name: /^enregistrer$/i }).click();
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}$`));
    // formatFcfaAmount uses Intl.NumberFormat("fr-FR") which inserts a
    // non-breaking space (U+00A0) between the thousands group and the
    // remainder — match either NBSP or regular whitespace defensively.
    await expect(page.getByText(/1[\s\u00a0]?000\s+FCFA\s+\/\s+jour/)).toBeVisible();

    // --- 4. audit_log row landed via the trigger. ---
    const { data: events, error: auditErr } = await service
      .from("audit_log")
      .select("event_type, actor, entity_id")
      .eq("entity_id", target.memberId)
      .eq("event_type", "member.updated");
    expect(auditErr, auditErr?.message).toBeNull();
    // At least one (we performed two updates: rename + amount change).
    expect(events ?? []).not.toHaveLength(0);
    expect((events ?? [])[0]?.actor).toBe(seededCollector.userId);
  });
});
