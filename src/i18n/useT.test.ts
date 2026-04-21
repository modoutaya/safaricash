// Story 1.8 — branch coverage tests for the FR-only i18n resolver.
// Exercises: missing-key fallback, nested key traversal, interpolation
// with / without vars, unknown var placeholder, non-string cursor early-exit.

import { describe, expect, it, vi } from "vitest";

import { t, useT } from "./useT";

describe("i18n t() — branch coverage", () => {
  it("returns the translated string for a known nested key", () => {
    expect(t("settings.signout_cta")).toBe("Se déconnecter");
  });

  it("falls back to the raw key when the path does not exist", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // Casting — tests intentionally probe the runtime fallback, which
      // `TranslationKey` (compile-time leaf type) prevents from shipping.
      expect(t("nope.not_a_real_key" as never)).toBe("nope.not_a_real_key");
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("interpolates {var} placeholders when vars are provided", () => {
    // errors.rate_limited contains a {seconds} placeholder in fr.json.
    const out = t("errors.rate_limited", { seconds: 42 });
    expect(out).toContain("42");
    expect(out).not.toContain("{seconds}");
  });

  it("keeps unknown placeholders literal when a var is missing", () => {
    const out = t("errors.rate_limited");
    // Without vars, the helper returns the raw template — placeholder stays.
    expect(out).toContain("{seconds}");
  });

  it("useT() returns the same function across calls", () => {
    const t1 = useT();
    const t2 = useT();
    expect(t1).toBe(t2);
    expect(t1).toBe(t);
  });
});
