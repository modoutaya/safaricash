// Story 6.4 — receipt-url Worker E2E spec.
//
// No UI. Hits the wrangler-dev served Worker at RECEIPT_URL_WORKER_BASE
// (default http://127.0.0.1:8788). Seeds a collector + member +
// transaction via service-role REST, captures the auto-generated
// receipt_token, and exercises:
//   1. GET /health → 200 ok
//   2. GET /r/<seeded-token> → 200 + payload-derived HTML
//   3. GET /r/<malformed> → 404 plain text
//   4. GET /r/<unknown-32-hex> → 404 HTML
//   5. GET /r/<undone-tx-token> → 404 HTML (Story 4.5 handshake)
//   6. GET /r/<token>/dispute → 200 + confirmation form HTML
//   7. POST /r/<token>/dispute → 200 + acknowledgment; disputes + audit rows
//   8. GET /unknown-path → 404
//   9. PUT /r/<token> → 405
//
// Local run:
//   1. Terminal A: `npm run worker:receipt-url:dev`
//   2. Terminal B: `RECEIPT_URL_WORKER_BASE=http://127.0.0.1:8788 \
//      SUPABASE_TEST_URL=http://127.0.0.1:54321 \
//      SUPABASE_TEST_ANON_KEY=<anon> SUPABASE_TEST_SERVICE_ROLE_KEY=<sr> \
//      npx playwright test tests/e2e/receipt-url-worker.spec.ts`

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const WORKER_BASE = process.env["RECEIPT_URL_WORKER_BASE"] ?? "http://127.0.0.1:8788";
const SUPABASE_URL = process.env["SUPABASE_TEST_URL"];
const SUPABASE_ANON_KEY = process.env["SUPABASE_TEST_ANON_KEY"];
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_TEST_SERVICE_ROLE_KEY"];

const ENV_OK = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);

