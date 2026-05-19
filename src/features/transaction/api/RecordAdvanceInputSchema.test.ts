// Story 5.4 — RecordAdvanceInputSchema validation tests.
import { describe, expect, it } from "vitest";

import { RecordAdvanceInputSchema } from "./RecordAdvanceInputSchema";

const VALID = {
  memberId: "11111111-1111-4111-8111-111111111111",
  cycleId: "22222222-2222-4222-8222-222222222222",
  amount: 50_000,
  cycleDay: 10,
  motive: "urgence médicale",
  saverAcknowledged: true as const,
};

describe("RecordAdvanceInputSchema", () => {
  it("accepts a valid input", () => {
    const r = RecordAdvanceInputSchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });

  it("rejects amount = 0 (must be positive)", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, amount: 0 });
    expect(r.success).toBe(false);
  });

  it("accepts a blank motive — motive is optional since Story 4.6", () => {
    expect(RecordAdvanceInputSchema.safeParse({ ...VALID, motive: "" }).success).toBe(true);
    expect(RecordAdvanceInputSchema.safeParse({ ...VALID, motive: "  ok " }).success).toBe(true);
  });

  it("rejects saverAcknowledged: false", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, saverAcknowledged: false });
    expect(r.success).toBe(false);
  });

  it("accepts cycleDay = 31 — the last day of a 31-day cycle (Story 11.3)", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, cycleDay: 31 });
    expect(r.success).toBe(true);
  });

  it("rejects cycleDay = 32 (out of [1, 31])", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, cycleDay: 32 });
    expect(r.success).toBe(false);
  });
});
