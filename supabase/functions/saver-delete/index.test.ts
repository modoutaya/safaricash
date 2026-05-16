// Story 10.4 — saver-delete Edge Function tests.
//
// Runs against the local/linked Supabase stack. Seeds a collector + member
// + transaction, calls `handler` directly, and asserts the anonymisation:
// PII replaced by salted hashes, sms_opt_out set, anonymised_at stamped, a
// member.anonymised audit row chained, transactions untouched, idempotent.
//
// Needs only SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY
// (no Termii / Resend) — runs clean locally.
//
// Run: ./scripts/run-edge-tests.sh

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { cleanup, seedCollector, seedMemberWithCycle } from "../_shared/test-fixtures.ts";
import { handler } from "./index.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();
const denoOpts = { sanitizeResources: false, sanitizeOps: false };

function deleteRequest(body: unknown, bearer: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return new Request("http://localhost/functions/v1/saver-delete", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test({
  name: "saver-delete — skip when env not set",
  ignore: !!env,
  fn: () => console.log("Skip — Supabase env not set."),
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  Deno.test({
    name: "saver-delete — non-POST → 405",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        new Request("http://localhost/functions/v1/saver-delete", { method: "GET" }),
      );
      assertEquals(res.status, 405);
    },
  });

  Deno.test({
    name: "saver-delete — missing service-role bearer → 403",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        deleteRequest({ member_id: crypto.randomUUID(), confirm: true }, null),
      );
      assertEquals(res.status, 403);
    },
  });

  Deno.test({
    name: "saver-delete — wrong service-role bearer (anon key) → 403",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        deleteRequest({ member_id: crypto.randomUUID(), confirm: true }, env.anonKey),
      );
      assertEquals(res.status, 403);
    },
  });

  Deno.test({
    name: "saver-delete — non-JSON body → 400",
    ...denoOpts,
    fn: async () => {
      const res = await handler(deleteRequest("not json", env.serviceKey));
      assertEquals(res.status, 400);
    },
  });

  Deno.test({
    name: "saver-delete — missing / non-UUID member_id → 400",
    ...denoOpts,
    fn: async () => {
      const res1 = await handler(deleteRequest({ confirm: true }, env.serviceKey));
      assertEquals(res1.status, 400);
      const res2 = await handler(
        deleteRequest({ member_id: "not-a-uuid", confirm: true }, env.serviceKey),
      );
      assertEquals(res2.status, 400);
    },
  });

  Deno.test({
    name: "saver-delete — confirm !== true → 400",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        deleteRequest({ member_id: crypto.randomUUID(), confirm: false }, env.serviceKey),
      );
      assertEquals(res.status, 400);
    },
  });

  Deno.test({
    name: "saver-delete — unknown member_id → 200 { status: not_found }",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        deleteRequest({ member_id: crypto.randomUUID(), confirm: true }, env.serviceKey),
      );
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.ok, true);
      assertEquals(json.status, "not_found");
    },
  });

  Deno.test({
    name: "saver-delete — happy path: anonymises PII, chains member.anonymised, idempotent",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "sd-happy");
      const userClient = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${c.jwt}` } },
      });
      try {
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { data: txId, error: txErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assertEquals(txErr, null);

        // --- anonymise ---
        const res = await handler(
          deleteRequest({ member_id: memberId, confirm: true }, env.serviceKey),
        );
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.ok, true);
        assertEquals(json.status, "anonymised");

        // --- PII replaced by salted hashes ---
        const { data: md } = await service
          .from("members_decrypted")
          .select("name, phone_number, sms_opt_out, anonymised_at")
          .eq("id", memberId)
          .single();
        assert(md!.name.startsWith("SAVER_"), `name not anonymised: ${md!.name}`);
        assertEquals(md!.phone_number.length, 64);
        assert(/^[0-9a-f]{64}$/.test(md!.phone_number), "phone not a hex hash");
        assertEquals(md!.sms_opt_out, true);
        assert(md!.anonymised_at !== null, "anonymised_at not stamped");

        // --- the underlying members row: phone_number_hash cleared, via tag ---
        const { data: m } = await service
          .from("members")
          .select("phone_number_hash, sms_opt_out_via, status")
          .eq("id", memberId)
          .single();
        assertEquals(m!.phone_number_hash, null);
        assertEquals(m!.sms_opt_out_via, "anonymisation");

        // --- exactly one member.anonymised audit row, chained ---
        const { data: events } = await service
          .from("audit_log")
          .select("event_type")
          .eq("entity_id", memberId)
          .eq("event_type", "member.anonymised");
        assertEquals((events ?? []).length, 1);

        // --- transaction untouched (audit-chain integrity) ---
        const { data: tx } = await service
          .from("transactions")
          .select("id")
          .eq("id", txId)
          .single();
        assertEquals(tx!.id, txId);

        // --- AC #13: no SMS left queued for the member's transactions ---
        const { data: smsRows } = await service
          .from("sms_queue")
          .select("status")
          .eq("transaction_id", txId);
        assertEquals(
          (smsRows ?? []).some((r) => r.status === "queued"),
          false,
          "an sms_queue row is still 'queued' after anonymisation",
        );

        // --- idempotent: 2nd call → already_anonymised, no new audit row ---
        const res2 = await handler(
          deleteRequest({ member_id: memberId, confirm: true }, env.serviceKey),
        );
        assertEquals(res2.status, 200);
        assertEquals((await res2.json()).status, "already_anonymised");
        const { data: events2 } = await service
          .from("audit_log")
          .select("event_type")
          .eq("entity_id", memberId)
          .eq("event_type", "member.anonymised");
        assertEquals((events2 ?? []).length, 1);
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
