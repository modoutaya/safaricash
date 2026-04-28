// Story 6.2 — audit_append_external allowlist regression tests.
//
// Asserts:
//   1. 'sms.sent'      — accepted (Story 6.2 NEW).
//   2. 'sms.failed'    — accepted (Story 6.2 NEW).
//   3. 'sms.abandoned' — accepted (Story 6.2 NEW).
//   4. 'sms.delivered' — REJECTED with 22000 (delivery webhook is deferred).
//   5. 'sms.queued'    — STILL accepted (Story 6.1 regression).
//
// Each test seeds a collector, calls the 5-arg overload directly via the
// service-role client (the worker's path), and asserts on either the
// returned event_id or the raised exception code.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { cleanup, seedCollector } from "./test-fixtures.ts";

function envOrSkip(): { url: string; anonKey: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return null;
  return { url, anonKey, serviceKey };
}

const env = envOrSkip();

Deno.test({
  name: "sms-worker audit allowlist (6.2) — skip when env not set",
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

  for (const evt of ["sms.sent", "sms.failed", "sms.abandoned"] as const) {
    Deno.test({
      name: `audit_append_external('${evt}', ...) — accepted`,
      ...denoOpts,
      fn: async () => {
        const anon = createClient(env.url, env.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const c = await seedCollector(service, anon, `aw-${evt}`);
        try {
          const { data: eventId, error } = await service.rpc("audit_append_external", {
            p_event_type: evt,
            p_entity_id: crypto.randomUUID(),
            p_entity_table: "sms_queue",
            p_payload: { template_key: "first_receipt", recipient_phone_hash: "deadbeef" },
            p_collector_id: c.userId,
          });
          assertEquals(error, null);
          assert(typeof eventId === "string" && eventId.length === 36);
        } finally {
          await cleanup(service, c);
        }
      },
    });
  }

  Deno.test({
    name: "audit_append_external('sms.delivered', ...) — rejected with 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "aw-deliv");
      try {
        const { error } = await service.rpc("audit_append_external", {
          p_event_type: "sms.delivered",
          p_entity_id: crypto.randomUUID(),
          p_entity_table: "sms_queue",
          p_payload: {},
          p_collector_id: c.userId,
        });
        assert(error !== null);
        assertEquals(error?.code, "22000");
        assertStringIncludes(error?.message ?? "", "sms.delivered");
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "audit_append_external('sms.queued', ...) — Story 6.1 regression: still accepted",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "aw-queued");
      try {
        const { data: eventId, error } = await service.rpc("audit_append_external", {
          p_event_type: "sms.queued",
          p_entity_id: crypto.randomUUID(),
          p_entity_table: "sms_queue",
          p_payload: { template_key: "first_receipt", recipient_phone_hash: "deadbeef" },
          p_collector_id: c.userId,
        });
        assertEquals(error, null);
        assert(typeof eventId === "string");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
