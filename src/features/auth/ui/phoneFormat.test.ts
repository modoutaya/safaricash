import { describe, expect, it } from "vitest";

import { formatE164, isValidSenegalPhone, maskPhone } from "@/features/auth/ui/phoneFormat";

describe("formatE164", () => {
  it("keeps a well-formed +221 E.164 untouched", () => {
    expect(formatE164("+221777915898")).toBe("+221777915898");
  });

  it("prepends +221 to a bare 9-digit Senegal mobile", () => {
    expect(formatE164("777915898")).toBe("+221777915898");
  });

  it("handles spaces and dashes in the raw input", () => {
    expect(formatE164("+221 77 79 15 898")).toBe("+221777915898");
    expect(formatE164("77-79-15-898")).toBe("+221777915898");
  });

  it("prepends a + to 221XXXXXXXXX (no leading plus)", () => {
    expect(formatE164("221777915898")).toBe("+221777915898");
  });

  it("converts 00221 international prefix to +221", () => {
    expect(formatE164("00221777915898")).toBe("+221777915898");
  });

  it("does not double-prepend +221 for input already prefixed", () => {
    expect(formatE164("+221777915898")).toBe("+221777915898");
    // Even with whitespace, still normalizes to exactly one +221 prefix.
    expect(formatE164("  +221  77 79 15 898  ")).toBe("+221777915898");
  });

  it("returns empty for empty input", () => {
    expect(formatE164("")).toBe("");
    expect(formatE164("   ")).toBe("");
  });

  it("returns sanitized input unchanged when shape is not recognized", () => {
    // Too short — caller's validator will reject this.
    expect(formatE164("12345")).toBe("12345");
  });
});

describe("isValidSenegalPhone", () => {
  it.each([
    ["+221777915898", true],
    ["+221700000000", true],
    ["+221977915898", true],
    ["+22177791589", false], // 8 national digits
    ["+2217779158988", false], // 10 national digits
    ["221777915898", false], // missing +
    ["+33612345678", false], // French prefix
    ["", false],
    ["+221A77915898", false],
  ])("isValidSenegalPhone(%s) → %s", (input, expected) => {
    expect(isValidSenegalPhone(input)).toBe(expected);
  });
});

describe("maskPhone", () => {
  it("masks the 3rd national digit for a valid Senegal mobile", () => {
    expect(maskPhone("+221777915898")).toBe("+221 77 X 91 58 98");
  });

  it("returns the input unchanged when not a valid Senegal mobile", () => {
    expect(maskPhone("+33612345678")).toBe("+33612345678");
    expect(maskPhone("")).toBe("");
  });
});
