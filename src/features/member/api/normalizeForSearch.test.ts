import { describe, expect, it } from "vitest";

import { normalizeForSearch } from "./normalizeForSearch";

describe("normalizeForSearch", () => {
  it("lowercases ASCII", () => {
    expect(normalizeForSearch("Fatou")).toBe("fatou");
  });

  it("strips common French diacritics", () => {
    expect(normalizeForSearch("Fâtôu")).toBe("fatou");
    expect(normalizeForSearch("Émilie")).toBe("emilie");
    expect(normalizeForSearch("Oïlé")).toBe("oile");
    expect(normalizeForSearch("Ñ")).toBe("n");
  });

  it("is idempotent", () => {
    const once = normalizeForSearch("Fâtôu Ndiaye");
    expect(normalizeForSearch(once)).toBe(once);
  });

  it("preserves whitespace + internal structure", () => {
    expect(normalizeForSearch("  Fatou  Ndiaye  ")).toBe("  fatou  ndiaye  ");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeForSearch("")).toBe("");
  });
});
