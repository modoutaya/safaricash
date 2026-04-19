// Pure-domain hash-chain primitives shared with the Postgres
// `audit_emit()` trigger function (migration 0007). The serialization
// must produce byte-identical bytes on both sides; the contract test
// inserts a row via SQL and recomputes the hash here, asserting equality.

import type { AuditEvent } from "@/domain/audit/event";

/** ASCII unit separator (0x1F). Never appears in legitimate text/json. */
const FIELD_DELIMITER = 0x1f;

const textEncoder = new TextEncoder();

function encodeUtf8(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/**
 * Canonical JSON: keys sorted alphabetically at every depth, no
 * whitespace, identical to Postgres `jsonb::text` output for the
 * canonical jsonb storage form.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalJsonStringify(v));
  }
  return "{" + parts.join(",") + "}";
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Builds the canonical byte sequence hashed by SHA-256.
 *
 * Field order (must match `audit_emit()` SQL):
 *   prev_hash || event_id || event_type || collector_id || entity_id ||
 *   entity_table || timestamp || actor || source || payload
 *
 * Each field is UTF-8 encoded and joined by FIELD_DELIMITER (0x1F).
 * `prev_hash` is empty bytes when null.
 */
export function serializeForHash(prevHash: Uint8Array | null, event: AuditEvent): Uint8Array {
  const delim = new Uint8Array([FIELD_DELIMITER]);
  const fields: Uint8Array[] = [
    prevHash ?? new Uint8Array(0),
    delim,
    encodeUtf8(event.eventId),
    delim,
    encodeUtf8(event.eventType),
    delim,
    encodeUtf8(event.collectorId),
    delim,
    encodeUtf8(event.entityId),
    delim,
    encodeUtf8(event.entityTable),
    delim,
    encodeUtf8(event.timestamp),
    delim,
    encodeUtf8(event.actor),
    delim,
    encodeUtf8(event.source),
    delim,
    encodeUtf8(canonicalJsonStringify(event.payload)),
  ];
  return concatBytes(fields);
}

/**
 * Computes the SHA-256 entry hash for a single audit event.
 * Returns a 32-byte Uint8Array.
 */
export async function computeEntryHash(
  prevHash: Uint8Array | null,
  event: AuditEvent,
): Promise<Uint8Array> {
  const serialized = serializeForHash(prevHash, event);
  // crypto.subtle.digest requires a BufferSource backed by ArrayBuffer (not
  // SharedArrayBuffer). Copy into a fresh, owning ArrayBuffer to satisfy
  // the lib.dom signature.
  const buf = new ArrayBuffer(serialized.byteLength);
  new Uint8Array(buf).set(serialized);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return new Uint8Array(digest);
}

/**
 * Converts a Postgres/PostgREST ISO 8601 timestamp (e.g.
 * `"2026-04-19T05:14:23.123456+00:00"` or `"2026-04-19T05:14:23+00:00"`)
 * to the canonical UTC form the audit trigger hashes:
 * `YYYY-MM-DDTHH:MM:SS.uuuuuuZ` — always microsecond precision, always
 * trailing `Z`. Preserves microseconds (JS `Date` would drop them).
 *
 * MUST be called on `auditLogRow.timestamp` before passing it to
 * `computeEntryHash` / `verifyChain`, otherwise hashes will diverge from
 * the trigger output and chain verification will spuriously fail.
 */
export function toCanonicalTimestamp(pgIso: string): string {
  const m = pgIso.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!m) {
    throw new Error(`toCanonicalTimestamp: not a recognised ISO 8601 timestamp: ${pgIso}`);
  }
  const fraction = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return `${m[1]}.${fraction}Z`;
}

/** Constant-time-ish byte equality (length-bounded). */
export function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}
