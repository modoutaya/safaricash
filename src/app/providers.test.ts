// Story 8.6 / 9.1 — query-persistence dehydrate filter.

import { describe, expect, it } from "vitest";

import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "@/features/member";

import { shouldPersistOfflineReadQuery } from "./providers";

describe("shouldPersistOfflineReadQuery", () => {
  it("persists successful member queries that carry data (list + profile)", () => {
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "success", data: [] },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(true);
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "success", data: {} },
        queryKey: [...MEMBER_PROFILE_QUERY_KEY, "id-1"],
      }),
    ).toBe(true);
  });

  it("persists the successful dashboard query (Story 9.1 offline read)", () => {
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "success", data: { today: [], recent: [] } },
        queryKey: ["dashboard", "transactions"],
      }),
    ).toBe(true);
  });

  it("rejects non-offline-read queries even when successful", () => {
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "success", data: [] },
        queryKey: ["transactions"],
      }),
    ).toBe(false);
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "success", data: [] },
        queryKey: ["sms", "queue"],
      }),
    ).toBe(false);
  });

  it("rejects queries that are not in a success state", () => {
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "error", data: undefined },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(false);
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "pending", data: undefined },
        queryKey: ["dashboard", "transactions"],
      }),
    ).toBe(false);
  });

  it("rejects a successful query with no data", () => {
    expect(
      shouldPersistOfflineReadQuery({
        state: { status: "success", data: undefined },
        queryKey: MEMBERS_QUERY_KEY,
      }),
    ).toBe(false);
  });
});
