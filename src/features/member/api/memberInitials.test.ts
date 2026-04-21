import { describe, expect, it } from "vitest";

import { memberInitials } from "./memberInitials";

describe("memberInitials", () => {
  it("picks first letters of the first two words for multi-word names", () => {
    expect(memberInitials("Fatou Ndiaye")).toBe("FN");
    expect(memberInitials("Moussa Ibrahim Diop")).toBe("MI");
  });

  it("returns first two characters for single-word names", () => {
    expect(memberInitials("Fatou")).toBe("FA");
  });

  it("returns '??' for empty or whitespace-only input", () => {
    expect(memberInitials("")).toBe("??");
    expect(memberInitials("   ")).toBe("??");
  });

  it("uppercases with locale awareness (diacritics preserved)", () => {
    expect(memberInitials("fatou ndiaye")).toBe("FN");
    expect(memberInitials("émilie ouédraogo")).toBe("ÉO");
  });

  it("handles single-letter word as the second word", () => {
    expect(memberInitials("Fatou N")).toBe("FN");
  });

  it("collapses multiple internal whitespace runs", () => {
    expect(memberInitials("Fatou    Ndiaye")).toBe("FN");
  });

  it("handles one-character single-word names without index-out-of-bounds", () => {
    expect(memberInitials("F")).toBe("F");
  });
});
