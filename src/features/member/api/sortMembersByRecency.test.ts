import { describe, expect, it } from "vitest";

import { sortMembersByRecency } from "./sortMembersByRecency";

type Row = {
  id: string;
  latestInteractionAt: string;
  createdAt: string;
};

describe("sortMembersByRecency", () => {
  it("sorts by latestInteractionAt DESC", () => {
    const rows: Row[] = [
      { id: "a", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "b", latestInteractionAt: "2026-04-21T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "c", latestInteractionAt: "2026-04-19T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
    ];
    expect(sortMembersByRecency(rows).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("breaks ties on createdAt DESC", () => {
    const rows: Row[] = [
      { id: "a", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "b", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-15T00:00:00Z" },
    ];
    expect(sortMembersByRecency(rows).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("breaks further ties on id lex DESC", () => {
    const rows: Row[] = [
      { id: "aaa", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "bbb", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
    ];
    expect(sortMembersByRecency(rows).map((r) => r.id)).toEqual(["bbb", "aaa"]);
  });

  it("does not mutate the input", () => {
    const rows: Row[] = [
      { id: "a", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "b", latestInteractionAt: "2026-04-21T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
    ];
    const originalOrder = rows.map((r) => r.id);
    sortMembersByRecency(rows);
    expect(rows.map((r) => r.id)).toEqual(originalOrder);
  });

  it("returns an empty array for an empty input", () => {
    expect(sortMembersByRecency([])).toEqual([]);
  });

  it("is stable across repeated calls on the same input", () => {
    const rows: Row[] = [
      { id: "a", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "b", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
      { id: "c", latestInteractionAt: "2026-04-20T10:00:00Z", createdAt: "2026-04-01T00:00:00Z" },
    ];
    const first = sortMembersByRecency(rows).map((r) => r.id);
    const second = sortMembersByRecency(rows).map((r) => r.id);
    expect(first).toEqual(second);
  });
});
