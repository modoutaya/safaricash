// Story 4.4 — Flow 1 rattrapage E2E.
//
// Asserts the secondary-link reveal path (long-press is component-level
// only — Playwright pointer timing is flaky for that):
//   1. Tap card → action sheet → tap "Rattrapage" link → grid renders.
//   2. Tap × 3 jours → ProgressiveToast renders the rattrapage body.
//   3. Service-role assertions: transactions row with kind=rattrapage,
//      days_covered=3, decrypted amount = 1500. Audit transaction.committed
//      lands. sms_queue row queued.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 1 — record rattrapage online (Story 4.4)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("tap card → Rattrapage link → × 3 jours → ProgressiveToast + DB row + audit + sms_queue", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "RAT");
    const target = members[0]!;
    const targetName = "Member RAT-1";

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();

    // Open the action sheet.
    await page.getByRole("button", { name: new RegExp(targetName, "i") }).click();

    // Tap the secondary "Rattrapage" link.
    await page.getByRole("button", { name: /^rattrapage$/i }).click();

    // Grid renders 3 options; tap × 3 jours.
    const grid = page.getByRole("group", { name: /sélectionnez le nombre de jours/i });
    await expect(grid).toBeVisible();
    await page.getByRole("button", { name: /× 3 jours/i }).click();

    // ProgressiveToast renders with the rattrapage body.
    await expect(
      page.getByText(new RegExp(`rattrapage enregistré \\(3 jours\\) — ${targetName}`, "i")),
    ).toBeVisible();

    // A new rattrapage row landed.
    await expect
      .poll(
        async () => {
          const { count } = await service
            .from("transactions")
            .select("id", { count: "exact", head: true })
            .eq("member_id", target.memberId)
            .eq("kind", "rattrapage");
          return count;
        },
        { timeout: 5000 },
      )
      .toBe(1);

    const { data: txs } = await service
      .from("transactions")
      .select("id, kind, days_covered")
      .eq("member_id", target.memberId)
      .eq("kind", "rattrapage")
      .single();
    expect(txs?.days_covered).toBe(3);
    const newTxId = txs?.id;
    expect(newTxId).toBeTruthy();

    // Decrypted amount = 500 × 3 = 1500.
    const { data: decrypted } = await service
      .from("transactions_decrypted")
      .select("amount")
      .eq("id", newTxId!)
      .single();
    expect(Number(decrypted?.amount)).toBe(1500);

    // audit_log: transaction.committed row lands.
    const { data: auditRows } = await service
      .from("audit_log")
      .select("event_type, actor")
      .eq("entity_id", newTxId)
      .eq("event_type", "transaction.committed");
    expect(auditRows ?? []).toHaveLength(1);
    expect(auditRows?.[0]?.actor).toBe(seededCollector.userId);

    // sms_queue: 1 row enqueued (member has phone via seed fixture).
    const { count: smsCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("transaction_id", newTxId);
    expect(smsCount).toBe(1);
  });
});
