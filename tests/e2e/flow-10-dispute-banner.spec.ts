// Story 10.3 / FR33b — collector-side dispute banner E2E.
//
// Seeds a collector + member + transaction + an OPEN disputes row, then:
// 1. /members/{id} shows the dispute banner + a per-row dispute icon.
// 2. /dashboard shows NO dispute banner (FR33b — disputes stay private).
// 3. Tapping the banner opens the detail sheet (saver message + date).
// 4. "Marquer comme résolue" → the banner clears + a dispute.resolved
//    audit_log row lands.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 10 — dispute banner on the member profile (Story 10.3)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("open dispute → banner + icon + detail + resolve, never on the dashboard", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const [seed] = await seedMembersForCollector(service, seededCollector, 1, "DISP");
    const memberId = seed!.memberId;
    const transactionId = seed!.transactionId;

    // Seed one OPEN dispute on the seeded transaction.
    await service.from("disputes").insert({
      collector_id: seededCollector.userId,
      transaction_id: transactionId,
      notes: "Je n'ai jamais reçu cet argent",
    });

    try {
      // --- 1. The member profile shows the banner + the row icon. ---
      await page.goto(`/members/${memberId}`);
      await expect(page.getByText("Transaction contestée").first()).toBeVisible();
      await expect(page.getByText(/a contesté une transaction/i)).toBeVisible();
      // The disputed transaction row carries the dispute icon.
      await expect(page.locator('[aria-label="Cette transaction est contestée"]')).toBeVisible();

      // --- 2. The dashboard shows NO dispute banner. ---
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { level: 1, name: /bonjour collecteur/i }),
      ).toBeVisible();
      await expect(page.getByText("Transaction contestée")).toHaveCount(0);

      // --- 3. Tap the banner → the detail sheet. ---
      await page.goto(`/members/${memberId}`);
      await page.getByRole("button", { name: /voir le détail/i }).click();
      await expect(page.getByRole("heading", { name: /détail de la contestation/i })).toBeVisible();
      await expect(page.getByText("Je n'ai jamais reçu cet argent")).toBeVisible();

      // --- 4. "Marquer comme résolue" → the banner clears. ---
      await page.getByRole("button", { name: /marquer comme résolue/i }).click();
      await expect(page.getByText("Transaction contestée")).toHaveCount(0);

      // A dispute.resolved audit_log row landed for the collector.
      await expect
        .poll(async () => {
          const { data } = await service
            .from("audit_log")
            .select("event_type")
            .eq("collector_id", seededCollector.userId)
            .eq("event_type", "dispute.resolved");
          return data ?? [];
        })
        .toHaveLength(1);

      // The dispute row is now resolved.
      const { data: disputes } = await service
        .from("disputes")
        .select("status, resolved_at")
        .eq("transaction_id", transactionId);
      expect(disputes ?? []).toHaveLength(1);
      expect(disputes![0]!.status).toBe("resolved");
      expect(disputes![0]!.resolved_at).not.toBeNull();
    } finally {
      // disputes FK to transactions / users is ON DELETE RESTRICT — drop the
      // dispute rows before the seededCollector fixture tears the collector down.
      await service.from("disputes").delete().eq("collector_id", seededCollector.userId);
    }
  });
});
