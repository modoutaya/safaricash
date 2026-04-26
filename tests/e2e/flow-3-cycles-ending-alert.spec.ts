// Story 3.5 — Flow 3 cycles-ending dashboard alert E2E.
//
// Asserts the full happy path:
//   1. Seed members with mixed cycle-ending positions (in/out of window,
//      day-30 boundary, terminé status).
//   2. Navigate to /dashboard → alert renders the count of in-window
//      non-terminé members.
//   3. Tap "Voir" → URL is /members?filter=cycles-ending → only in-window
//      members visible.
//   4. Tap dismiss-filter chip → URL strips the param → all visible-status
//      members reappear.
//   5. Back to /dashboard → tap × → alert disappears.
//   6. Reload /dashboard → alert STILL hidden (sessionStorage persists).

import { E2E_SEED_READY, buildServiceClient, expect, test } from "./fixtures/seed-collector";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SeededCollector } from "./fixtures/seed-collector";

const MS_PER_DAY = 86_400_000;

/** Seed 1 member with an active cycle starting `daysAgo` days ago, so the
 *  member's cycle has `daysAgo + 1 = cycleDay` (computed by Story 2.1's
 *  `computeCycleDay`). */
async function seedMemberAtCycleDay(
  service: SupabaseClient,
  collector: SeededCollector,
  label: string,
  cycleDay: number,
  memberStatus: "active" | "completed" = "active",
): Promise<{ memberId: string; cycleId: string }> {
  const startMs = Date.now() - (cycleDay - 1) * MS_PER_DAY;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(startMs + 29 * MS_PER_DAY).toISOString().slice(0, 10);

  const { data: nameSecret, error: nameErr } = await service.rpc("vault_encrypt", {
    plaintext: `Member ${label}`,
  });
  if (nameErr || !nameSecret) throw new Error(`vault_encrypt(name): ${nameErr?.message}`);

  const { data: phoneSecret, error: phoneErr } = await service.rpc("vault_encrypt", {
    plaintext: `+221770000000`,
  });
  if (phoneErr || !phoneSecret) throw new Error(`vault_encrypt(phone): ${phoneErr?.message}`);

  const { data: member, error: memberErr } = await service
    .from("members")
    .insert({
      collector_id: collector.userId,
      name_encrypted: nameSecret,
      phone_number_encrypted: phoneSecret,
      daily_amount: 500,
      status: memberStatus,
    })
    .select("id")
    .single();
  if (memberErr || !member) throw new Error(`insert member(${label}): ${memberErr?.message}`);

  const cycleStatus = memberStatus === "completed" ? "completed" : "active";
  const { data: cycle, error: cycleErr } = await service
    .from("cycles")
    .insert({
      collector_id: collector.userId,
      member_id: member.id,
      cycle_number: 1,
      start_date: startDate,
      end_date: endDate,
      status: cycleStatus,
    })
    .select("id")
    .single();
  if (cycleErr || !cycle) throw new Error(`insert cycle(${label}): ${cycleErr?.message}`);

  return { memberId: member.id, cycleId: cycle.id };
}

test.describe("Flow 3 — cycles-ending dashboard alert (Story 3.5)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("dashboard alert renders count, tap Voir filters list, dismiss × persists across reload", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();

    // Seed 4 members — A (day 25, in-window), B (day 10, out), C (day 30, in
    // boundary), D (day 30 + member.status=completed → displayStatus=termine).
    await seedMemberAtCycleDay(service, seededCollector, "InWindow-A", 25);
    await seedMemberAtCycleDay(service, seededCollector, "OutOfWindow-B", 10);
    await seedMemberAtCycleDay(service, seededCollector, "Boundary-C", 30);
    await seedMemberAtCycleDay(service, seededCollector, "Termine-D", 30, "completed");

    await page.goto("/dashboard");

    // Alert renders with the count = 2 (A + C; D is termine, B is out).
    await expect(page.getByText(/Cycles se terminant cette semaine/)).toBeVisible();
    await expect(page.getByText(/2 membres — clôture imminente/)).toBeVisible();

    // Tap "Voir" → /members?filter=cycles-ending; only A + C visible.
    await page.getByRole("link", { name: /^voir$/i }).click();
    await expect(page).toHaveURL(/\?filter=cycles-ending$/);
    await expect(page.getByRole("heading", { level: 2, name: /InWindow-A/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /Boundary-C/ })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /OutOfWindow-B/ })).toHaveCount(0);
    // D is termine → hidden by the existing chip filter logic.
    await expect(page.getByRole("heading", { level: 2, name: /Termine-D/ })).toHaveCount(0);

    // Tap the dismiss-filter chip → URL strips the param.
    await page.getByRole("button", { name: /cycles à clôturer/i }).click();
    await expect(page).not.toHaveURL(/\?filter=cycles-ending/);
    await expect(page.getByRole("heading", { level: 2, name: /OutOfWindow-B/ })).toBeVisible();

    // Back to /dashboard → dismiss the alert.
    await page.goto("/dashboard");
    await page.getByRole("button", { name: /masquer cette alerte/i }).click();
    await expect(page.getByText(/Cycles se terminant cette semaine/)).toHaveCount(0);

    // Reload → alert STILL hidden (sessionStorage persists across reload).
    await page.reload();
    await expect(page.getByText(/Cycles se terminant cette semaine/)).toHaveCount(0);
  });
});
