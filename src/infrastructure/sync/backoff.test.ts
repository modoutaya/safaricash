// Story 8.4 — backoff.ts unit tests.

import { describe, expect, it } from "vitest";

import { computeBackoffMs } from "./backoff";

describe("computeBackoffMs", () => {
  it("returns 10000ms for attempt 0", () => {
    expect(computeBackoffMs(0)).toBe(10_000);
  });

  it("returns 300_000ms (5 min) for attempt 4", () => {
    expect(computeBackoffMs(4)).toBe(300_000);
  });

  it("caps at 600_000ms (10 min) for attempt ≥ 5", () => {
    expect(computeBackoffMs(5)).toBe(600_000);
    expect(computeBackoffMs(10)).toBe(600_000);
    expect(computeBackoffMs(100)).toBe(600_000);
  });

  it("throws on negative or non-integer attempt", () => {
    expect(() => computeBackoffMs(-1)).toThrow(/non-negative/);
    expect(() => computeBackoffMs(1.5)).toThrow(/non-negative/);
  });

  it("is monotonic non-decreasing", () => {
    const values = Array.from({ length: 8 }, (_, i) => computeBackoffMs(i));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });
});
