// Story 2.7 — /members/:id cycle-restart E2E.
//
// Asserts the full FR12 surface end-to-end:
// 1. Member with completed cycle → Restart button visible.
// 2. Tap → confirmation dialog opens with title + body.
// 3. Annuler → dialog closes, no DB change (cycle count stable).
// 4. Tap again → Confirm → toast → profile re-renders with day 1 of 30.
// 5. "Cycles précédents" section now lists the previous (completed) cycle.
// 6. audit_log row exists with event_type='cycle.started' and the
//    collector as actor.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow — /members/:id cycle restart (Story 2.7)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("complete cycle → tap Restart → confirm → new cycle created + audit row lands", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "RESTART");
    const target = members[0]!;

    // Flip the seeded cycle to 'completed' so the restart action is visible.
    const { error: updErr } = await service
      .from("cycles")
      .update({ status: "completed" })
      .eq("id", target.cycleId);
    expect(updErr, updErr?.message).toBeNull();

    await page.goto(`/members/${target.memberId}`);
    await expect(page.getByRole("heading", { level: 1, name: /member restart-1/i })).toBeVisible();

    // --- 1. Restart button visible ---
    const restartButton = page.getByRole("button", { name: /^redémarrer le cycle$/i });
    await expect(restartButton).toBeVisible();
    await expectNoA11yViolations(page, "/members/:id with completed cycle");

    // --- 2. Tap → dialog opens ---
    await restartButton.click();
    await expect(
      page.getByRole("heading", { level: 2, name: /redémarrer le cycle ?/i }),
    ).toBeVisible();
    await expect(page.getByText(/un nouveau cycle de 30 jours va démarrer/i)).toBeVisible();

    // --- 3. Annuler → dialog closes, cycle count stable (still 1) ---
    await page.getByRole("button", { name: /^annuler$/i }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: /redémarrer le cycle ?/i }),
    ).not.toBeVisible();

    const { count: countAfterCancel } = await service
      .from("cycles")
      .select("*", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(countAfterCancel).toBe(1);

    // --- 4. Re-open + Confirm → mutation succeeds, profile updates ---
    await page.getByRole("button", { name: /^redémarrer le cycle$/i }).click();
    await page.getByRole("button", { name: /^redémarrer$/i }).click();

    // Profile re-renders with day 1 of 30 + the just-completed cycle now in history.
    await expect(page.getByText(/Jour 1 sur 30/i)).toBeVisible();

    // --- 5. "Cycles précédents" section visible with one row ---
    await expect(page.getByRole("heading", { level: 2, name: /cycles précédents/i })).toBeVisible();
    await expect(page.getByText(/^Cycle 1 — du /)).toBeVisible();

    // --- 6. audit_log row landed via the trigger ---
    const { data: events, error: auditErr } = await service
      .from("audit_log")
      .select("event_type, actor")
      .eq("collector_id", seededCollector.userId)
      .eq("event_type", "cycle.started");
    expect(auditErr, auditErr?.message).toBeNull();
    // 2 cycle.started rows: the one from seedMembersForCollector (actor=
    // 'system' because the seed runs under service-role JWT) + the one we
    // just triggered via the browser session (actor=collector.userId
    // thanks to the Story 2.5 audit-trigger fix in migration 0017).
    expect(events ?? []).toHaveLength(2);
    expect((events ?? []).some((e) => e.actor === seededCollector.userId)).toBe(true);
    expect((events ?? []).some((e) => e.actor === "system")).toBe(true);

    // Cycle count is now 2.
    const { count: countAfterRestart } = await service
      .from("cycles")
      .select("*", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(countAfterRestart).toBe(2);
  });
});
