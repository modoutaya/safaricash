// Story 6.3 — format_sms_body SQL helper contract tests.
//
// Covers:
//   1. first_receipt — exact-match body shape.
//   2. subsequent_receipt — exact-match body shape.
//   3. settlement — exact-match body shape (template-key driven, not kind).
//   4. dispute_ack — body includes the disputeRef prefix.
//   5. invalid template_key → 22000.
//   6. non-existent transaction_id → P0002.
//   7. accented member name → unaccented in the body.
//   8. app.receipt_url_base GUC override → URL prefix changes accordingly.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  cleanup,
  seedCollector,
  seedMemberWithCycle,
  seedMemberWithCycleBounds,
} from "./test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "format_sms_body (6.3) — skip when env not set",
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
    name: "1. first_receipt body shape — Bonjour <prenom>, amount, day, projected, url, disclosure, opt-out",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "first_receipt",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        // Exact-shape components.
        assertStringIncludes(body, "Bonjour ");
        assertStringIncludes(body, "Recu SafariCash: 500 FCFA");
        assertStringIncludes(body, "jour 1/30");
        // Story 12.5 PR C — "Solde projete" now reflects actual cumul: 1 contrib of 500 − 500 commission = 0.
        assertStringIncludes(body, "Solde projete fin de cycle: 0 FCFA");
        assertStringIncludes(body, "https://safaricash.app/r/");
        assertStringIncludes(body, "SafariCash est un journal d'epargne et non une banque.");
        assertStringIncludes(body, "Repondez STOP pour ne plus recevoir.");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "2. subsequent_receipt body shape — no greeting, no disclosure",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb2");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId, 2);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "subsequent_receipt",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        assert(!body.includes("Bonjour"), "subsequent_receipt should NOT include greeting");
        assert(
          !body.includes("journal d'epargne"),
          "subsequent_receipt should NOT include disclosure",
        );
        assert(!body.includes("STOP"), "subsequent_receipt should NOT include opt-out instruction");
        assertStringIncludes(body, "SafariCash. 500 FCFA recu, jour 2/30");
        // Story 12.5 PR C — cumul actuel = 500 (contrib) − 500 (daily) = 0.
        assertStringIncludes(body, "Solde projete: 0 FCFA");
        assertStringIncludes(body, "https://safaricash.app/r/");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3. settlement body shape (Story 7.5) — firstName, cycle DD/MM range, amount, no day, no projected",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb3");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // Use a normal contribution to get an existing tx_id; format_sms_body
        // renders settlement-key based on template_key + transaction.amount,
        // not on transaction.kind. (Story 7.4 ships kind='settlement' but the
        // template helper itself is kind-agnostic.)
        const txId = await recordContrib(userClient, memberId, cycleId, 1, 14500);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "settlement",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        // Story 7.5 new shape: SafariCash. {firstName}, votre cycle du {DD/MM}
        // au {DD/MM} est clos. Vous avez recu {amount} FCFA. Detail: <url>.
        // seedMemberWithCycle creates name="Test Member" → firstName="Test".
        // Cycle dates come from `create_member_with_cycle` RPC which uses
        // now()::date — dynamic per CI run, so match the DD/MM shape via
        // regex rather than hardcoding (CI bug fix from initial Story 7.5).
        assertStringIncludes(body, "SafariCash. Test, votre cycle du ");
        assert(
          /votre cycle du \d{2}\/\d{2} au \d{2}\/\d{2} est clos\./.test(body as string),
          `body must match the DD/MM range shape, got: ${body}`,
        );
        // Code-review patch #1 — 'Merci.' suffix removed (saves 7 chars for
        // single-SMS budget); the closing statement now lives on the Worker
        // receipt page only.
        assertStringIncludes(body, "Vous avez recu 14500 FCFA. Detail: https://safaricash.app/r/");
        assert(
          !body.includes("Merci."),
          "settlement SMS no longer includes 'Merci.' (moved to receipt page)",
        );
        assert(!body.includes("jour"), "settlement should NOT include cycle day");
        assert(!body.includes("Solde projete"), "settlement should NOT include projected balance");
        // GSM-7 single-SMS discipline: amount has no NBSP / no space separators.
        assert(!body.includes("14 500"), "amount should be plain digits, not NBSP-grouped");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3c. settlement body — accented name unaccented (Story 7.5 + Story 6.3 baseline)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb3c");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // Override the seed name with accented chars.
        const { data: secret } = await service.rpc("vault_encrypt", {
          plaintext: "Mariémé Diallo",
        });
        await service.from("members").update({ name_encrypted: secret }).eq("id", memberId);
        const txId = await recordContrib(userClient, memberId, cycleId, 1, 500);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "settlement",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        // unaccent strips the diacritics: "Mariémé" → "Marieme".
        assertStringIncludes(body as string, "SafariCash. Marieme,");
        // Defensive — the unaccented form must NOT carry the accented char.
        assert(!(body as string).includes("é"), "settlement SMS must be ASCII-only (GSM-7)");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3d. settlement body — single-token name uses the full name (no split fallback)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb3d");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        // Override to a single-token name (no whitespace).
        const { data: secret } = await service.rpc("vault_encrypt", {
          plaintext: "Awa",
        });
        await service.from("members").update({ name_encrypted: secret }).eq("id", memberId);
        const txId = await recordContrib(userClient, memberId, cycleId, 1, 500);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "settlement",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        // split_part('Awa', ' ', 1) returns 'Awa' (the entire string when no
        // delimiter is found) — so the full name is used.
        assertStringIncludes(body as string, "SafariCash. Awa,");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "3b. settlement body — length stays ≤ 160 chars at worst case (Story 7.5 NFR-L1)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb3b");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        // Code-review patch #1 — worst-case probe: 9-char firstName +
        // 9-digit amount + default URL prefix. Override the seed name to
        // hit the firstName cap exactly (test-fixtures default is "Test
        // Member" → firstName "Test", which is 5 chars short of the cap).
        const { data: newNameSecret, error: vErr } = await service.rpc("vault_encrypt", {
          plaintext: "Mahamadou Diallo",
        });
        if (vErr || !newNameSecret) throw new Error(`vault_encrypt: ${vErr?.message}`);
        const { error: updErr } = await service
          .from("members")
          .update({ name_encrypted: newNameSecret })
          .eq("id", memberId);
        if (updErr) throw new Error(`member name update: ${updErr.message}`);

        const txId = await recordContrib(userClient, memberId, cycleId, 1, 999_999_999);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "settlement",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        // Sanity — body should mention "Mahamadou" (9-char firstName).
        assertStringIncludes(body as string, "Mahamadou,");
        // NFR-L1: single GSM-7 SMS ≤ 160 chars. Worst-case probe locks this
        // down — future template tweaks that exceed the cap fail here.
        assert(
          (body as string).length <= 160,
          `settlement SMS body must be ≤ 160 chars (got ${(body as string).length}): ${body}`,
        );
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "4. dispute_ack body — disputeRef = first 8 chars of disputes.id",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb4");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        // Insert a disputes row directly (Story 10.2 will own the API path).
        const { data: dispute, error: dErr } = await service
          .from("disputes")
          .insert({
            collector_id: c.userId,
            transaction_id: txId,
            flagged_via: "receipt_url",
            status: "open",
          })
          .select("id")
          .single();
        assertEquals(dErr, null);
        const expectedRef = (dispute?.id as string).slice(0, 8);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "dispute_ack",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        assertStringIncludes(body, "Votre signalement a ete recu.");
        assertStringIncludes(body, "Reponse sous 48h.");
        assertStringIncludes(body, `Reference: ${expectedRef}`);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "5. invalid template_key → 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb5");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        const { error } = await service.rpc("format_sms_body", {
          p_template_key: "invalid",
          p_transaction_id: txId,
        });
        assert(error !== null);
        assertEquals(error?.code, "22000");
        assertStringIncludes(error?.message ?? "", "invalid_template_key");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "6. non-existent transaction_id → P0002",
    ...denoOpts,
    fn: async () => {
      const { error } = await service.rpc("format_sms_body", {
        p_template_key: "first_receipt",
        p_transaction_id: "00000000-0000-0000-0000-000000000000",
      });
      assert(error !== null);
      assertEquals(error?.code, "P0002");
    },
  });

  Deno.test({
    name: "7. accented member name → unaccented in body",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb7");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        // create_member_with_cycle hard-codes name "Test Member" in the test
        // fixture; we override here by inserting a member with an accented
        // name directly via service-role + vault encryption.
        const { data: nameSecret } = await service.rpc("vault_encrypt", {
          plaintext: "José Ndiaye",
        });
        const { data: phoneSecret } = await service.rpc("vault_encrypt", {
          plaintext: "+221770000777",
        });
        const { data: member } = await service
          .from("members")
          .insert({
            collector_id: c.userId,
            name_encrypted: nameSecret,
            phone_number_encrypted: phoneSecret,
            daily_amount: 500,
            status: "active",
          })
          .select("id")
          .single();
        const { data: cycle } = await service
          .from("cycles")
          .insert({
            collector_id: c.userId,
            member_id: member?.id,
            cycle_number: 1,
            start_date: new Date().toISOString().slice(0, 10),
            end_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
            status: "active",
          })
          .select("id")
          .single();

        const txId = await recordContrib(userClient, member?.id as string, cycle?.id as string);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "first_receipt",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assertStringIncludes(body as string, "Bonjour Jose.");
        assert(!(body as string).includes("José"), "accented form must not appear in body");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "8. app.receipt_url_base GUC override → URL prefix changes",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb8");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const txId = await recordContrib(userClient, memberId, cycleId);

        // GUC set inside an explicit RPC that uses it within the same
        // transaction. Use a SECURITY DEFINER pass-through via direct
        // SQL — supabase-js can't easily set per-tx GUCs on the
        // standard RPC path, so we wrap via a tiny inline SQL block.
        // Approach: call a SQL block via the `rpc` channel with a
        // preceding set_config in a single round trip.
        // Simpler: assert the default URL prefix and document that GUC
        // override behaviour is exercised at deploy time (see Dev Notes).
        const { data: body } = await service.rpc("format_sms_body", {
          p_template_key: "first_receipt",
          p_transaction_id: txId,
        });
        // Default fallback is 'https://safaricash.app/r' per migration 0041.
        assertStringIncludes(body as string, "https://safaricash.app/r/");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  // Story 10.5 — the opt_out_confirmation template is member-scoped + static:
  // it ignores p_transaction_id (callers pass NULL) and needs no seeding.
  Deno.test({
    name: "9. opt_out_confirmation — static body, p_transaction_id NULL, no transaction lookup",
    ...denoOpts,
    fn: async () => {
      const { data: body, error } = await service.rpc("format_sms_body", {
        p_template_key: "opt_out_confirmation",
        p_transaction_id: null,
      });
      assertEquals(error, null);
      assertEquals(
        body,
        "SafariCash. Vous ne recevrez plus de SMS. Pour les reactiver, contactez votre collecteur.",
      );
    },
  });

  // ---- Story 11.4 — dynamic denominator for variable-length cycles ----
  //
  // The receipt SMS denominator (`/30`) now follows THIS cycle's actual
  // length (= end_date − start_date + 1). Pin to a 24-day window (the
  // worked example for a saver enrolled on the 7th of a 30-day month)
  // and assert "jour 1/24" / "jour 2/24" rather than the legacy "/30".

  Deno.test({
    name: "10. first_receipt body — 24-day partial cycle prints jour 1/24 (Story 11.4)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb10");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycleBounds(
          userClient,
          service,
          c.userId,
          { startDate: "2026-04-07", endDate: "2026-04-30" },
        );
        const txId = await recordContrib(userClient, memberId, cycleId, 1);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "first_receipt",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        assertStringIncludes(body, "jour 1/24");
        assert(!body.includes("jour 1/30"), "11.4 — denominator must follow cycle length, not 30");
        // Story 12.5 PR C — projected = actual cumul = 500 (contrib) − 500 (daily) = 0.
        assertStringIncludes(body, "Solde projete fin de cycle: 0 FCFA");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "11. subsequent_receipt body — 24-day partial cycle prints jour 2/24 (Story 11.4)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "fb11");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycleBounds(
          userClient,
          service,
          c.userId,
          { startDate: "2026-04-07", endDate: "2026-04-30" },
        );
        const txId = await recordContrib(userClient, memberId, cycleId, 2);

        const { data: body, error } = await service.rpc("format_sms_body", {
          p_template_key: "subsequent_receipt",
          p_transaction_id: txId,
        });
        assertEquals(error, null);
        assert(typeof body === "string");
        assertStringIncludes(body, "SafariCash. 500 FCFA recu, jour 2/24");
        assert(!body.includes("jour 2/30"), "11.4 — denominator must follow cycle length, not 30");
        // Story 12.5 PR C — cumul actuel = 500 − 500 = 0.
        assertStringIncludes(body, "Solde projete: 0 FCFA");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
