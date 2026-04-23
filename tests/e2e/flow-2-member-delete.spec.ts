// Story 2.6 — /members/:id delete E2E.
//
// Asserts the full FR11 + FR5 surface end-to-end:
// 1. Supprimer button visible.
// 2. Tap → dialog opens with name + summary copy.
// 3. Wrong word → Continuer disabled.
// 4. SUPPRIMER typed → Continuer → password input visible.
// 5. Wrong password → re-auth 401 → inline alert + dialog stays open +
//    member still in DB.
// 6. Real password → re-auth 200 → delete RPC fires → toast → /members.
// 7. Service-role count: members/transactions/cycles all 0 for the id.
// 8. audit_log: member.deleted row with actor=collector.userId.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow — /members/:id delete (Story 2.6)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("typed SUPPRIMER + password re-auth → cascade delete + audit row lands", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "DELETE");
    const target = members[0]!;

    await page.goto(`/members/${target.memberId}`);
    await expect(page.getByRole("heading", { level: 1, name: /member delete-1/i })).toBeVisible();

    // --- 1. Supprimer button visible (small variant in the action group) ---
    const supprimerHeader = page.getByRole("button", { name: /^supprimer$/i });
    await expect(supprimerHeader).toBeVisible();

    // --- 2. Tap → dialog opens with summary ---
    await supprimerHeader.click();
    await expect(page.getByRole("heading", { level: 2, name: /member delete-1/i })).toBeVisible();
    // Seed inserts 1 transaction across 1 cycle.
    await expect(
      page.getByText(/1 transaction\(s\) sur 1 cycle\(s\) seront définitivement supprimés/i),
    ).toBeVisible();
    await expectNoA11yViolations(page, "/members/:id delete dialog open");

    // --- 3. Wrong word → Continuer disabled ---
    const confirmInput = page.getByLabel(/tapez SUPPRIMER pour confirmer/i);
    await confirmInput.fill("nope");
    await expect(page.getByRole("button", { name: /^continuer$/i })).toBeDisabled();

    // --- 4. SUPPRIMER typed → Continuer enabled, advances to password step ---
    await confirmInput.fill("SUPPRIMER");
    await expect(page.getByRole("button", { name: /^continuer$/i })).toBeEnabled();
    await page.getByRole("button", { name: /^continuer$/i }).click();
    await expect(page.getByLabel(/confirmez votre mot de passe/i)).toBeVisible();

    // --- 5. Wrong password → 401 → inline alert + dialog stays open ---
    await page.getByLabel(/confirmez votre mot de passe/i).fill("wrong-password");
    await page.getByRole("button", { name: /^supprimer définitivement$/i }).click();
    await expect(page.getByText(/mot de passe invalide/i)).toBeVisible();
    // Dialog still open (heading still rendered).
    await expect(page.getByRole("heading", { level: 2, name: /member delete-1/i })).toBeVisible();

    // Member still in DB.
    const { count: countBeforeRealPwd } = await service
      .from("members")
      .select("*", { count: "exact", head: true })
      .eq("id", target.memberId);
    expect(countBeforeRealPwd).toBe(1);

    // --- 6. Real password → 200 → delete RPC → toast → /members ---
    await page.getByLabel(/confirmez votre mot de passe/i).fill(seededCollector.password);
    await page.getByRole("button", { name: /^supprimer définitivement$/i }).click();
    await expect(page).toHaveURL(/\/members$/);

    // --- 7. Cascade complete: 0 rows in members + transactions + cycles ---
    const memberCheck = await service
      .from("members")
      .select("*", { count: "exact", head: true })
      .eq("id", target.memberId);
    expect(memberCheck.count).toBe(0);
    const txCheck = await service
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(txCheck.count).toBe(0);
    const cycleCheck = await service
      .from("cycles")
      .select("*", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(cycleCheck.count).toBe(0);

    // --- 8. audit_log row landed via the trigger ---
    const { data: events, error: auditErr } = await service
      .from("audit_log")
      .select("event_type, actor, entity_id")
      .eq("entity_id", target.memberId)
      .eq("event_type", "member.deleted");
    expect(auditErr, auditErr?.message).toBeNull();
    expect(events ?? []).toHaveLength(1);
    expect((events ?? [])[0]?.actor).toBe(seededCollector.userId);
  });
});
