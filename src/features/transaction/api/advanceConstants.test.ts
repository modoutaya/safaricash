// Story 5.2 — frozen contract for the suggested-amount chips.
import { describe, expect, it } from "vitest";

import { ADVANCE_SUGGESTED_AMOUNTS } from "./advanceConstants";

describe("ADVANCE_SUGGESTED_AMOUNTS", () => {
  it("is exactly [50000, 100000, 150000]", () => {
    expect(ADVANCE_SUGGESTED_AMOUNTS).toEqual([50_000, 100_000, 150_000]);
  });
});
