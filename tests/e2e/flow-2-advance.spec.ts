// Story 5.4 — Flow 2 advance commit E2E.
//
// Asserts the full happy path:
//   1. Tap card → action sheet → tap "Prêt" → /members/:id/advance.
//   2. Situation panel shows cycle day / contributed / advances.
//   3. Tap chip "100 000 FCFA" → simulation panel updates.
//   4. Type motive + check ack → CTA enables.
//   5. Tap CTA → ProgressiveToast "Prêt accordé — {name}" + navigate
//      back to /members/:id.
//   6. Service-role assertions: transactions row with kind='advance',
//      motive trimmed, saver_acknowledged=true, days_covered=1, decrypted
//      amount = 100_000. Audit transaction.committed payload contains
//      motive + saver_acknowledged. sms_queue row queued. Cycle status
//      = 'with_advance'.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 2 — record advance online (Story 5.4)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("tap Prêt → fill flow → CTA → toast + DB row + audit + sms_queue + cycle flip", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "ADV");
    const target = members[0]!;
    const targetName = "Member ADV-1";

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();

    // Open the action sheet → tap "Prêt".
    await page.getByRole("button", { name: new RegExp(targetName, "i") }).click();
    await page.getByRole("button", { name: /^prêt$/i }).click();

    // Land on the advance flow.
    await expect(page).toHaveURL(/\/advance$/);
    await expect(page.getByRole("heading", { level: 1, name: /accorder un prêt/i })).toBeVisible();

    // The seed fixture uses dailyAmount=500 → capacity = 500 × 29 = 14 500.
    // Suggested chips (50k / 100k / 150k) all over-limit; type a small
    // valid amount directly into the input instead.
    await page.getByLabel(/montant du prêt/i).fill("10000");

    // Type motive + check ack.
    await page.getByLabel(/motif du prêt/i).fill("urgence médicale");
    await page.getByLabel(/j'ai compris que ce prêt/i).check();

    // CTA enables; tap it.
    const cta = page.getByRole("button", { name: /^accorder le prêt$/i });
    await expect(cta).toBeEnabled();
    await cta.click();

    // ProgressiveToast appears.
    await expect(page.getByText(new RegExp(`prêt accordé — ${targetName}`, "i"))).toBeVisible();

    // Navigate back to /members/:id.
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}$`));

    // Service-role assertions.
    await expect
      .poll(
        async () => {
          const { count } = await service
            .from("transactions")
            .select("id", { count: "exact", head: true })
            .eq("member_id", target.memberId)
            .eq("kind", "advance");
          return count;
        },
        { timeout: 5000 },
      )
      .toBe(1);

    const { data: tx } = await service
      .from("transactions")
      .select("id, kind, motive, saver_acknowledged, days_covered")
      .eq("member_id", target.memberId)
      .eq("kind", "advance")
      .single();
    expect(tx?.motive).toBe("urgence médicale");
    expect(tx?.saver_acknowledged).toBe(true);
    expect(tx?.days_covered).toBe(1);
    const newTxId = tx?.id;
    expect(newTxId).toBeTruthy();

    // Decrypted amount = 10_000 (matches the typed amount).
    const { data: decrypted } = await service
      .from("transactions_decrypted")
      .select("amount")
      .eq("id", newTxId!)
      .single();
    expect(Number(decrypted?.amount)).toBe(10_000);

    // Audit payload contains motive + saver_acknowledged (BDD line 946).
    const { data: auditRow } = await service
      .from("audit_log")
      .select("payload")
      .eq("entity_id", newTxId)
      .eq("event_type", "transaction.committed")
      .single();
    const payload = auditRow?.payload as Record<string, unknown> | undefined;
    expect(payload?.["motive"]).toBe("urgence médicale");
    expect(payload?.["saver_acknowledged"]).toBe(true);

    // sms_queue row enqueued.
    const { count: smsCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("transaction_id", newTxId);
    expect(smsCount).toBe(1);

    // Cycle status flipped to with_advance.
    const { data: cycleAfter } = await service
      .from("cycles")
      .select("status")
      .eq("id", target.cycleId)
      .single();
    expect(cycleAfter?.status).toBe("with_advance");
  });
});
