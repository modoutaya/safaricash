// Story 7.5 — get_receipt_payload (migration 0063) returns cycle_start_date
// + cycle_end_date so the receipt-URL Worker can render the cycle period
// on the settlement receipt page.
//
// The pre-Story-7.5 baseline (migration 0043 / Story 6.4) did not expose
// these columns. This contract test pins them down.

import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
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
  name: "get_receipt_payload cycle dates (7.5) — skip when env not set",
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
    name: "1. cycle_start_date + cycle_end_date populated from cycles row",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "grp1");
      try {
        const userClient = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${c.jwt}` } },
        });
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);

        // Record a contribution to get a tx with a receipt_token.
        const { data: txId, error: txErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        if (txErr || !txId) throw new Error(`record_contribution: ${txErr?.message}`);

        // Read the receipt_token directly (the RPC is service-role).
        const { data: txRow } = await service
          .from("transactions")
          .select("receipt_token")
          .eq("id", txId)
          .single();
        assertExists(txRow?.receipt_token);

        const { data, error } = await service.rpc("get_receipt_payload", {
          p_token: txRow!.receipt_token,
        });
        assertEquals(error, null);
        assert(Array.isArray(data) && data.length === 1, "expected one row");
        const row = data![0] as {
          cycle_start_date: string;
          cycle_end_date: string;
          member_first_name: string;
        };
        // seedMemberWithCycle creates cycle with start_date='2026-04-19'
        // and end_date='2026-05-18'.
        assertEquals(row.cycle_start_date, "2026-04-19");
        assertEquals(row.cycle_end_date, "2026-05-18");
        // Defensive cross-check that member_first_name still works (Story
        // 6.4 baseline preserved).
        assertEquals(row.member_first_name, "Test");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
