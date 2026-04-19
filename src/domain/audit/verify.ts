import type { AuditLogRow } from "@/domain/audit/event";
import { bytesEqual, computeEntryHash } from "@/domain/audit/hashChain";

export type VerifyResult =
  | { valid: true }
  | { valid: false; brokenAt: number; reason: VerifyBreakReason };

export type VerifyBreakReason =
  | "prev_hash_mismatch"
  | "entry_hash_mismatch"
  | "missing_first_prev_hash";

/**
 * Walks the audit chain in caller-supplied order (typically ASC by timestamp,
 * then by event_id for tie-breaks). Returns `{ valid: true }` if every row's
 * `entryHash` recomputes correctly from `prevHash + canonical(event)` AND the
 * `prevHash` of each row equals the previous row's `entryHash`.
 *
 * The first row of a chain MUST have `prevHash = null` (a non-null prevHash
 * on the first row is treated as a tampering signal).
 */
export async function verifyChain(rows: AuditLogRow[]): Promise<VerifyResult> {
  let expectedPrev: Uint8Array | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as AuditLogRow;

    if (i === 0 && row.prevHash !== null) {
      return { valid: false, brokenAt: 0, reason: "missing_first_prev_hash" };
    }

    if (!bytesEqual(row.prevHash, expectedPrev)) {
      return { valid: false, brokenAt: i, reason: "prev_hash_mismatch" };
    }

    const recomputed = await computeEntryHash(row.prevHash, row);
    if (!bytesEqual(recomputed, row.entryHash)) {
      return { valid: false, brokenAt: i, reason: "entry_hash_mismatch" };
    }

    expectedPrev = row.entryHash;
  }

  return { valid: true };
}
