// Story 8.4 / FR42 — Flow 1 offline-replay E2E.
//
// Asserts the full offline-write loop opened by 8.2 and closed by 8.4:
//   1. Collector goes offline (context.setOffline(true)).
//   2. Records a contribution → useRecordContribution offline branch
//      fires → IndexedDB event log gets the event → connectivity pill
//      shows pending count + offline toast.
//   3. Connectivity returns (context.setOffline(false)) → window
//      `online` event fires → useReconciler triggers replayPendingEvents
//      → record_contribution RPC with p_event_id → server-side insert
//      with source='offline_reconciled' + audit transaction.committed.
//   4. Cache invalidates → member-list recency-sort puts the member back
//      at the top.
//
// The audit-log assertion is the "system-level proof" — the offline
// event made it from IDB → server, idempotent retry on any network
// glitch.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 1 — offline contribution replay (Story 8.4)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("offline contribution → online → reconciler drains → server has the row", async ({
    page,
    context,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "OFFREP");
    const target = members[0]!;
    const targetName = "Member OFFREP-1";

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();

    // Baseline: 1 transaction (the seed).
    const { count: countBefore } = await service
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(countBefore).toBe(1);

    // -------------------------------------------------------------------
    // Go offline + record the contribution (offline branch).
    // -------------------------------------------------------------------
    await context.setOffline(true);

    await page.getByRole("button", { name: new RegExp(targetName, "i") }).click();
    const primaryCta = page.getByRole("button", {
      name: /enregistrer cotisation — 500 FCFA/i,
    });
    await primaryCta.click();

    // Offline toast appears with the "Hors-ligne — envoi au prochain
    // réseau" copy (i18n key members.toast.offline, Story 8.3 wiring).
    await expect(page.getByText(/hors-ligne — envoi au prochain réseau/i)).toBeVisible();

    // Pill shows pending count = 1 (Story 8.3 + 8.4 BroadcastChannel
    // subscription refreshes via countEvents).
    await expect(page.getByText(/synchronisation • 1|hors-ligne • 1/i)).toBeVisible();

    // No server-side row yet — confirmed offline branch took over.
    const { count: countMidOffline } = await service
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("member_id", target.memberId);
    expect(countMidOffline).toBe(1);

    // -------------------------------------------------------------------
    // Come back online → reconciler drains.
    // -------------------------------------------------------------------
    await context.setOffline(false);
    // Playwright's CDP-level setOffline doesn't always reliably dispatch
    // the `window.online` event the hook listens for. Force-dispatch
    // here so the reconciler trigger is deterministic across CI
    // environments (Story 8.4 code-review patch MED).
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    // Wait for the server-side row to appear (reconciler has POSTed).
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
        { timeout: 15_000 },
      )
      .toBe(2);

    // Source flipped to 'offline_reconciled' on the just-replayed row.
    const { data: txs } = await service
      .from("transactions")
      .select("id, kind, source, event_id")
      .eq("member_id", target.memberId)
      .eq("kind", "contribution")
      .order("created_at", { ascending: false });
    const replayed = txs?.[0];
    expect(replayed?.source).toBe("offline_reconciled");
    expect(replayed?.event_id).toMatch(/^[0-9a-f-]{36}$/);

    // Audit log: transaction.committed event landed for the replayed tx.
    const { count: auditCount } = await service
      .from("audit_log")
      .select("event_id", { count: "exact", head: true })
      .eq("entity_id", replayed!.id)
      .eq("event_type", "transaction.committed");
    expect(auditCount).toBe(1);

    // Pill drops back to 0 (queue empty).
    await expect(page.getByText(/en ligne/i)).toBeVisible({ timeout: 10_000 });
  });
});
