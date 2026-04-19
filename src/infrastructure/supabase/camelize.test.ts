import { describe, expect, it } from "vitest";

import { camelize, decamelize } from "@/infrastructure/supabase/camelize";

describe("camelize", () => {
  it("converts snake_case top-level keys to camelCase", () => {
    expect(camelize({ created_at: 1, phone_number: "+221" })).toEqual({
      createdAt: 1,
      phoneNumber: "+221",
    });
  });

  it("converts nested object keys recursively", () => {
    expect(
      camelize({
        outer_key: { inner_key: { deepest_key: "x" } },
      }),
    ).toEqual({ outerKey: { innerKey: { deepestKey: "x" } } });
  });

  it("converts arrays of objects", () => {
    expect(camelize([{ user_id: 1 }, { user_id: 2 }])).toEqual([{ userId: 1 }, { userId: 2 }]);
  });

  it("does not mutate non-object primitives", () => {
    expect(camelize(null)).toBeNull();
    expect(camelize(42)).toBe(42);
    expect(camelize("plain_string")).toBe("plain_string");
    expect(camelize(true)).toBe(true);
  });

  it("handles empty objects and arrays", () => {
    expect(camelize({})).toEqual({});
    expect(camelize([])).toEqual([]);
  });

  it("preserves Date and other non-plain objects untouched", () => {
    const d = new Date("2026-04-19T00:00:00Z");
    const out = camelize({ created_at: d }) as { createdAt: Date };
    expect(out.createdAt).toBe(d);
  });

  it("handles snake_case with digits", () => {
    expect(camelize({ user_id_2: 1, ipv4_address: "0.0.0.0" })).toEqual({
      userId2: 1,
      ipv4Address: "0.0.0.0",
    });
  });
});

describe("decamelize", () => {
  it("converts camelCase top-level keys to snake_case", () => {
    expect(decamelize({ createdAt: 1, phoneNumber: "+221" })).toEqual({
      created_at: 1,
      phone_number: "+221",
    });
  });

  it("converts nested object keys recursively", () => {
    expect(
      decamelize({
        outerKey: { innerKey: { deepestKey: "x" } },
      }),
    ).toEqual({ outer_key: { inner_key: { deepest_key: "x" } } });
  });

  it("round-trips: camelize(decamelize(x)) === x for plain objects", () => {
    const original = {
      userId: 42,
      profile: { firstName: "Mamadou", lastLoginAt: 1234 },
      tags: [{ tagName: "founder" }],
    };
    expect(camelize(decamelize(original))).toEqual(original);
  });

  it("round-trips: decamelize(camelize(x)) === x for plain snake_case objects", () => {
    const original = {
      user_id: 42,
      profile: { first_name: "Mamadou", last_login_at: 1234 },
      tags: [{ tag_name: "founder" }],
    };
    expect(decamelize(camelize(original))).toEqual(original);
  });

  it("handles consecutive uppercase letters (initialisms)", () => {
    expect(decamelize({ htmlURL: "x" })).toEqual({ html_url: "x" });
    expect(decamelize({ userIdAPI: 1 })).toEqual({ user_id_api: 1 });
    expect(decamelize({ iso8601: "2026" })).toEqual({ iso8601: "2026" });
  });
});
