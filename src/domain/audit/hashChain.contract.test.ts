// SQL ↔ TS hash-chain parity contract test (Story 1.2 Task 10 last subtask).
//
// Inserts a real row into the cloud Supabase project via service_role,
// reads back the trigger-emitted audit_log row, recomputes the hash via
// our pure TS hashChain.ts, and asserts byte-equality.
//
// If this test fails, either the SQL trigger or the TS serializer has
// drifted — production audit-chain verification will spuriously break.
//
// Skipped automatically if cloud env vars are not present (e.g. a fresh
// clone running `npm test` without .env.local).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import type { AuditEvent, AuditEntityTable } from "@/domain/audit/event";
import { bytesEqual, computeEntryHash, toCanonicalTimestamp } from "@/domain/audit/hashChain";

const SUPABASE_URL = process.env["SUPABASE_TEST_URL"] ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env["SUPABASE_TEST_SERVICE_ROLE_KEY"] ?? "";
const RUN_CONTRACT = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

// In CI this contract test MUST run — the SQL ↔ TS canonical-byte parity
// gate cannot be silently skipped. Failing loudly forces the workflow to be
// fixed instead of letting a future canonicalisation drift slip through.
if (process.env["CI"] === "true" && !RUN_CONTRACT) {
  throw new Error(
    "CI=true but SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY are not set. " +
      "The SQL ↔ TS hash-chain parity contract test cannot be skipped in CI. " +
      "Wire the local Supabase stack in .github/workflows/ci.yml.",
  );
}

function decodeHexBytea(hex: string | null | undefined): Uint8Array | null {
  if (!hex) return null;
  const cleaned = hex.startsWith("\\x") ? hex.slice(2) : hex;
  if (cleaned.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe.runIf(RUN_CONTRACT)("hashChain SQL ↔ TS parity contract", () => {
  // Lazy-init: vitest may still execute this describe body to register tests
  // even when the predicate is false. Defer createClient until the test
  // actually runs so missing env doesn't throw at module-load time.
  let service: SupabaseClient;
  beforeAll(() => {
    service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  it("recomputes the trigger-emitted entry_hash for a fresh member.created event", async () => {
    // ---- Seed a unique collector for this contract run (avoids polluting
    // the chain of any other test's collector).
    const email = `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@safaricash-test.local`;
    const { data: authData, error: authErr } = await service.auth.admin.createUser({
      email,
      password: `Contract-${Math.random().toString(36).slice(2, 14)}!`,
      email_confirm: true,
    });
    expect(authErr, authErr?.message).toBeNull();
    if (!authData?.user) throw new Error("seed: no auth user returned");
    const collectorId = authData.user.id;

    try {
      const phone = `+22177099${Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, "0")}`;
      const { error: usersErr } = await service.from("users").insert({
        id: collectorId,
        phone_number: phone,
        role: "collector",
      });
      expect(usersErr, usersErr?.message).toBeNull();

      // ---- Insert a member; the audit_emit() trigger fires here and writes
      // a member.created row into audit_log with the canonical hash.
      const { data: nameSecret } = await service.rpc("vault_encrypt", {
        plaintext: "Contract Test Member",
      });
      const { data: phoneSecret } = await service.rpc("vault_encrypt", {
        plaintext: "+221770000999",
      });

      const { data: member, error: memberErr } = await service
        .from("members")
        .insert({
          collector_id: collectorId,
          name_encrypted: nameSecret,
          phone_number_encrypted: phoneSecret,
          daily_amount: 500,
          status: "active",
        })
        .select("id")
        .single();
      expect(memberErr, memberErr?.message).toBeNull();
      const memberId = member!.id;

      // ---- Read back the audit row.
      const { data: auditRow, error: auditErr } = await service
        .from("audit_log")
        .select("*")
        .eq("collector_id", collectorId)
        .eq("entity_id", memberId)
        .eq("event_type", "member.created")
        .single();
      expect(auditErr, auditErr?.message).toBeNull();
      expect(auditRow).toBeTruthy();

      const sqlEntryHash = decodeHexBytea(auditRow!["entry_hash"]);
      const sqlPrevHash = decodeHexBytea(auditRow!["prev_hash"]);
      expect(sqlEntryHash).not.toBeNull();
      expect(sqlEntryHash!.length).toBe(32); // SHA-256 → 32 bytes

      // ---- Recompute via TS using the exact same canonical fields.
      const event: AuditEvent = {
        eventId: auditRow!["event_id"] as string,
        eventType: auditRow!["event_type"] as string,
        collectorId: auditRow!["collector_id"] as string,
        entityId: auditRow!["entity_id"] as string,
        entityTable: auditRow!["entity_table"] as AuditEntityTable,
        timestamp: toCanonicalTimestamp(auditRow!["timestamp"] as string),
        actor: auditRow!["actor"] as string,
        source: auditRow!["source"] as "online" | "offline_reconciled",
        payload: auditRow!["payload"] as Record<string, unknown>,
      };

      const tsEntryHash = await computeEntryHash(sqlPrevHash, event);
      expect(
        bytesEqual(tsEntryHash, sqlEntryHash),
        `SQL hash ${Buffer.from(sqlEntryHash!).toString("hex")} ` +
          `≠ TS hash ${Buffer.from(tsEntryHash).toString("hex")}. ` +
          `Canonical serialization has drifted between trigger and hashChain.ts.`,
      ).toBe(true);
    } finally {
      // ---- Cleanup
      await service.auth.admin.deleteUser(collectorId);
    }
  }, 30_000);
});
