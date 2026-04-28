import { describe, expect, it } from "vitest";

import { tokenIsValid } from "./token";

describe("tokenIsValid", () => {
  it("accepts a 32-char lowercase hex string", () => {
    expect(tokenIsValid("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("rejects a 31-char string (too short)", () => {
    expect(tokenIsValid("0123456789abcdef0123456789abcde")).toBe(false);
  });

  it("rejects a 33-char string (too long)", () => {
    expect(tokenIsValid("0123456789abcdef0123456789abcdef0")).toBe(false);
  });

  it("rejects a 32-char string with a non-hex character", () => {
    expect(tokenIsValid("0123456789abcdef0123456789abcdeg")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(tokenIsValid("")).toBe(false);
  });

  it("rejects uppercase hex (the helper enforces lowercase only)", () => {
    expect(tokenIsValid("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
  });
});
