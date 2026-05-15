// Story 8.6 — query-persistence dehydrate filter.

import { describe, expect, it } from "vitest";

import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { shouldPersistMemberQuery } from "./providers";

describe("shouldPersistMemberQuery", () => {
  it("persists successful member queries that carry data (list + profile)", () => {
    expect(
      shouldPersistMemberQuery({
        state: { status: "success", data: [] },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(true);
    expect(
      shouldPersistMemberQuery({
        state: { status: "success", data: {} },
        queryKey: [...MEMBER_PROFILE_QUERY_KEY, "id-1"],
      }),
    ).toBe(true);
  });

  it("rejects non-member queries even when successful", () => {
    expect(
      shouldPersistMemberQuery({
        state: { status: "success", data: [] },
        queryKey: ["transactions"],
      }),
    ).toBe(false);
    expect(
      shouldPersistMemberQuery({
        state: { status: "success", data: [] },
        queryKey: ["sms", "queue"],
      }),
    ).toBe(false);
  });

  it("rejects member queries that are not in a success state", () => {
    expect(
      shouldPersistMemberQuery({
        state: { status: "error", data: undefined },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(false);
    expect(
      shouldPersistMemberQuery({
        state: { status: "pending", data: undefined },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(false);
  });

  it("rejects a successful member query with no data", () => {
    expect(
      shouldPersistMemberQuery({
        state: { status: "success", data: undefined },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(false);
  });
});
