import { describe, expect, it } from "vitest";

import { formatFcfaAmount } from "./formatAmount";

describe("formatFcfaAmount", () => {
  it("groups thousands with a non-breaking space (U+00A0)", () => {
    // "\u202F" is a narrow no-break space — modern Intl in Node 22 emits that.
    // Accept either legacy U+00A0 or U+202F: both are non-breaking per NFR-L3.
    const out = formatFcfaAmount(1500);
    expect(out).toMatch(/^1[\u00A0\u202F]500$/);
  });

  it("formats small numbers without separator", () => {
    expect(formatFcfaAmount(500)).toBe("500");
  });

  it("formats large numbers with multiple groupings", () => {
    const out = formatFcfaAmount(1_234_567);
    expect(out).toMatch(/^1[\u00A0\u202F]234[\u00A0\u202F]567$/);
  });

  it("rounds the fractional part off (daily_amount is numeric(12,0))", () => {
    expect(formatFcfaAmount(999.4)).toBe("999");
    expect(formatFcfaAmount(999.6)).toMatch(/^1[\u00A0\u202F]000$/);
  });
});
