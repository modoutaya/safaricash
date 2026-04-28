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
//   6. GET /r/<token>/dispute → 501 + coming-soon HTML
//   7. POST /r/<token>/dispute → 501 + plain text
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

  test("2 + 6 + 7. seeded token: receipt page renders + dispute routes 501", async ({
    request,
  }) => {
    const { userId, jwt, cleanup: cleanupCollector } = await seedCollector();
    const { token, cleanup: cleanupTx } = await seedMemberWithTransaction(userId, jwt);
    try {
      // 2. GET /r/<seeded-token> → 200 + Fatou + 500 FCFA
      const res = await request.get(`${WORKER_BASE}/r/${token}`);
      expect(res.status()).toBe(200);
      const ct = res.headers()["content-type"] ?? "";
      expect(ct).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Fatou");
      expect(body).toContain("500 FCFA");
      expect(body).toContain("14 500 FCFA");
      expect(body).toContain("Cette transaction n'est pas moi");
      expect(body).not.toContain("<script");

      // Cache-Control + security headers.
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
      expect(res.headers()["x-frame-options"]).toBe("DENY");

      // 6. GET /r/<token>/dispute → 501 + coming-soon HTML
      const disputeGet = await request.get(`${WORKER_BASE}/r/${token}/dispute`);
      expect(disputeGet.status()).toBe(501);
      expect(await disputeGet.text()).toContain("Cette fonctionnalité arrive bientôt");

      // 7. POST /r/<token>/dispute → 501 plain text
      const disputePost = await request.post(`${WORKER_BASE}/r/${token}/dispute`, {
        data: "",
      });
      expect(disputePost.status()).toBe(501);
      expect(await disputePost.text()).toContain("Story 10.2");
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
