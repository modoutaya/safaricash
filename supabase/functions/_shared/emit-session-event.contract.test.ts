// Story 1.7 — Contract test for public.emit_session_event RPC.
//
// Verifies:
//   (a) p_reason='explicit' by an authenticated collector → row inserted
//       with event_type='session.signed_out', payload={reason:"explicit"},
//       correct collector_id, 32-byte entry_hash.
//   (b) p_reason='idle' by an authenticated collector → same shape,
//       payload={reason:"idle"}.
//   (c) p_reason='malicious' (or any other value) → RAISE exception.
//   (d) Unauthenticated (no JWT) call → RAISE exception.
//   (e) Two sequential calls produce a valid hash chain (second row's
//       prev_hash equals first row's entry_hash).
//
// Runs against the live/local Supabase (same pattern as Story 1.5's
// check-collector-registered contract test). Seeds + cleans its own data.
//
// Env required (mirrored by scripts/run-edge-tests.sh):
//   SUPABASE_TEST_URL, SUPABASE_TEST_ANON_KEY, SUPABASE_TEST_SERVICE_ROLE_KEY

import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  buildTestAnonClient,
  buildTestServiceClient,
  cleanupCollector,
  type SeededCollector,
  seedCollector,
} from "./test-utils.ts";

const ENV_OK =
  Deno.env.get("SUPABASE_TEST_URL") &&
  Deno.env.get("SUPABASE_TEST_ANON_KEY") &&
  Deno.env.get("SUPABASE_TEST_SERVICE_ROLE_KEY");

type AuditRow = {
  event_id: string;
  event_type: string;
  collector_id: string;
  entity_id: string;
  entity_table: string;
  actor: string;
  source: string;
  payload: { reason: string };
  prev_hash: string | null;
  entry_hash: string;
  timestamp: string;
};

async function readLatestAudit(
  service: ReturnType<typeof buildTestServiceClient>,
  collectorId: string,
  limit = 2,
): Promise<AuditRow[]> {
  const { data, error } = await service
    .from("audit_log")
    .select("*")
    .eq("collector_id", collectorId)
    .order("timestamp", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`audit_log read failed: ${error.message}`);
  return (data ?? []) as unknown as AuditRow[];
}

function octetLength(bytea: string | null): number {
  // Supabase JSON returns bytea as `\xHEXHEX…`. Strip the `\x` prefix, then
  // each 2 hex chars = 1 byte.
  if (bytea === null) return 0;
  const hex = bytea.startsWith("\\x") ? bytea.slice(2) : bytea;
  return hex.length / 2;
}

Deno.test({
  name: "emit_session_event — p_reason=explicit by authenticated collector inserts a chained row",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = buildTestServiceClient();
    const anon = buildTestAnonClient();
    let collector: SeededCollector | undefined;
    try {
      collector = await seedCollector(service, anon, "ESE-explicit");
      const { error } = await anon.rpc("emit_session_event", { p_reason: "explicit" });
      assertEquals(error, null);

      const rows = await readLatestAudit(service, collector.userId, 1);
      assertEquals(rows.length, 1);
      const row = rows[0]!;
      assertEquals(row.event_type, "session.signed_out");
      assertEquals(row.entity_table, "sessions");
      assertEquals(row.entity_id, collector.userId);
      assertEquals(row.actor, collector.userId);
      assertEquals(row.source, "online");
      assertEquals(row.payload.reason, "explicit");
      assertEquals(octetLength(row.entry_hash), 32);
    } finally {
      if (collector) await cleanupCollector(service, collector);
    }
  },
});

Deno.test({
  name: "emit_session_event — p_reason=idle emits the same shape with idle payload",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = buildTestServiceClient();
    const anon = buildTestAnonClient();
    let collector: SeededCollector | undefined;
    try {
      collector = await seedCollector(service, anon, "ESE-idle");
      const { error } = await anon.rpc("emit_session_event", { p_reason: "idle" });
      assertEquals(error, null);

      const rows = await readLatestAudit(service, collector.userId, 1);
      const row = rows[0]!;
      assertEquals(row.event_type, "session.signed_out");
      assertEquals(row.payload.reason, "idle");
    } finally {
      if (collector) await cleanupCollector(service, collector);
    }
  },
});

Deno.test({
  name: "emit_session_event — invalid p_reason raises exception",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = buildTestServiceClient();
    const anon = buildTestAnonClient();
    let collector: SeededCollector | undefined;
    try {
      collector = await seedCollector(service, anon, "ESE-bad");
      const { error } = await anon.rpc("emit_session_event", { p_reason: "malicious" });
      assert(error !== null, "expected an error for invalid p_reason");
    } finally {
      if (collector) await cleanupCollector(service, collector);
    }
  },
});

Deno.test({
  name: "emit_session_event — unauthenticated caller raises exception",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Fresh anon client, never signed in — auth.uid() is null inside the RPC.
    const anon = buildTestAnonClient();
    const { error } = await anon.rpc("emit_session_event", { p_reason: "explicit" });
    assert(error !== null, "expected an error for unauthenticated caller");
  },
});

Deno.test({
  name: "emit_session_event — two sequential calls build a valid hash chain",
  ignore: !ENV_OK,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const service = buildTestServiceClient();
    const anon = buildTestAnonClient();
    let collector: SeededCollector | undefined;
    try {
      collector = await seedCollector(service, anon, "ESE-chain");
      // First call. Second call's prev_hash MUST equal first call's entry_hash.
      const { error: err1 } = await anon.rpc("emit_session_event", { p_reason: "explicit" });
      assertEquals(err1, null);
      const { error: err2 } = await anon.rpc("emit_session_event", { p_reason: "idle" });
      assertEquals(err2, null);

      const rows = await readLatestAudit(service, collector.userId, 2);
      assertEquals(rows.length, 2);
      // Ordered DESC — rows[0] is the newer (idle), rows[1] is the older (explicit).
      const newer = rows[0]!;
      const older = rows[1]!;
      assertEquals(newer.prev_hash, older.entry_hash);
      assertEquals(octetLength(newer.entry_hash), 32);
      assertEquals(octetLength(older.entry_hash), 32);
    } finally {
      if (collector) await cleanupCollector(service, collector);
    }
  },
});
