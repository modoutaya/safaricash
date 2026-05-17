// Story 8.5 / FR43 / NFR-P7 — stalled-sync alert + manual retry E2E.
//
// Exercises the escalation Story 8.5 adds on top of the Stories 8.2-8.4
// offline-write loop:
//   1. Collector records a contribution offline → event queued in IDB.
//   2. Connectivity returns but the reconciler's replay is blocked
//      (record_contribution RPC aborted) → the event stays pending.
//   3. After the NFR-P7 threshold the ConnectivityIndicator escalates to
//      the `sync-failed` state ("Erreur").
//   4. The sync drawer shows the stalled operation + a "Retenter" CTA.
//   5. Replay is unblocked, the collector taps "Retenter" → the reconciler
//      drains with fresh context → pill returns to "En ligne".
//
// The 15-minute NFR-P7 threshold is overridden to 2 s via the documented
// `safaricash:e2e:stalled-threshold-ms` localStorage seam so the flow runs
// in seconds, not minutes.
//
// Replay is gated by a mutable `blockReplay` flag the route handler reads
// on every request — flipping it is synchronous and deterministic, which
// avoids the `page.unroute` propagation race (an in-flight reconciler
// drain could otherwise still hit a half-removed route).

import { expectNoA11yViolations } from "./fixtures/axe";
import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 8 — stalled-sync alert + manual retry (Story 8.5)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("offline write stalls past the threshold → sync-failed pill + drawer retry drains it", async ({
    page,
    context,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "STALL");
    const target = members[0]!;
    const targetName = "Member STALL-1";

    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();

    // Shrink the NFR-P7 threshold to 2 s for the test (documented seam).
    // Set BEFORE the offline write: useStalledSync reads the threshold once
    // per effect run (not reactively from localStorage), so it must be in
    // place before the effect runs with a non-empty queue. The offline
    // guard keeps the pill calm until reconnection regardless.
    await page.evaluate(() => {
      localStorage.setItem("safaricash:e2e:stalled-threshold-ms", "2000");
    });

    // Gate the reconciler's replay on a mutable flag: while blocked, every
    // record_contribution RPC is aborted so the event cannot drain. The
    // flag flip later is synchronous — no unroute race.
    let blockReplay = true;
    await page.route("**/rpc/record_contribution", async (route) => {
      if (blockReplay) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    // -------------------------------------------------------------------
    // Record a contribution offline.
    // -------------------------------------------------------------------
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));

    await page.getByRole("button", { name: new RegExp(targetName, "i") }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: /nouvelle transaction/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /confirmer la cotisation/i }).click();

    // Pill shows the offline pending count.
    await expect(page.getByText(/hors-ligne • 1/i)).toBeVisible();

    // -------------------------------------------------------------------
    // Reconnect — replay is blocked, so the event stays pending and the
    // pill escalates to sync-failed after the 2 s threshold.
    // -------------------------------------------------------------------
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByText(/erreur • 1/i)).toBeVisible({ timeout: 15_000 });

    // -------------------------------------------------------------------
    // Open the sync drawer → stalled banner + the pending operation + CTA.
    // -------------------------------------------------------------------
    await page.getByRole("button", { name: /statut de connexion/i }).click();
    await expect(page.getByText(/la synchronisation est bloquée/i)).toBeVisible();
    await expect(page.getByText(new RegExp(`cotisation — ${targetName}`, "i"))).toBeVisible();
    const retryButton = page.getByRole("button", { name: /retenter/i });
    await expect(retryButton).toBeVisible();

    // AC #22 — the stalled drawer is axe-clean (WCAG 2.1 AA, @axe-core/playwright).
    await expectNoA11yViolations(page, "sync drawer — sync-failed state");

    // -------------------------------------------------------------------
    // Unblock replay, tap "Retenter" → the reconciler drains with fresh
    // context and the server gets the row.
    // -------------------------------------------------------------------
    blockReplay = false;
    await retryButton.click();

    // Server-side row appears (seed contribution + the replayed one).
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

    // Queue empty → pill back to connected.
    await expect(page.getByText(/en ligne/i)).toBeVisible({ timeout: 10_000 });
  });
});
