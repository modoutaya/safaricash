// Story 9.1 / FR34 — dashboard polled-stats E2E.
//
// Loads /dashboard for a seeded collector and asserts the four stats wire
// up to real data (active-members count, commission this cycle, today's
// collection, recent activity), then asserts the dashboard stays rendered
// offline with the "Données locales" note.
//
// The stat ARITHMETIC (advance/undone exclusion, the today boundary, the
// commission aggregate) is exhaustively unit-tested in
// deriveDashboardStats.test.ts; this E2E proves the wiring + offline.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 9 — dashboard polled stats (Story 9.1)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("dashboard renders the four stats from real data + stays up offline", async ({
    page,
    context,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    // 2 members, each with a seed contribution (created today) + an active cycle.
    await seedMembersForCollector(service, seededCollector, 2, "DASH");

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: /tableau de bord/i })).toBeVisible();

    // --- Active-members count = 2. ---
    await expect(page.getByText("Membres actifs")).toBeVisible();
    await expect(page.getByText("2", { exact: true })).toBeVisible();

    // --- Commission this cycle = Σ commission(dailyAmount) = 2 × 500 = 1000.
    // Today's collection (2 seed contributions × 500) is also 1000, so the
    // "1 000" figure renders on both cards — assert at least one shows. ---
    await expect(page.getByText("Commission ce cycle")).toBeVisible();
    await expect(page.getByText(/1[\s ]?000/).first()).toBeVisible();

    // --- Today's collection — the 2 seed contributions landed today. ---
    await expect(page.getByText("Collecté aujourd'hui")).toBeVisible();

    // --- Recent activity — the seed contributions show as Cotisation rows. ---
    await expect(page.getByRole("heading", { level: 2, name: /activité récente/i })).toBeVisible();
    await expect(page.getByText(/Cotisation — Member DASH-/).first()).toBeVisible();

    // --- Offline — the dashboard stays rendered from cache + the note shows. ---
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));

    await expect(page.getByText(/données locales — synchronisation en attente/i)).toBeVisible();
    // The stats are still on screen (served from the cached read-model).
    await expect(page.getByText("Membres actifs")).toBeVisible();
    await expect(page.getByText("2", { exact: true })).toBeVisible();
  });
});
