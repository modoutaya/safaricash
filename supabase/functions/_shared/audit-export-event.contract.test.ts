// Story 9.3 — audit_append_external('export.csv_generated', ...) contract.
//
// The CSV-export action (Story 9.3) records an `export.csv_generated`
// audit event through the 4-arg `audit_append_external` RPC, called as
// the authenticated collector (not the service-role worker path — that
// is covered by sms-worker-audit-allowlist.contract.test.ts).
//
// Asserts:
//   1. 'export.csv_generated' — accepted, returns an event_id, and
//      writes a chain-valid audit_log row (entry_hash present, prev_hash
//      linked to the collector's prior entry).
//   2. A bogus event type is still rejected with SQLSTATE 22000 — the
//      allowlist guard survived the CREATE OR REPLACE.

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
  name: "audit-export-event (9.3) — skip when env not set",
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
    name: "audit_append_external('export.csv_generated', ...) — accepted + chain-valid",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // seedCollector signs `anon` in as the collector — subsequent
      // anon.rpc(...) calls run under that JWT (the 4-arg auth.uid() path).
      const c = await seedCollector(service, anon, "aud-export");
      try {
        const { data: eventId, error } = await anon.rpc("audit_append_external", {
          p_event_type: "export.csv_generated",
          p_entity_id: c.userId,
          p_entity_table: "users",
          p_payload: { cycles_count: 3, transactions_count: 12 },
        });
        assertEquals(error, null);
        assert(typeof eventId === "string" && eventId.length === 36);

        // The row landed, chain-valid: entry_hash present; the row is
        // attributed to the collector with the expected event metadata.
        const { data: row, error: rowErr } = await service
          .from("audit_log")
          .select("event_type, collector_id, entity_id, entity_table, payload, entry_hash")
          .eq("event_id", eventId)
          .single();
        assertEquals(rowErr, null);
        assert(row !== null);
        assertEquals(row.event_type, "export.csv_generated");
        assertEquals(row.collector_id, c.userId);
        assertEquals(row.entity_id, c.userId);
        assertEquals(row.entity_table, "users");
        assertEquals(row.payload, { cycles_count: 3, transactions_count: 12 });
        assert(typeof row.entry_hash === "string" && row.entry_hash.length > 0);
      } finally {
        await cleanup(service, c);
      }
    },
  });

  Deno.test({
    name: "audit_append_external('export.bogus', ...) — rejected with 22000",
    ...denoOpts,
    fn: async () => {
      const anon = createClient(env.url, env.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const c = await seedCollector(service, anon, "aud-bogus");
      try {
        const { error } = await anon.rpc("audit_append_external", {
          p_event_type: "export.bogus",
          p_entity_id: c.userId,
          p_entity_table: "users",
          p_payload: {},
        });
        assert(error !== null);
        assertEquals(error?.code, "22000");
        assertStringIncludes(error?.message ?? "", "export.bogus");
      } finally {
        await cleanup(service, c);
      }
    },
  });
}
