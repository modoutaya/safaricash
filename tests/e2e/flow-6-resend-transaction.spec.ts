// Story 6.7 — Per-transaction receipt share / resend E2E.
//
// 3 scenarios:
//   1. Resend path — tap tx row → sheet opens → tap "Renvoyer par SMS" →
//      service-role check that 1 resend row landed in sms_queue with
//      template_key='resend' for the selected transaction.
//   2. Share fallback (clipboard) — tap "Partager le reçu" → toast
//      confirming clipboard copy → read clipboard via Playwright API and
//      assert URL matches /r/{32 hex}.
//   3. Opt-out gate — saver opted out → SMS button disabled with caption.

import {
  E2E_SEED_READY,
  buildServiceClient,
  expect,
  seedMembersForCollector,
  test,
} from "./fixtures/seed-collector";

test.describe("Flow — /members/:id per-transaction receipt (Story 6.7)", () => {
  test.skip(
    !E2E_SEED_READY,
    "SUPABASE_TEST_SEED_READY not set — needs the Story 1.8 CI seedCollector wiring",
  );

  test("tap row → sheet → Renvoyer par SMS → 1 resend row + audit event", async ({
    page,
    seededCollector,
  }) => {
    // [Debug] Forward browser console to CI stdout so the [resend-tx-debug]
    // logs from [id].tsx are visible in the workflow output. Remove once the
    // CI failure is understood.
    page.on("console", (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}]`, msg.text());
    });
    page.on("pageerror", (err) => {
      // eslint-disable-next-line no-console
      console.log("[browser:pageerror]", err.message);
    });
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "RESEND-TX");
    const target = members[0]!;

    await page.goto(`/members/${target.memberId}`);
    await expect(
      page.getByRole("heading", { level: 1, name: /member resend-tx-1/i }),
    ).toBeVisible();

    // Tap the first transaction row.
    const txButton = page.locator("button[data-tx-id]").first();
    await expect(txButton).toBeVisible();
    const txId = await txButton.getAttribute("data-tx-id");
    expect(txId).toBeTruthy();
    await txButton.click();

    await expect(
      page.getByRole("heading", { level: 2, name: /reçu de la transaction/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /renvoyer par SMS/i }).click();
    await expect(page.getByText(/rappel envoyé à/i)).toBeVisible();

    const { count: rowCount } = await service
      .from("sms_queue")
      .select("id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("template_key", "resend")
      .eq("transaction_id", txId!);
    expect(rowCount).toBe(1);

    const { count: auditCount } = await service
      .from("audit_log")
      .select("event_id", { count: "exact", head: true })
      .eq("collector_id", seededCollector.userId)
      .eq("event_type", "sms.resend_initiated")
      .eq("entity_id", txId!);
    expect(auditCount).toBe(1);
  });

  test("Partager le reçu → clipboard fallback writes the /r/{token} URL", async ({
    page,
    context,
    seededCollector,
  }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "SHARE-TX");
    const target = members[0]!;

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto(`/members/${target.memberId}`);
    await page.locator("button[data-tx-id]").first().click();

    await expect(
      page.getByRole("heading", { level: 2, name: /reçu de la transaction/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /partager le reçu/i }).click();
    // Chromium without navigator.share falls through to clipboard. The
    // toast confirms the path that actually fired.
    await expect(page.getByText(/lien copié dans le presse-papier/i)).toBeVisible();

    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/^https?:\/\/[^/]+\/r\/[0-9a-f]{32}$/);
  });

  test("opt-out gate — SMS button disabled with caption", async ({ page, seededCollector }) => {
    const service = buildServiceClient();
    const members = await seedMembersForCollector(service, seededCollector, 1, "OPTOUT-TX");
    const target = members[0]!;
    await service.from("members").update({ sms_opt_out: true }).eq("id", target.memberId);

    await page.goto(`/members/${target.memberId}`);
    await page.locator("button[data-tx-id]").first().click();

    const resendBtn = page.getByRole("button", { name: /renvoyer par SMS/i });
    await expect(resendBtn).toBeDisabled();
    await expect(page.getByText(/le saver a refusé les SMS/i)).toBeVisible();
  });
});
