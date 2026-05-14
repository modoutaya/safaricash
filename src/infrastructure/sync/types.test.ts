// Story 8.2 — Zod boundary validation for OfflineEvent inputs.
//
// Covers AC #20 (≥ 5 cases). The schema is the single point where
// untrusted callers (Stories 8.3-8.6) enter the IDB persistence layer;
// every assertion here protects the integrity of the on-disk event log.

import { describe, expect, it } from "vitest";

import { offlineEventSchema, type OfflineEvent } from "./types";

const validEvent: OfflineEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  eventType: "transaction.contribution_recorded",
  collectorId: "22222222-2222-4222-8222-222222222222",
  entityId: "33333333-3333-4333-8333-333333333333",
  timestamp: "2026-05-15T10:00:00.000000Z",
  actor: "44444444-4444-4444-8444-444444444444",
  source: "offline_reconciled",
  payload: { amount: 5_000, member_id: "abc" },
};

describe("offlineEventSchema", () => {
  it("accepts a fully-formed event", () => {
    const result = offlineEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validEvent);
    }
  });

  it("rejects a timestamp without microsecond precision", () => {
    // Date.prototype.toISOString() outputs milliseconds (`.123Z`); we
    // require microseconds (`.123456Z`). The toCanonicalTimestamp helper
    // pads to 6 fractional digits; raw new Date().toISOString() does not.
    const bad = { ...validEvent, timestamp: "2026-05-15T10:00:00.000Z" };
    const result = offlineEventSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/canonical UTC/i);
    }
  });

  it("rejects an unknown eventType", () => {
    const bad = { ...validEvent, eventType: "transaction.exploded" };
    const result = offlineEventSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects missing payload", () => {
    const { payload: _omit, ...rest } = validEvent;
    const result = offlineEventSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID eventId", () => {
    const bad = { ...validEvent, eventId: "not-a-uuid" };
    const result = offlineEventSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
