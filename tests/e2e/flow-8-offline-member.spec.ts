// Story 8.6 / FR40 — offline member read + edit E2E.
//
// Exercises the final piece of Epic 8 — the member surface offline:
//   1. Online: visit /members + the edit route → the member query cache
//      is persisted to localStorage (TanStack Query persistence).
//   2. Assert the persisted payload carries the member (cold-start data).
//   3. Go offline → edit the member's daily amount → the edit is QUEUED
//      as a member.updated event (not sent), the route lands on the
//      profile which renders offline from cache + the "Données locales"
//      note, and the connectivity pill shows a pending count.
//   4. The server row is unchanged while offline.
//   5. Back online → the reconciler replays member.updated → update_member
//      → the server row reflects the edit + members.last_event_id is set.
//
// Note on the read path: a true cold reload while offline also needs the
// PWA service worker to serve the app shell (inactive in dev/E2E). This
// spec proves the DATA half — the persisted localStorage payload + offline
// rendering from cache after an in-SPA transition; the shell half is a
// production-SW concern out of E2E reach.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 8 — offline member lookup + edit (Story 8.6)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("offline member edit queues a member.updated event → reconciler drains it on reconnect", async ({
    page,
    context,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "OFFMBR");
    const target = members[0]!;
    const targetName = "Member OFFMBR-1";

    // -------------------------------------------------------------------
    // Online — visit the list + the edit route so both member queries are
    // populated and persisted.
    // -------------------------------------------------------------------
    await page.goto("/members");
    await expect(page.getByRole("heading", { level: 1, name: /membres/i })).toBeVisible();
    await expect(page.getByText(targetName)).toBeVisible();

    // Wait until the member-LIST query is durably persisted BEFORE navigating
    // away — the persister is throttled, so a too-quick goto would lose it.
    // This also proves the persisted payload carries the member (cold-start
    // data survival).
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("safaricash:query-cache") ?? ""), {
        timeout: 10_000,
      })
      .toContain(targetName);

    // The edit route boots a fresh app that rehydrates the persisted list
    // query + fetches & persists the profile query.
    await page.goto(`/members/${target.memberId}/edit`);
    await expect(page.getByLabel("Cotisation quotidienne (FCFA)")).toBeVisible();

    // -------------------------------------------------------------------
    // Go offline + edit the daily amount.
    // -------------------------------------------------------------------
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));

    await page.getByLabel("Cotisation quotidienne (FCFA)").fill("1000");
    await page.getByRole("button", { name: /^enregistrer$/i }).click();

    // Offline toast tells the truth — the edit was queued, not applied.
    await expect(page.getByText(/modification enregistrée hors-ligne/i)).toBeVisible();

    // Lands on the profile, rendered offline from cache, with the
    // "Données locales" note and the optimistic new amount.
    await expect(page).toHaveURL(new RegExp(`/members/${target.memberId}$`));
    await expect(page.getByText(/données locales — synchronisation en attente/i)).toBeVisible();
    await expect(page.getByText(/1[\s\u00a0]?000\s+FCFA\s+\/\s+jour/)).toBeVisible();

    // The connectivity pill counts the queued event.
    await expect(page.getByText(/hors-ligne • 1/i)).toBeVisible();

    // The server row is NOT changed while offline.
    const { data: midRow } = await service
      .from("members")
      .select("daily_amount, last_event_id")
      .eq("id", target.memberId)
      .single();
    expect(midRow?.daily_amount).toBe(500);
    expect(midRow?.last_event_id).toBeNull();

    // -------------------------------------------------------------------
    // Offline read + search — navigate back to the list (client-side, no
    // network) and filter it from the persisted cache.
    // -------------------------------------------------------------------
    await page.getByRole("button", { name: /retour à la liste des membres/i }).click();
    await expect(page).toHaveURL(/\/members$/);
    await expect(page.getByText(/données locales — synchronisation en attente/i)).toBeVisible();
    await expect(page.getByText(targetName)).toBeVisible();

    const search = page.getByRole("searchbox");
    await search.fill("zzz-no-such-member");
    await expect(page.getByText(targetName)).toBeHidden();
    await search.fill("OFFMBR");
    await expect(page.getByText(targetName)).toBeVisible();

    // -------------------------------------------------------------------
    // Back online — the reconciler replays member.updated → update_member.
    // -------------------------------------------------------------------
    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect
      .poll(
        async () => {
          const { data } = await service
            .from("members")
            .select("daily_amount")
            .eq("id", target.memberId)
            .single();
          return data?.daily_amount;
        },
        { timeout: 15_000 },
      )
      .toBe(1000);

    // The idempotency column was written by the replayed RPC.
    const { data: finalRow } = await service
      .from("members")
      .select("last_event_id")
      .eq("id", target.memberId)
      .single();
    expect(finalRow).not.toBeNull();
    expect(finalRow?.last_event_id).toBeTruthy();

    // Exactly one member.updated audit row — the reconciler replayed once
    // and the p_event_id idempotency prevented a duplicate.
    const { count: auditCount } = await service
      .from("audit_log")
      .select("event_id", { count: "exact", head: true })
      .eq("entity_id", target.memberId)
      .eq("event_type", "member.updated");
    expect(auditCount).toBe(1);
  });
});
