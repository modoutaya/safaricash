// Story 4.3 — Flow 1 online contribution commit E2E.
//
// Asserts the full happy path:
//   1. Tap card → action sheet opens with primary CTA showing the amount.
//   2. Tap primary CTA → ProgressiveToast appears (just-committed state).
//   3. Service-role check: transactions row exists with kind=contribution.
//   4. audit_log: transaction.committed event lands with actor=collector.
//   5. sms_queue: 1 row enqueued for the new tx.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 1 — record contribution online (Story 4.3)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("tap card → primary CTA → ProgressiveToast + DB row + audit + sms_queue", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "RECORD");
    const target = members[0]!;
    const targetName = "Member RECORD-1";

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();

    // Tap the seeded member's card → action sheet opens.
    await page.getByRole("button", { name: new RegExp(targetName, "i") }).click();
    const primaryCta = page.getByRole("button", {
      name: /enregistrer cotisation — 500 FCFA/i,
    });
    await expect(primaryCta).toBeVisible();

    // Capture the count of transactions for this member BEFORE the commit
    // (the seed inserts 1, so baseline = 1).
    const { count: countBefore } = await service
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(countBefore).toBe(1);

    // Commit the contribution.
    await primaryCta.click();

    // ProgressiveToast appears with the committed copy.
    await expect(
      page.getByText(new RegExp(`cotisation enregistrée — ${targetName}`, "i")),
    ).toBeVisible();

    // A new transaction row landed (count is now 2: seed + new).
    await expect
      .poll(
        async () => {
          const { count } = await service
            .from("transactions")
            .select("id", { count: "exact", head: true })
            .eq("member_id", target.memberId)
            .eq("kind", "contribution");
          return count;
        },
        { timeout: 5000 },
      )
      .toBe(2);

    // Find the just-inserted transaction (created_at most recent, kind=contribution).
    const { data: txs } = await service
      .from("transactions")
      .select("id, kind, source")
      .eq("member_id", target.memberId)
      .eq("kind", "contribution")
      .order("created_at", { ascending: false })
      .limit(1);
    const newTxId = txs?.[0]?.id;
    expect(newTxId).toBeTruthy();
    expect(txs?.[0]?.source).toBe("online");

    // audit_log: transaction.committed row lands with actor=collector.userId.
    const { data: auditRows } = await service
      .from("audit_log")
      .select("event_type, actor")
      .eq("entity_id", newTxId)
      .eq("event_type", "transaction.committed");
    expect(auditRows ?? []).toHaveLength(1);
    expect(auditRows?.[0]?.actor).toBe(seededCollector.userId);

    // sms_queue: 1 row enqueued for this transaction.
    const { count: smsCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("transaction_id", newTxId);
    expect(smsCount).toBe(1);

    // -----------------------------------------------------------------
    // Story 4.5 — soft-undo within the 5-second window.
    // -----------------------------------------------------------------
    await page.getByRole("button", { name: /annuler \(\ds\)/i }).click();

    // 1. transactions.undone_at populated.
    await expect
      .poll(
        async () => {
          const { data } = await service
            .from("transactions")
            .select("undone_at")
            .eq("id", newTxId)
            .single();
          return data?.undone_at;
        },
        { timeout: 5000 },
      )
      .not.toBeNull();

    // 2. transactions_decrypted view filters out the undone row.
    const { data: viewRow } = await service
      .from("transactions_decrypted")
      .select("id")
      .eq("id", newTxId)
      .maybeSingle();
    expect(viewRow).toBeNull();

    // 3. Audit transaction.undone event lands.
    const { count: undoneCount } = await service
      .from("audit_log")
      .select("event_id", { count: "exact", head: true })
      .eq("entity_id", newTxId)
      .eq("event_type", "transaction.undone");
    expect(undoneCount).toBe(1);

    // 4. sms_queue row → abandoned.
    const { data: smsAfter } = await service
      .from("sms_queue")
      .select("status")
      .eq("transaction_id", newTxId)
      .single();
    expect(smsAfter?.status).toBe("abandoned");
  });
});
