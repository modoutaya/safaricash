// Story 6.3 — SMS template length budgets + GSM-7 / 7-bit ASCII compliance.
//
// Worst-case input: 16-char prenom, amount 9_999_999, cycle_day 30,
// projected balance 14_500 (typical max for daily_amount=500), no advances.
//
// Budgets:
//   first_receipt        ≤ 320 (2 SMS segments — UX-DR14)
//   subsequent_receipt   ≤ 160 (1 segment — UX-DR15)
//   settlement           ≤ 160 (UX-DR16)
//   dispute_ack          ≤ 160 (UX-DR17)
//
// ASCII rule (NFR-A6): every char in printable 7-bit range [0x20, 0x7E].

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { cleanup, seedCollector } from "./test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const ASCII_ONLY = /^[\x20-\x7E]+$/;
const env = envOrSkip();

Deno.test({
  name: "sms-templates length + ASCII (6.3) — skip when env not set",
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

  // Worst-case-ish seed: a long-ASCII member name + max-realistic
  // contribution amount. We also bump member.daily_amount to 100_000 so
  // the projected balance is 100_000 * 29 = 2_900_000 (7 digits + 2
  // grouping spaces = 9 chars).
  Deno.test({
    name: "worst-case rendering — first_receipt ≤ 320, others ≤ 160; all bodies pure 7-bit ASCII",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "len1");
      try {
        // 16-char prenom (truncation cap).
        const longName = "Aaaaaaaaaaaaaaaaaa Diallo"; // 18-char first token; helper truncates to 16.
        const { data: nameSecret } = await service.rpc("vault_encrypt", { plaintext: longName });
        const { data: phoneSecret } = await service.rpc("vault_encrypt", {
          plaintext: "+221770000888",
        });
        const { data: member } = await service
          .from("members")
          .insert({
            collector_id: c.userId,
            name_encrypted: nameSecret,
            phone_number_encrypted: phoneSecret,
            daily_amount: 100_000, // → projected = 2_900_000
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

        // Insert a contribution row directly via service-role; record_contribution
        // RPC validates against daily_amount and capacity, but the helper just
        // reads the row's amount, so direct INSERT with amount=9_999_999 works
        // for this worst-case test.
        const { data: amountSecret } = await service.rpc("vault_encrypt", {
          plaintext: "9999999",
        });
        const { data: tx } = await service
          .from("transactions")
          .insert({
            collector_id: c.userId,
            member_id: member?.id,
            cycle_id: cycle?.id,
            kind: "contribution",
            amount_encrypted: amountSecret,
            cycle_day: 30,
            source: "online",
          })
          .select("id")
          .single();
        const txId = tx?.id as string;

        // Seed a disputes row for dispute_ack.
        await service.from("disputes").insert({
          collector_id: c.userId,
          transaction_id: txId,
          flagged_via: "receipt_url",
          status: "open",
        });

        const cases: Array<
          [
            (
              | "first_receipt"
              | "subsequent_receipt"
              | "settlement"
              | "dispute_ack"
              | "opt_out_confirmation"
            ),
            number,
          ]
        > = [
          ["first_receipt", 320],
          ["subsequent_receipt", 160],
          ["settlement", 160],
          ["dispute_ack", 160],
          // Story 10.5 — static member-scoped body; p_transaction_id ignored.
          ["opt_out_confirmation", 160],
        ];

        for (const [key, budget] of cases) {
          const { data: body, error } = await service.rpc("format_sms_body", {
            p_template_key: key,
            p_transaction_id: txId,
          });
          assertEquals(error, null);
          assert(typeof body === "string");
          const len = (body as string).length;
          assert(len <= budget, `${key} length ${len} exceeds budget ${budget}: ${body}`);
          assert(ASCII_ONLY.test(body as string), `${key} contains non-ASCII chars: ${body}`);
        }
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
