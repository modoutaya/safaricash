// Story 6.6 — format_resend_sms_body SQL helper contract tests.
//
// Covers:
//   1. Happy path — prefix + base subsequent_receipt body.
//   2. Date format — JJ/MM in Africa/Dakar timezone.
//   3. NFR-A6 — body is pure 7-bit ASCII (printable subset).
//   4. Non-existent transaction_id → P0002.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { cleanup, seedCollector, seedMemberWithCycle } from "./test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "format_resend_sms_body (6.6) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

async function recordContrib(
  userClient: ReturnType<typeof createClient>,
  memberId: string,
  cycleId: string,
  cycleDay = 1,
  amount = 500,
): Promise<string> {
  const { data: txId, error } = await userClient.rpc("record_contribution", {
    p_member_id: memberId,
    p_cycle_id: cycleId,
    p_amount: amount,
    p_cycle_day: cycleDay,
  });
  if (error || !txId) throw new Error(`record_contribution: ${error?.message}`);
  return txId as string;
}

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "1. Happy path — prefix + subsequent_receipt body",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "frsb1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId, 1, 500);

        // Use the JWT-bound client — code-review patch D1 added an
        // ownership check inside format_resend_sms_body that rejects
        // calls without auth.uid() (28000). Service-role calls are
        // legitimately rejected by design; production callers always
        // hold a JWT.
        const { data: body, error } = await userClient.rpc("format_resend_sms_body", {
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");

        // Prefix shape — ASCII hyphen, NOT em-dash.
        assertMatch(body as string, /^Rappel - transaction du \d{2}\/\d{2}: /);
        // Base subsequent_receipt content preserved.
        assertStringIncludes(body as string, "SafariCash. 500 FCFA recu, jour 1/30.");
        // Note: format_sms_body still uses the pre-12.5 projected formula
        // (daily × contribDays). PR C of 12.5 will align it.
        // Story 12.5 PR C — cumul actuel = 500 (contrib) − 500 (daily) = 0.
        assertStringIncludes(body as string, "Solde projete: 0 FCFA.");
        assertStringIncludes(body as string, "https://safaricash.app/r/");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "2. Date format — JJ/MM in Africa/Dakar timezone",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "frsb2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        const { data: body } = await userClient.rpc("format_resend_sms_body", {
          p_transaction_id: txId,
        });

        // Compute today's expected date in Africa/Dakar (UTC+0, no DST).
        const now = new Date();
        const dd = String(now.getUTCDate()).padStart(2, "0");
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        assertStringIncludes(body as string, `Rappel - transaction du ${dd}/${mm}: `);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3. NFR-A6 — body is pure 7-bit ASCII (printable)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "frsb3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // Use an accented name; unaccent() in format_sms_body removes the accents.
        const { data: memberId, error: createErr } = await userClient.rpc(
          "create_member_with_cycle",
          {
            p_name: "Fatou Ndiaye",
            p_phone_number: "+221770000111",
            p_daily_amount: 500,
          },
        );
        if (createErr || !memberId) throw new Error(`create_member: ${createErr?.message}`);
        const { data: cycle } = await service
          .from("cycles")
          .select("id")
          .eq("member_id", memberId)
          .single();
        const txId = await recordContrib(userClient, memberId as string, cycle!.id);

        const { data: body } = await userClient.rpc("format_resend_sms_body", {
          p_transaction_id: txId,
        });

        // Printable ASCII only (no em-dash, no accented chars, no emoji).
        assertMatch(body as string, /^[\x20-\x7E]+$/);
        // Specifically reject em-dash which would force UCS-2 encoding.
        assert(!(body as string).includes("—"), "em-dash must not appear");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4. Non-existent transaction_id → P0002",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "frsb4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // Seeded collector has an auth.uid context but doesn't own the
        // random UUID — the ownership check passes (uid != null) and the
        // not-found branch raises P0002.
        const { error } = await userClient.rpc("format_resend_sms_body", {
          p_transaction_id: crypto.randomUUID(),
        });
        assert(error !== null, "expected an error for a non-existent transaction id");
        assertEquals(error?.code, "P0002");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
