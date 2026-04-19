import { describe, expect, it } from "vitest";

import type { AuditEvent, AuditLogRow } from "@/domain/audit/event";
import {
  bytesEqual,
  canonicalJsonStringify,
  computeEntryHash,
  serializeForHash,
} from "@/domain/audit/hashChain";
import { verifyChain } from "@/domain/audit/verify";

const baseEvent: AuditEvent = {
  eventId: "00000000-0000-4000-8000-000000000001",
  eventType: "member.created",
  collectorId: "11111111-1111-4111-8111-111111111111",
  entityId: "22222222-2222-4222-8222-222222222222",
  entityTable: "members",
  timestamp: "2026-04-19T05:14:23.123456Z",
  actor: "11111111-1111-4111-8111-111111111111",
  source: "online",
  payload: {
    id: "22222222-2222-4222-8222-222222222222",
    collector_id: "11111111-1111-4111-8111-111111111111",
    daily_amount: 500,
    status: "active",
  },
};

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return { ...baseEvent, ...overrides };
}

describe("canonicalJsonStringify", () => {
  it("sorts top-level keys alphabetically", () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys recursively", () => {
    expect(canonicalJsonStringify({ outer: { z: 1, a: 2 }, alpha: 3 })).toBe(
      '{"alpha":3,"outer":{"a":2,"z":1}}',
    );
  });

  it("emits arrays positionally without sorting", () => {
    expect(canonicalJsonStringify({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it("handles primitives identically to JSON.stringify", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(42)).toBe("42");
    expect(canonicalJsonStringify("text")).toBe('"text"');
    expect(canonicalJsonStringify(true)).toBe("true");
  });

  it("strips undefined values from objects (json semantics)", () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("emits canonical empty containers", () => {
    expect(canonicalJsonStringify({})).toBe("{}");
    expect(canonicalJsonStringify([])).toBe("[]");
  });

  it("escapes string values per JSON.stringify rules", () => {
    expect(canonicalJsonStringify({ s: 'a"b\\c' })).toBe('{"s":"a\\"b\\\\c"}');
  });
});

describe("serializeForHash", () => {
  it("places fields in the locked canonical order with 0x1F delimiters", () => {
    const out = serializeForHash(null, baseEvent);
    // Field order: prev_hash || event_id || event_type || collector_id ||
    // entity_id || entity_table || timestamp || actor || source || payload.
    // 9 delimiters between 10 fields.
    const delimiterCount = out.reduce((acc, byte) => acc + (byte === 0x1f ? 1 : 0), 0);
    expect(delimiterCount).toBe(9);
  });

  it("treats null prev_hash as zero-length bytes (no leading bytes before first delim)", () => {
    const out = serializeForHash(null, baseEvent);
    // First byte must be the delimiter (prev_hash is empty)
    expect(out[0]).toBe(0x1f);
  });

  it("includes prev_hash bytes when not null", () => {
    const prev = new Uint8Array([0x01, 0x02, 0x03]);
    const out = serializeForHash(prev, baseEvent);
    expect(out[0]).toBe(0x01);
    expect(out[1]).toBe(0x02);
    expect(out[2]).toBe(0x03);
    expect(out[3]).toBe(0x1f);
  });
});

describe("computeEntryHash", () => {
  it("is deterministic for the same (prev_hash, event)", async () => {
    const a = await computeEntryHash(null, baseEvent);
    const b = await computeEntryHash(null, baseEvent);
    expect(bytesEqual(a, b)).toBe(true);
    expect(a.length).toBe(32); // SHA-256 → 32 bytes
  });

  it("changes when prev_hash changes (chain coupling)", async () => {
    const h1 = await computeEntryHash(null, baseEvent);
    const h2 = await computeEntryHash(new Uint8Array([0xff]), baseEvent);
    expect(bytesEqual(h1, h2)).toBe(false);
  });

  it("changes when payload changes (tamper detection)", async () => {
    const h1 = await computeEntryHash(null, baseEvent);
    const tampered = makeEvent({
      payload: { ...baseEvent.payload, daily_amount: 999 },
    });
    const h2 = await computeEntryHash(null, tampered);
    expect(bytesEqual(h1, h2)).toBe(false);
  });

  it("changes when timestamp changes", async () => {
    const h1 = await computeEntryHash(null, baseEvent);
    const h2 = await computeEntryHash(
      null,
      makeEvent({ timestamp: "2026-04-19T05:14:23.123457Z" }),
    );
    expect(bytesEqual(h1, h2)).toBe(false);
  });

  it("payload key order does not affect hash (canonical JSON sorts keys)", async () => {
    const h1 = await computeEntryHash(null, makeEvent({ payload: { a: 1, b: 2 } }));
    const h2 = await computeEntryHash(null, makeEvent({ payload: { b: 2, a: 1 } }));
    expect(bytesEqual(h1, h2)).toBe(true);
  });
});

describe("bytesEqual", () => {
  it("returns true for two nulls", () => {
    expect(bytesEqual(null, null)).toBe(true);
  });

  it("returns false when one side is null and the other is not", () => {
    expect(bytesEqual(null, new Uint8Array([0]))).toBe(false);
    expect(bytesEqual(new Uint8Array([0]), null)).toBe(false);
  });

  it("returns false on length mismatch", () => {
    expect(bytesEqual(new Uint8Array([0, 1]), new Uint8Array([0]))).toBe(false);
  });

  it("returns true on byte-identical inputs", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("returns false when any byte differs", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
});

describe("verifyChain", () => {
  async function buildChain(events: AuditEvent[]): Promise<AuditLogRow[]> {
    const rows: AuditLogRow[] = [];
    let prev: Uint8Array | null = null;
    for (const event of events) {
      const entryHash = await computeEntryHash(prev, event);
      rows.push({ ...event, prevHash: prev, entryHash });
      prev = entryHash;
    }
    return rows;
  }

  it("returns valid: true on an empty chain", async () => {
    expect(await verifyChain([])).toEqual({ valid: true });
  });

  it("returns valid: true on a single well-formed row", async () => {
    const rows = await buildChain([baseEvent]);
    expect(await verifyChain(rows)).toEqual({ valid: true });
  });

  it("returns valid: true on a 100-row chain (AC 8 c)", async () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({
        eventId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        timestamp: `2026-04-19T05:14:${String(i % 60).padStart(2, "0")}.000000Z`,
      }),
    );
    const rows = await buildChain(events);
    expect(await verifyChain(rows)).toEqual({ valid: true });
  });

  it("returns missing_first_prev_hash if the first row has a non-null prevHash", async () => {
    const rows = await buildChain([baseEvent]);
    rows[0]!.prevHash = new Uint8Array([0xff]);
    const result = await verifyChain(rows);
    expect(result).toEqual({
      valid: false,
      brokenAt: 0,
      reason: "missing_first_prev_hash",
    });
  });

  it("returns prev_hash_mismatch when a row's prevHash diverges from the previous entryHash", async () => {
    const rows = await buildChain([
      baseEvent,
      makeEvent({ eventId: "00000000-0000-4000-8000-000000000002" }),
    ]);
    rows[1]!.prevHash = new Uint8Array(32); // 32 bytes of zero — not the actual prev hash
    const result = await verifyChain(rows);
    expect(result).toMatchObject({
      valid: false,
      brokenAt: 1,
      reason: "prev_hash_mismatch",
    });
  });

  it("returns entry_hash_mismatch when a row's payload is tampered (AC 8 b)", async () => {
    const rows = await buildChain([
      baseEvent,
      makeEvent({ eventId: "00000000-0000-4000-8000-000000000002" }),
    ]);
    // Tamper with row 1's payload AFTER the chain was built — entry_hash now stale.
    rows[1]!.payload = { ...rows[1]!.payload, daily_amount: 999 };
    const result = await verifyChain(rows);
    expect(result).toMatchObject({
      valid: false,
      brokenAt: 1,
      reason: "entry_hash_mismatch",
    });
  });

  it("detects tampering on the very first row", async () => {
    const rows = await buildChain([baseEvent]);
    rows[0]!.payload = { ...rows[0]!.payload, daily_amount: 999 };
    const result = await verifyChain(rows);
    expect(result).toMatchObject({
      valid: false,
      brokenAt: 0,
      reason: "entry_hash_mismatch",
    });
  });
});
