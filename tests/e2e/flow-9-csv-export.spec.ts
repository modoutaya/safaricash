// Story 9.3 / FR37 + FR5 — CSV export E2E.
//
// Asserts the full export surface end-to-end on /settings:
// 1. "Exporter en CSV" action visible.
// 2. Tap → password re-auth dialog opens.
// 3. Wrong password → re-auth 401 → inline error, NO download.
// 4. Correct password → re-auth 200 → TWO CSV downloads occur.
// 5. The downloaded CSVs carry the header + a known seeded row.
// 6. audit_log: an export.csv_generated row landed for the collector.

import { readFileSync } from "node:fs";

import type { Download } from "@playwright/test";

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";
import { expectNoA11yViolations } from "./fixtures/axe";

test.describe("Flow 9 — CSV export (Story 9.3)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("password re-auth → two CSV downloads + an export.csv_generated audit row", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    // 1 member → 1 active cycle + 1 contribution (amount 500).
    const [seed] = await seedMembersForCollector(service, seededCollector, 1, "EXP");

    // Collect every download the page triggers.
    const downloads: Download[] = [];
    page.on("download", (d) => downloads.push(d));

    await page.goto("/settings");

    // --- 1. The export action is visible. ---
    const exportCta = page.getByRole("button", { name: /^exporter en csv$/i });
    await expect(exportCta).toBeVisible();

    // --- 2. Tap → the re-auth dialog opens. ---
    await exportCta.click();
    await expect(page.getByRole("heading", { level: 2, name: /^exporter en csv$/i })).toBeVisible();
    await expect(page.getByLabel(/confirmez votre mot de passe/i)).toBeVisible();
    await expectNoA11yViolations(page, "/settings CSV export dialog open");

    // --- 3. Wrong password → 401 → inline error, nothing downloaded. ---
    await page.getByLabel(/confirmez votre mot de passe/i).fill("wrong-password");
    await page.getByRole("button", { name: /^exporter$/i }).click();
    await expect(page.getByText(/mot de passe invalide/i)).toBeVisible();
    expect(downloads).toHaveLength(0);
    // Dialog still open.
    await expect(page.getByRole("heading", { level: 2, name: /^exporter en csv$/i })).toBeVisible();

    // --- 4. Correct password → 200 → two CSV downloads. ---
    await page.getByLabel(/confirmez votre mot de passe/i).fill(seededCollector.password);
    await page.getByRole("button", { name: /^exporter$/i }).click();

    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(2);

    // --- 5. The CSV files: filenames + content. ---
    const byName = new Map<string, string>();
    for (const d of downloads) {
      const path = await d.path();
      byName.set(d.suggestedFilename(), readFileSync(path, "utf8"));
    }

    const cyclesEntry = [...byName.entries()].find(([name]) =>
      name.startsWith("safaricash-cycles-"),
    );
    const txEntry = [...byName.entries()].find(([name]) =>
      name.startsWith("safaricash-transactions-"),
    );
    expect(cyclesEntry, "cycles CSV downloaded").toBeTruthy();
    expect(txEntry, "transactions CSV downloaded").toBeTruthy();

    const cyclesCsv = cyclesEntry![1];
    const txCsv = txEntry![1];

    // Cycle-summary CSV — header + the seeded cycle row.
    expect(cyclesCsv.split("\r\n")[0]).toBe(
      "cycle_id,member_name,cycle_start_date,cycle_end_date,total_contributions,advances_sum,commission,final_payout,status",
    );
    expect(cyclesCsv).toContain(seed!.cycleId);
    expect(cyclesCsv).toContain("Member EXP-1");

    // Transaction-history CSV — header + the seeded contribution row.
    expect(txCsv.split("\r\n")[0]).toBe("transaction_id,date,kind,amount,member_id,member_name");
    expect(txCsv).toContain(seed!.transactionId);
    expect(txCsv).toContain("contribution");

    // --- 6. audit_log — an export.csv_generated row landed. ---
    await expect
      .poll(async () => {
        const { data } = await service
          .from("audit_log")
          .select("event_type, actor, entity_id, entity_table")
          .eq("collector_id", seededCollector.userId)
          .eq("event_type", "export.csv_generated");
        return data ?? [];
      })
      .toHaveLength(1);

    const { data: events } = await service
      .from("audit_log")
      .select("actor, entity_id, entity_table")
      .eq("collector_id", seededCollector.userId)
      .eq("event_type", "export.csv_generated");
    expect(events![0]!.actor).toBe(seededCollector.userId);
    expect(events![0]!.entity_id).toBe(seededCollector.userId);
    expect(events![0]!.entity_table).toBe("users");
  });
});
