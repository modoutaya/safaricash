// Story 7.4 — Flow 3 cycle-settlement E2E.
//
// Asserts the full settlement ceremony end-to-end:
// 1. Seed a member with cycle.status flipped to 'completed' via service role.
// 2. Navigate to the profile — "Payer le membre" CTA visible (Story 12.4 rename).
// 3. Tap → /members/:id/settlement renders SettlementSummaryCard.
// 4. Tap "Confirmer le paiement" → SettlementReauthDialog opens.
// 5. Wrong password → inline alert, dialog stays open.
// 6. Real password → EnvelopeHandoverScreen renders with the payout amount.
// 7. Service-role checks: cycle.status='settled' + audit cycle.settled + 1
//    sms_queue row with template_key='settlement'.
//
// Builds on Stories 7.1 (card), 7.2 (envelope), 7.3 (route + entry CTA).

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow 3 — cycle settlement (Story 7.4)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("happy path — completed cycle → settle → EnvelopeHandoverScreen + side-effects", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "SETTLE");
    const target = members[0]!;

    // Flip the cycle to 'completed' so settlement is available. The seed
    // helper creates the cycle in 'active'.
    await service.from("cycles").update({ status: "completed" }).eq("id", target.cycleId);

    // --- 1. Profile shows "Payer le membre" CTA when cycle.status === "completed" ---
    await page.goto(`/members/${target.memberId}`);
    await expect(page.getByRole("heading", { level: 1, name: /member settle-1/i })).toBeVisible();
    const settleLink = page.getByRole("link", { name: /^payer le membre$/i });
    await expect(settleLink).toBeVisible();
    await expect(settleLink).toHaveAttribute(
      "href",
      new RegExp(`/members/${target.memberId}/settlement$`),
    );

    // --- 2. Tap → settlement route mounts the card ---
    await settleLink.click();
    await expect(
      page.getByRole("heading", { level: 1, name: /paiement du membre/i }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: /member settle-1/i })).toBeVisible();
    // Final payout = 500 × 29 − 0 (no advances seeded) = 14 500 FCFA.
    await expect(page.getByText(/14[\s\u00a0]500 FCFA/)).toBeVisible();

    // --- 3. Tap "Confirmer le paiement" → dialog opens ---
    await page.getByRole("button", { name: /^confirmer le paiement$/i }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: /^confirmation requise$/i }),
    ).toBeVisible();
    await expect(page.getByLabel(/^mot de passe$/i)).toBeVisible();

    // --- 4. Wrong password → inline alert + dialog stays open ---
    await page.getByLabel(/^mot de passe$/i).fill("wrong-password");
    await page.getByRole("button", { name: /^valider le paiement$/i }).click();
    await expect(page.getByRole("alert").first()).toContainText(/mot de passe incorrect/i);
    await expect(
      page.getByRole("heading", { level: 2, name: /^confirmation requise$/i }),
    ).toBeVisible();

    // No 'settlement' sms_queue rows yet (commit hasn't fired).
    const { count: beforeSettlementCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("template_key", "settlement");
    expect(beforeSettlementCount).toBe(0);

    // --- 5. Real password → EnvelopeHandoverScreen ---
    await page.getByLabel(/^mot de passe$/i).fill(seededCollector.password);
    await page.getByRole("button", { name: /^valider le paiement$/i }).click();
    await expect(page.getByRole("heading", { level: 2, name: /^paiement effectué$/i })).toBeVisible(
      {
        timeout: 10_000,
      },
    );
    await expect(page.getByText(/14[\s\u00a0]500 FCFA/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^retour aux membres$/i })).toBeVisible();

    // --- 6. Service-role checks ---
    // Cycle status flipped to 'settled' + settled_at populated.
    const { data: settledCycle } = await service
      .from("cycles")
      .select("status, settled_at")
      .eq("id", target.cycleId)
      .single();
    expect(settledCycle?.status).toBe("settled");
    expect(settledCycle?.settled_at).not.toBeNull();

    // Audit emitted cycle.settled.
    const { count: auditCount } = await service
      .from("audit_log")
      .select("event_id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("event_type", "cycle.settled");
    expect(auditCount).toBe(1);

    // sms_queue has one settlement row.
    const { count: afterSettlementCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("template_key", "settlement");
    expect(afterSettlementCount).toBe(1);

    // Story 7.5 — SMS body matches the new template: firstName + cycle
    // date range + receipt URL. Code-review patch #1 — closing statement
    // ('Merci.') moved to the Worker receipt page to preserve the 160-
    // char single-SMS cap. Patch #6 — firstName presence asserted.
    const { data: settlementSmsRows } = await service
      .from("sms_queue")
      .select("body")
      .eq("collector_id", seededCollector.userId)
      .eq("template_key", "settlement");
    expect(settlementSmsRows?.length).toBe(1);
    const settlementBody = settlementSmsRows?.[0]?.body as string;
    // The seeded member is "Member SETTLE-1" → firstName "Member" (6 chars).
    expect(settlementBody).toMatch(/^SafariCash\. \w+, /);
    expect(settlementBody).toMatch(/votre cycle du \d{2}\/\d{2} au \d{2}\/\d{2} est clos\./);
    expect(settlementBody).toContain("Vous avez recu");
    expect(settlementBody).toContain("FCFA");
    expect(settlementBody).toMatch(/Detail: https?:\/\/.+\/r\/[0-9a-f]{32}\./);
    // GSM-7 single-SMS discipline: ≤ 160 chars worst-case.
    expect(settlementBody.length).toBeLessThanOrEqual(160);

    // transactions has one kind='settlement' row with cycle_day=30.
    const { data: settlementTxs } = await service
      .from("transactions")
      .select("kind, cycle_day")
      .eq("cycle_id", target.cycleId)
      .eq("kind", "settlement");
    expect(settlementTxs?.length).toBe(1);
    expect(settlementTxs?.[0]?.cycle_day).toBe(30);

    // --- 7. "Retour aux membres" navigates back to the list ---
    await page.getByRole("button", { name: /^retour aux membres$/i }).click();
    await expect(page).toHaveURL(/\/members$/);
  });
});
