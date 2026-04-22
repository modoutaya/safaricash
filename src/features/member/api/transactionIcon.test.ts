// Story 2.4 — transactionIcon mapping tests.
import { describe, expect, it } from "vitest";

import { transactionIcon } from "./transactionIcon";

describe("transactionIcon", () => {
  it("returns a distinct icon component for each transaction kind", () => {
    const c = transactionIcon("contribution");
    const r = transactionIcon("rattrapage");
    const a = transactionIcon("advance");
    expect(c).toBeDefined();
    expect(r).toBeDefined();
    expect(a).toBeDefined();
    expect(c).not.toBe(r);
    expect(r).not.toBe(a);
    expect(a).not.toBe(c);
  });
});
