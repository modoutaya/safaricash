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
    await expect(
      page.getByRole("heading", { level: 1, name: /bonjour collecteur/i }),
    ).toBeVisible();

    // --- Active-members count = 2. ---
    await expect(page.getByText("Membres actifs")).toBeVisible();
    await expect(page.getByText("2", { exact: true })).toBeVisible();

    // --- Commission this cycle = Σ min(cotisé, daily) = 2 × min(500, 500) = 1000
    // (each member cotisé exactly one day). Today's collection (2 seed
    // contributions × 500) is also 1000.
    // 2026-05-24 — Collecté + Commission tiles are masked by default
    // (`*******`) for privacy; tap each to reveal then assert the value. ---
    await expect(page.getByText("Commission")).toBeVisible();
    await expect(page.getByText("Collecté")).toBeVisible();
    // Default-masked state.
    expect(await page.getByText("*******").count()).toBe(2);
    // Reveal both, assert the 1 000 figure shows.
    await page.getByRole("button", { name: /afficher le montant collecté/i }).click();
    await page.getByRole("button", { name: /afficher la commission/i }).click();
    await expect(page.getByText(/1[\s ]?000/).first()).toBeVisible();

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
