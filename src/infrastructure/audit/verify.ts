// Thin wrapper over the pure-domain verifier in @/domain/audit. Pulls
// audit_log rows for a given collector via the Supabase client, normalises
// snake_case → camelCase, and forwards to verifyChain. Used by Story 9.x
// ops queries and a future RUNBOOK procedure.

import type { AuditLogRow } from "@/domain/audit/event";
import { verifyChain, type VerifyResult } from "@/domain/audit/verify";
import { camelize } from "@/infrastructure/supabase/camelize";
import { supabase } from "@/infrastructure/supabase/client";

type AuditLogDbRow = {
  event_id: string;
  event_type: string;
  collector_id: string;
  entity_id: string;
  entity_table: string;
  timestamp: string;
  actor: string;
  source: "online" | "offline_reconciled";
  payload: Record<string, unknown>;
  prev_hash: string | null; // hex-encoded bytea
  entry_hash: string; // hex-encoded bytea
};

function decodeHexBytea(hex: string | null): Uint8Array | null {
  if (hex === null) return null;
  // Postgres `bytea` over PostgREST returns `\x...` hex string by default.
  const cleaned = hex.startsWith("\\x") ? hex.slice(2) : hex;
  if (cleaned.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function verifyCollectorChain(collectorId: string): Promise<VerifyResult> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("collector_id", collectorId)
    .order("timestamp", { ascending: true })
    .order("event_id", { ascending: true });

  if (error) {
    throw new Error(`verifyCollectorChain: ${error.message}`);
  }

  const rows: AuditLogRow[] = (data as AuditLogDbRow[]).map((dbRow) => {
    const camel = camelize<{
      eventId: string;
      eventType: string;
      collectorId: string;
      entityId: string;
      entityTable: "members" | "cycles" | "transactions";
      timestamp: string;
      actor: string;
      source: "online" | "offline_reconciled";
      payload: Record<string, unknown>;
    }>(dbRow);
    return {
      ...camel,
      prevHash: decodeHexBytea(dbRow.prev_hash),
      entryHash: decodeHexBytea(dbRow.entry_hash) ?? new Uint8Array(0),
    };
  });

  return verifyChain(rows);
}
