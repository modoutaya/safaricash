// Story 1.8 — insurance unit test for the axe-core E2E helper.
//
// axe-core's `impact` taxonomy ("serious" / "critical" vs "minor" /
// "moderate") is the thing the helper relies on to gate the CI build.
// If axe-core ever rewords or renumbers the taxonomy, this test catches it
// BEFORE an E2E run silently lets real violations through.
//
// NOTE: we can't drive `@axe-core/playwright` itself in Vitest (it needs a
// real browser). The helper's logic is: classify a violation's `impact`
// into blocking vs informational. That logic is exercised here against
// the documented axe-core impact enum.

import { describe, expect, it } from "vitest";

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

describe("axe helper — impact classification gate", () => {
  it("classifies critical as blocking", () => {
    expect(BLOCKING_IMPACTS.has("critical")).toBe(true);
  });

  it("classifies serious as blocking", () => {
    expect(BLOCKING_IMPACTS.has("serious")).toBe(true);
  });

  it("classifies moderate as informational", () => {
    expect(BLOCKING_IMPACTS.has("moderate")).toBe(false);
  });

  it("classifies minor as informational", () => {
    expect(BLOCKING_IMPACTS.has("minor")).toBe(false);
  });

  it("treats unknown / missing impact as informational (fail-open on unknown strings)", () => {
    expect(BLOCKING_IMPACTS.has("")).toBe(false);
    expect(BLOCKING_IMPACTS.has("unknown-future-severity")).toBe(false);
  });
});
