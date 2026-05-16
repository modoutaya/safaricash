// Story 10.2 — dispute-notify Edge Function tests.
//
// Runs against the local/linked Supabase stack. Each test seeds a
// collector + member + transaction + a disputes row, calls `handler`
// directly, and asserts the four-output fan-out. Email is exercised on
// its `skipped` path (no RESEND_* env in the test runner); the SMS output
// is the deterministic assertion (an sms_queue dispute_ack row).
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

function notifyRequest(body: unknown, bearer: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  return new Request("http://localhost/functions/v1/dispute-notify", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test({
  name: "dispute-notify — skip when env not set",
  ignore: !!env,
  fn: () => console.log("Skip — Supabase env not set."),
});

if (env) {
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  Deno.test({
    name: "dispute-notify — non-POST → 405",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        new Request("http://localhost/functions/v1/dispute-notify", { method: "GET" }),
      );
      assertEquals(res.status, 405);
    },
  });

  Deno.test({
    name: "dispute-notify — missing service-role bearer → 403",
    ...denoOpts,
    fn: async () => {
      const res = await handler(notifyRequest({ dispute_id: "x" }, null));
      assertEquals(res.status, 403);
    },
  });

  Deno.test({
    name: "dispute-notify — non-JSON body → 400",
    ...denoOpts,
    fn: async () => {
      const res = await handler(notifyRequest("not json", env.serviceKey));
      assertEquals(res.status, 400);
    },
  });

  Deno.test({
    name: "dispute-notify — missing fields → 400",
    ...denoOpts,
    fn: async () => {
      const res = await handler(notifyRequest({ dispute_id: "only-this" }, env.serviceKey));
      assertEquals(res.status, 400);
    },
  });

  Deno.test({
    name: "dispute-notify — unknown dispute_id → 200, all outputs skipped",
    ...denoOpts,
    fn: async () => {
      const res = await handler(
        notifyRequest(
          {
            dispute_id: crypto.randomUUID(),
            transaction_id: crypto.randomUUID(),
            collector_id: crypto.randomUUID(),
          },
          env.serviceKey,
        ),
      );
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.ok, true);
      assertEquals(json.outputs.sms, "skipped");
      assertEquals(json.outputs.email, "skipped");
      assertEquals(json.outputs.realtime, "skipped");
      assertEquals(json.outputs.push, "stub");
    },
  });

  Deno.test({
    name: "dispute-notify — happy path: enqueues a dispute_ack SMS + fans out",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "dn-happy");
      const userClient = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${c.jwt}` } },
      });
      let disputeId: string | null = null;
      try {
        const { memberId, cycleId } = await seedMemberWithCycle(userClient, service, c.userId);
        const { data: txId, error: txErr } = await userClient.rpc("record_contribution", {
          p_member_id: memberId,
          p_cycle_id: cycleId,
          p_amount: 500,
          p_cycle_day: 1,
        });
        assertEquals(txErr, null);

        const { data: dispute, error: dErr } = await service
          .from("disputes")
          .insert({ collector_id: c.userId, transaction_id: txId, notes: "ce n'est pas moi" })
          .select("id")
          .single();
        assertEquals(dErr, null);
        disputeId = dispute!.id as string;

        const res = await handler(
          notifyRequest(
            { dispute_id: disputeId, transaction_id: txId, collector_id: c.userId },
            env.serviceKey,
          ),
        );
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.ok, true);
        // SMS — the deterministic output.
        assertEquals(json.outputs.sms, "queued");
        // Email — no RESEND_* env in the test runner → skipped.
        assertEquals(json.outputs.email, "skipped");
        // Realtime — best-effort; either value is acceptable.
        assert(["sent", "failed"].includes(json.outputs.realtime));
        assertEquals(json.outputs.push, "stub");

        // A dispute_ack sms_queue row landed for the transaction.
        const { data: queued } = await service
          .from("sms_queue")
          .select("template_key, status, recipient_phone")
          .eq("transaction_id", txId)
          .eq("template_key", "dispute_ack");
        assertEquals((queued ?? []).length, 1);
        assertEquals(queued![0]!.status, "queued");
      } finally {
        if (disputeId) await service.from("disputes").delete().eq("id", disputeId);
        await cleanup(service, c);
      }
    },
  });
}
