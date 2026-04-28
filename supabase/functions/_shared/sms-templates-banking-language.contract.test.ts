// Story 6.3 — banking-language linter for the 4 SMS templates (NFR-S10).
//
// Banned words (case-insensitive): compte, depot, dépôt, garanti, bancaire, banque.
// Exception: 'banque' MAY appear EXACTLY in the tracker-not-mover phrase
// "...non une banque." on first_receipt — and must NOT appear on the other 3.

import { assert, assertEquals } from "jsr:@std/assert@1";
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
const BANNED = ["compte", "depot", "dépôt", "garanti", "bancaire"]; // 'banque' handled separately

Deno.test({
  name: "sms-templates banking-language (6.3) — skip when env not set",
  ignore: !!env,
  fn: () => {
    console.log("Skip — Supabase env not set.");
  },
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const denoOpts = { sanitizeResources: false, sanitizeOps: false };

  Deno.test({
    name: "no banned banking words across the 4 templates (case-insensitive)",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "blr1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { data: txId } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        // Seed a dispute to make the dispute_ack template renderable.
        await service.from("disputes").insert({
          collector_id: c.userId,
          transaction_id: txId,
          flagged_via: "receipt_url",
          status: "open",
        });

        for (const key of [
          "first_receipt",
          "subsequent_receipt",
          "settlement",
          "dispute_ack",
        ] as const) {
          const { data: body, error } = await service.rpc("format_sms_body", {
            p_template_key: key,
            p_transaction_id: txId,
          });
          assertEquals(error, null);
          const lower = (body as string).toLowerCase();
          for (const word of BANNED) {
            assert(
              !lower.includes(word),
              `template ${key} contains banned word "${word}": ${body}`,
            );
          }
          // 'banque' rule — allowed once on first_receipt, zero elsewhere.
          const banqueCount = (lower.match(/banque/g) ?? []).length;
          if (key === "first_receipt") {
            assertEquals(
              banqueCount,
              1,
              `first_receipt should mention 'banque' exactly once (in disclosure): ${body}`,
            );
            assert(
              lower.includes("non une banque"),
              `first_receipt 'banque' usage must be in tracker-not-mover phrase: ${body}`,
            );
          } else {
            assertEquals(banqueCount, 0, `template ${key} must not mention 'banque': ${body}`);
          }
        }
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
