// Story 2.4 — formatTransactionTime tests.
import { describe, expect, it } from "vitest";

import { formatTransactionTime } from "./formatTransactionTime";

describe("formatTransactionTime", () => {
  it("formats a Monday morning into compact French", () => {
    // 2026-04-13 is a Monday → "lun." prefix in French.
    const out = formatTransactionTime("2026-04-13T09:14:00Z");
    expect(out).toMatch(/lun\.?\s/i);
    expect(out).toMatch(/avr/);
    expect(out).toMatch(/à \d{2}:\d{2}/);
  });

  it("uses 24-hour clock", () => {
    const out = formatTransactionTime("2026-04-13T18:30:00Z");
    expect(out).toMatch(/à 18:30|à 19:30|à 20:30/); // depending on local TZ
    expect(out).not.toMatch(/AM|PM/);
  });

  it("inserts ' à ' before the HH:MM block", () => {
    const out = formatTransactionTime("2026-04-13T09:14:00Z");
    expect(out).toContain(" à ");
  });

  it("returns empty string for an invalid ISO", () => {
    expect(formatTransactionTime("not-an-iso")).toBe("");
  });
});
