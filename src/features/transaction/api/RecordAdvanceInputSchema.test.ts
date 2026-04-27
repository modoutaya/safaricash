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

  it("rejects motive < 3 chars after trim", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, motive: "  ok " });
    expect(r.success).toBe(false);
  });

  it("rejects saverAcknowledged: false", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, saverAcknowledged: false });
    expect(r.success).toBe(false);
  });

  it("rejects cycleDay = 31 (out of [1, 30])", () => {
    const r = RecordAdvanceInputSchema.safeParse({ ...VALID, cycleDay: 31 });
    expect(r.success).toBe(false);
  });
});
