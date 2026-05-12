// Story 6.6 — /members/:id "Renvoyer l'historique" E2E.
//
// Asserts the full FR33 surface end-to-end:
// 1. "Renvoyer l'historique" button visible when current cycle is active.
// 2. Tap → dialog opens with title + password prompt.
// 3. Wrong password → inline alert + dialog stays open + no sms_queue rows.
// 4. Real password → 200 { enqueued: 2 } → success toast.
// 5. Service-role check: 2 sms_queue rows with template_key='resend' for the
//    member's transactions; 1 sms.resend_initiated audit event.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow — /members/:id resend history (Story 6.6)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("password re-auth → 2 resend SMS enqueued + audit event", async ({
    page,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    // Seed 1 member with 2 contributions (the helper records 1 by default;
    // we add a second via service-role to keep the seed shape predictable).
    const members = await seedMembersForCollector(service, seededCollector, 1, "RESEND");
    const target = members[0]!;

    // Add a second contribution via the existing transactions table —
    // mirrors the production trigger flow without going through the UI.
    const { data: existingTx } = await service
      .from("transactions")
      .select("id, cycle_day, amount_encrypted")
      .eq("member_id", target.memberId)
      .order("created_at", { ascending: true });
    const firstTx = existingTx?.[0];
    expect(firstTx).toBeDefined();
    if (!firstTx) throw new Error("seed did not produce a transaction row");
    // record_contribution via service-role-bypassed RPC isn't trivial; instead
    // INSERT a second row reusing the encrypted-amount blob from the first.
    await service.from("transactions").insert({
      collector_id: seededCollector.userId,
      member_id: target.memberId,
      cycle_id: target.cycleId,
      kind: "contribution",
      amount_encrypted: firstTx.amount_encrypted,
      cycle_day: 2,
      source: "online",
    });

    await page.goto(`/members/${target.memberId}`);
    await expect(page.getByRole("heading", { level: 1, name: /member resend-1/i })).toBeVisible();

    // --- 1. Button visible ---
    const resendButton = page.getByRole("button", { name: /^renvoyer l'historique$/i });
    await expect(resendButton).toBeVisible();

    // --- 2. Tap → dialog opens ---
    await resendButton.click();
    await expect(
      page.getByRole("heading", { level: 2, name: /renvoyer l'historique du cycle/i }),
    ).toBeVisible();
    await expect(page.getByLabel(/confirmez votre mot de passe/i)).toBeVisible();

    // --- 3. Wrong password → inline alert + dialog stays open ---
    await page.getByLabel(/confirmez votre mot de passe/i).fill("wrong-password");
    await page.getByRole("button", { name: /^confirmer$/i }).click();
    await expect(page.getByText(/mot de passe invalide/i)).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: /renvoyer l'historique du cycle/i }),
    ).toBeVisible();

    // No 'resend' sms_queue rows yet.
    const { count: beforeResendCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("template_key", "resend");
    expect(beforeResendCount).toBe(0);

    // --- 4. Real password → success toast ---
    await page.getByLabel(/confirmez votre mot de passe/i).fill(seededCollector.password);
    await page.getByRole("button", { name: /^confirmer$/i }).click();
    await expect(page.getByText(/2 rappels envoyés/i)).toBeVisible();

    // --- 5. Service-role checks ---
    const { count: afterResendCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("template_key", "resend");
    expect(afterResendCount).toBe(2);

    const { count: auditCount } = await service
      .from("audit_log")
      .select("event_id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("event_type", "sms.resend_initiated");
    expect(auditCount).toBe(1);
  });
});