test.describe("receipt-url worker (Story 6.4 — saver-facing receipt page)", () => {
  test.describe.configure({ mode: "serial" });

  test.skip(
    !ENV_OK,
    "SUPABASE_TEST_URL + SUPABASE_TEST_ANON_KEY + SUPABASE_TEST_SERVICE_ROLE_KEY required",
  );

  async function seedCollector(): Promise<{
    userId: string;
    jwt: string;
    cleanup: () => Promise<void>;
  }> {
    const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const anon = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const stamp = Date.now();
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const email = `receipt-${stamp}-${rand}@safaricash-test.local`;
    const password = `Pwd-${rand}-${stamp}`;
    const phone = `+22177${rand}1`;

    const { data: authData, error: authErr } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(authErr, authErr?.message).toBeNull();
    const userId = authData.user!.id;
    await service.from("users").insert({ id: userId, phone_number: phone, role: "collector" });

    const { data: signIn } = await anon.auth.signInWithPassword({ email, password });
    const jwt = signIn!.session!.access_token;

    const cleanup = async () => {
      await service.from("sms_queue").delete().eq("collector_id", userId);
      await service.from("transactions").delete().eq("collector_id", userId);
      await service.from("cycles").delete().eq("collector_id", userId);
      await service.from("members").delete().eq("collector_id", userId);
      await service.auth.admin.deleteUser(userId);
    };

    return { userId, jwt, cleanup };
  }

  async function seedMemberWithTransaction(
    userId: string,
    jwt: string,
  ): Promise<{ token: string; txId: string; cleanup: () => Promise<void> }> {
    const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: memberId } = await userClient.rpc("create_member_with_cycle", {
      p_name: "Fatou Diallo",
      p_phone_number: "+221770000444",
      p_daily_amount: 500,
    });
    expect(memberId).toBeTruthy();

    const { data: cycle } = await service
      .from("cycles")
      .select("id")
      .eq("member_id", memberId)
      .eq("collector_id", userId)
      .single();

    // Story 11.3 — create_member_with_cycle now produces a calendar-month-
    // aligned variable-length cycle (length depends on today's date). Pin
    // the seeded cycle to a deterministic 30-day window so the assertions
    // below (e.g. "14 500 FCFA" projected balance = 500 × 29) stay valid
    // regardless of when CI runs. Same pattern as the Deno contract test
    // fixtures (supabase/functions/_shared/test-fixtures.ts).
    const { error: pinErr } = await service
      .from("cycles")
      .update({ start_date: "2026-04-01", end_date: "2026-04-30" })
      .eq("id", cycle!.id);
    expect(pinErr, pinErr?.message).toBeNull();

    const { data: txId, error: txErr } = await userClient.rpc("record_contribution", {
      p_member_id: memberId,
      p_cycle_id: cycle!.id,
      p_amount: 500,
      p_cycle_day: 1,
    });
    expect(txErr, txErr?.message).toBeNull();

    const { data: tx } = await service
      .from("transactions")
      .select("receipt_token")
      .eq("id", txId)
      .single();
    expect(tx?.receipt_token).toMatch(/^[0-9a-f]{32}$/);

    const cleanup = async () => {
      await service.from("sms_queue").delete().eq("transaction_id", txId);
      await service.from("transactions").delete().eq("id", txId);
      await service.from("cycles").delete().eq("id", cycle!.id);
      await service.from("members").delete().eq("id", memberId);
    };
    return { token: tx!.receipt_token as string, txId: txId as string, cleanup };
  }

  test("1. GET /health → 200 ok", async ({ request }) => {
    const res = await request.get(`${WORKER_BASE}/health`);
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toBe("ok");
  });

  test("3. GET /r/<malformed> → 404", async ({ request }) => {
    const res = await request.get(`${WORKER_BASE}/r/xyz`);
    expect(res.status()).toBe(404);
  });

  test("4. GET /r/<unknown 32-hex> → 404 HTML", async ({ request }) => {
    const res = await request.get(`${WORKER_BASE}/r/${"f".repeat(32)}`);
    expect(res.status()).toBe(404);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("text/html");
    expect(await res.text()).toContain("Reçu introuvable");
  });

  test("8. GET /unknown-path → 404", async ({ request }) => {
    const res = await request.get(`${WORKER_BASE}/some-other-path`);
    expect(res.status()).toBe(404);
  });

  test("9. PUT /r/<valid token> → 405", async ({ request }) => {
    const res = await request.fetch(`${WORKER_BASE}/r/${"a".repeat(32)}`, { method: "PUT" });
    expect(res.status()).toBe(405);
  });

  test("2 + 6 + 7. seeded token: receipt renders + dispute flow records + audits (Story 10.1)", async ({
    request,
  }) => {
    const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { userId, jwt, cleanup: cleanupCollector } = await seedCollector();
    const { token, txId, cleanup: cleanupTx } = await seedMemberWithTransaction(userId, jwt);
    try {
      // 2. GET /r/<seeded-token> → 200 + Fatou + 500 FCFA
      const res = await request.get(`${WORKER_BASE}/r/${token}`);
      expect(res.status()).toBe(200);
      const ct = res.headers()["content-type"] ?? "";
      expect(ct).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Fatou");
      expect(body).toContain("500 FCFA");
      // Story 12.5 PR C — get_receipt_payload's projected_balance now
      // reflects actual cumul: 1 contrib of 500 − 500 commission = 0.
      // Worker renders "0 FCFA" for the "Solde projeté en fin de cycle" row.
      expect(body).toContain("0 FCFA");
      expect(body).toContain("Cette transaction n'est pas moi");
      expect(body).not.toContain("<script");

      // Cache-Control + security headers.
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
      expect(res.headers()["x-frame-options"]).toBe("DENY");

      // 6. GET /r/<token>/dispute → 200 + the confirmation form
      const disputeGet = await request.get(`${WORKER_BASE}/r/${token}/dispute`);
      expect(disputeGet.status()).toBe(200);
      const formBody = await disputeGet.text();
      expect(formBody).toContain(`action="/r/${token}/dispute"`);
      expect(formBody).toContain("Dites-nous ce qui s'est passé");
      expect(formBody).toContain("Signaler");
      expect(formBody).toContain("Annuler");
      expect(formBody).not.toContain("<script");

      // 7. POST /r/<token>/dispute → 200 + the compassionate acknowledgment
      const disputePost = await request.post(`${WORKER_BASE}/r/${token}/dispute`, {
        form: { notes: "Je n'ai jamais reçu cet argent" },
      });
      expect(disputePost.status()).toBe(200);
      expect(await disputePost.text()).toContain("Votre signalement a été transmis");

      // A disputes row landed for the transaction.
      const { data: disputes } = await service
        .from("disputes")
        .select("id, status, flagged_via, notes, collector_id")
        .eq("transaction_id", txId);
      expect(disputes ?? []).toHaveLength(1);
      expect(disputes![0]!.status).toBe("open");
      expect(disputes![0]!.flagged_via).toBe("receipt_url");
      expect(disputes![0]!.notes).toBe("Je n'ai jamais reçu cet argent");
      expect(disputes![0]!.collector_id).toBe(userId);

      // A dispute.flagged audit_log row chained for that collector.
      const { data: auditRows } = await service
        .from("audit_log")
        .select("event_type, entity_id")
        .eq("collector_id", userId)
        .eq("event_type", "dispute.flagged");
      expect(auditRows ?? []).toHaveLength(1);
      expect(auditRows![0]!.entity_id).toBe(disputes![0]!.id);

      // Re-submit → idempotent: 200 + "déjà envoyé", still exactly one row.
      const disputeAgain = await request.post(`${WORKER_BASE}/r/${token}/dispute`, {
        form: { notes: "encore" },
      });
      expect(disputeAgain.status()).toBe(200);
      expect(await disputeAgain.text()).toContain("Signalement déjà envoyé");

      const { data: disputesAfter } = await service
        .from("disputes")
        .select("id")
        .eq("transaction_id", txId);
      expect(disputesAfter ?? []).toHaveLength(1);
    } finally {
      // disputes FK to transactions is ON DELETE RESTRICT — drop it first.
      await service.from("disputes").delete().eq("transaction_id", txId);
      await cleanupTx();
      await cleanupCollector();
    }
  });

  test("Story 7.5 — settlement token renders 'Cycle clôturé' page (no dispute CTA + closing statement)", async ({
    request,
  }) => {
    const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { userId, jwt, cleanup: cleanupCollector } = await seedCollector();
    const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    let memberId: string | null = null;
    let cycleId: string | null = null;
    let txId: string | null = null;
    try {
      // Seed a member + cycle then mark the cycle completed so the Story
      // 7.4 trigger allow-path lets us INSERT a kind='settlement' row.
      const { data: m } = await userClient.rpc("create_member_with_cycle", {
        p_name: "Awa Diallo",
        p_phone_number: "+221770000555",
        p_daily_amount: 500,
      });
      memberId = m as string;
      expect(memberId).toBeTruthy();

      const { data: cycle } = await service
        .from("cycles")
        .select("id")
        .eq("member_id", memberId)
        .eq("collector_id", userId)
        .single();
      cycleId = cycle!.id as string;

      await service.from("cycles").update({ status: "completed" }).eq("id", cycleId);

      // Insert the synthetic settlement transaction directly via service-
      // role. The Story 7.4 trigger allows kind='settlement' on completed
      // cycles. The existing receipt_token trigger auto-generates the token.
      const { data: amountSecret } = await service.rpc("vault_encrypt", {
        plaintext: "14500",
      });
      const { data: tx, error: txErr } = await service
        .from("transactions")
        .insert({
          collector_id: userId,
          member_id: memberId,
          cycle_id: cycleId,
          kind: "settlement",
          amount_encrypted: amountSecret,
          cycle_day: 30,
          source: "online",
        })
        .select("id, receipt_token")
        .single();
      expect(txErr, txErr?.message).toBeNull();
      txId = tx!.id as string;
      const token = tx!.receipt_token as string;
      expect(token).toMatch(/^[0-9a-f]{32}$/);

      // Flip cycle to settled to mirror production state.
      await service
        .from("cycles")
        .update({ status: "settled", settled_at: new Date().toISOString() })
        .eq("id", cycleId);

      // GET the receipt URL → settlement render branch.
      const res = await request.get(`${WORKER_BASE}/r/${token}`);
      expect(res.status()).toBe(200);
      const ct = res.headers()["content-type"] ?? "";
      expect(ct).toContain("text/html");

      const body = await res.text();
      // Settlement-specific markers.
      expect(body).toContain("<title>Cycle clôturé — SafariCash</title>");
      expect(body).toContain("<h1>Cycle clôturé</h1>");
      expect(body).toContain("Awa"); // first name in header subtitle
      expect(body).toContain("Période du cycle");
      expect(body).toContain("14 500 FCFA"); // formatted with NBSP/space on the page
      expect(body).toContain("Merci de votre confiance");
      // Dispute CTA must be absent (settlement is irreversible).
      expect(body).not.toContain("Cette transaction n'est pas moi");
      // Opt-out kept.
      expect(body).toContain("Ne plus recevoir de SMS");
      // No projected-balance / cycle-day rows.
      expect(body).not.toContain("Solde projeté en fin de cycle");
      expect(body).not.toContain("Jour du cycle");
      // No JS.
      expect(body).not.toContain("<script");

      // Security headers preserved.
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    } finally {
      // Cleanup in FK-safe order.
      if (txId) await service.from("transactions").delete().eq("id", txId);
      if (cycleId) await service.from("cycles").delete().eq("id", cycleId);
      if (memberId) await service.from("members").delete().eq("id", memberId);
      await cleanupCollector();
    }
  });

  test("Story 6.5 — POST /r/{token}/opt-out flips members.sms_opt_out + subsequent contribution skipped", async ({
    request,
  }) => {
    const { userId, jwt, cleanup: cleanupCollector } = await seedCollector();
    const { token, cleanup: cleanupTx } = await seedMemberWithTransaction(userId, jwt);
    try {
      // GET form renders no-JS POST form.
      const formRes = await request.get(`${WORKER_BASE}/r/${token}/opt-out`);
      expect(formRes.status()).toBe(200);
      const formBody = await formRes.text();
      expect(formBody).toContain('method="POST"');
      expect(formBody).toContain(`action="/r/${token}/opt-out"`);

      // POST flips opt-out.
      const optOutRes = await request.post(`${WORKER_BASE}/r/${token}/opt-out`, { data: "" });
      expect(optOutRes.status()).toBe(200);
      const confirmedBody = await optOutRes.text();
      expect(confirmedBody).toContain("Vous ne recevrez plus de SMS");

      // members.sms_opt_out should be true now.
      const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: tx } = await service
        .from("transactions")
        .select("member_id")
        .eq("receipt_token", token)
        .single();
      const { data: member } = await service
        .from("members")
        .select("sms_opt_out, sms_opt_out_via")
        .eq("id", tx!.member_id)
        .single();
      expect(member?.sms_opt_out).toBe(true);
      expect(member?.sms_opt_out_via).toBe("receipt_url");

      // Story 10.5 — exactly one opt_out_confirmation SMS was enqueued.
      const { data: confirmRows } = await service
        .from("sms_queue")
        .select("status, template_key, recipient_phone")
        .eq("collector_id", userId)
        .eq("template_key", "opt_out_confirmation");
      expect((confirmRows ?? []).length).toBe(1);
      expect(confirmRows![0]!.status).toBe("queued");
      // The row carries the saver's phone (seedMemberWithTransaction seeds it).
      expect(confirmRows![0]!.recipient_phone).toBe("+221770000444");
    } finally {
      await cleanupTx();
      await cleanupCollector();
    }
  });

  test("Story 6.5 — opt-out with malformed token → 404", async ({ request }) => {
    const res = await request.post(`${WORKER_BASE}/r/xyz/opt-out`, { data: "" });
    expect(res.status()).toBe(404);
  });

  test("Story 10.5 — anonymised saver: receipt page hides the opt-out link + the opt-out route 404s", async ({
    request,
  }) => {
    const { userId, jwt, cleanup: cleanupCollector } = await seedCollector();
    const { token, cleanup: cleanupTx } = await seedMemberWithTransaction(userId, jwt);
    try {
      const service = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: tx } = await service
        .from("transactions")
        .select("member_id")
        .eq("receipt_token", token)
        .single();
      // Anonymise the saver via the real Story 10.4 RPC (stamps
      // anonymised_at, sets sms_opt_out, overwrites the PII Vault secrets) —
      // a production-faithful fixture, not a raw column patch.
      const { error: anonErr } = await service.rpc("anonymise_member", {
        p_member_id: tx!.member_id,
      });
      expect(anonErr).toBeNull();

      // The receipt page renders, but the opt-out link is gone.
      const receiptRes = await request.get(`${WORKER_BASE}/r/${token}`);
      expect(receiptRes.status()).toBe(200);
      const receiptBody = await receiptRes.text();
      expect(receiptBody).not.toContain("Ne plus recevoir de SMS");
      expect(receiptBody).not.toContain(`/r/${token}/opt-out`);

      // The opt-out form route 404s for an anonymised saver.
      const formRes = await request.get(`${WORKER_BASE}/r/${token}/opt-out`);
      expect(formRes.status()).toBe(404);

      // The opt-out POST route 404s too.
      const postRes = await request.post(`${WORKER_BASE}/r/${token}/opt-out`, { data: "" });
      expect(postRes.status()).toBe(404);
    } finally {
      await cleanupTx();
      await cleanupCollector();
    }
  });

  test("5. undone transaction → 404 (Story 4.5 handshake)", async ({ request }) => {
    const { userId, jwt, cleanup: cleanupCollector } = await seedCollector();
    const { token, txId, cleanup: cleanupTx } = await seedMemberWithTransaction(userId, jwt);
    try {
      // Soft-undo via the user-scoped client (within the 5-s window).
      const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      const { error: undoErr } = await userClient.rpc("undo_transaction", {
        p_transaction_id: txId,
      });
      expect(undoErr, undoErr?.message).toBeNull();

      const res = await request.get(`${WORKER_BASE}/r/${token}`);
      expect(res.status()).toBe(404);
      expect(await res.text()).toContain("Reçu introuvable");
    } finally {
      await cleanupTx();
      await cleanupCollector();
    }
  });
});
