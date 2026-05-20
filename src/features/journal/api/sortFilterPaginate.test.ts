// Story 12.1 — pure sort + search + paginate behaviour.

import { describe, expect, it } from "vitest";

import type { JournalMember } from "./useJournalMembers";
import {
  deriveJournalListView,
  filterByNameQuery,
  JOURNAL_PAGE_SIZE,
  JOURNAL_SEARCH_RESULT_CAP,
  sortByLastActivity,
} from "./sortFilterPaginate";

const makeMember = (
  id: string,
  name: string,
  lastActivityAt: string | null = null,
): JournalMember => ({
  id,
  name,
  currentCycle: null,
  previousCycle: null,
  lastActivityAt,
});

describe("sortByLastActivity", () => {
  it("most recent activity first; nulls sink to the bottom", () => {
    const result = sortByLastActivity([
      makeMember("a", "Awa", null),
      makeMember("b", "Khadim", "2026-05-20T10:00:00Z"),
      makeMember("c", "Cheikh", "2026-05-18T10:00:00Z"),
      makeMember("d", "Bineta", "2026-05-20T12:00:00Z"),
    ]);
    expect(result.map((m) => m.name)).toEqual(["Bineta", "Khadim", "Cheikh", "Awa"]);
  });

  it("ties resolved alphabetically (locale fr)", () => {
    const result = sortByLastActivity([
      makeMember("a", "Zita", "2026-05-20T10:00:00Z"),
      makeMember("b", "Aïssatou", "2026-05-20T10:00:00Z"),
    ]);
    expect(result.map((m) => m.name)).toEqual(["Aïssatou", "Zita"]);
  });

  it("does not mutate the input array", () => {
    const input = [makeMember("a", "Z", null), makeMember("b", "A", null)];
    const before = [...input];
    sortByLastActivity(input);
    expect(input).toEqual(before);
  });
});

describe("filterByNameQuery", () => {
  it("empty query → returns all (sorted unchanged)", () => {
    const members = [makeMember("a", "Khadim"), makeMember("b", "Astou")];
    expect(filterByNameQuery(members, "")).toHaveLength(2);
    expect(filterByNameQuery(members, "   ")).toHaveLength(2);
  });

  it("case-insensitive substring match on name", () => {
    const members = [makeMember("a", "Khadim Ndiaye"), makeMember("b", "Astou Ba")];
    expect(filterByNameQuery(members, "KHA").map((m) => m.id)).toEqual(["a"]);
    expect(filterByNameQuery(members, "ndiaye").map((m) => m.id)).toEqual(["a"]);
    expect(filterByNameQuery(members, "ba").map((m) => m.id)).toEqual(["b"]);
  });

  it("no match → empty array", () => {
    expect(filterByNameQuery([makeMember("a", "Khadim")], "Mamadou")).toEqual([]);
  });
});

describe("deriveJournalListView", () => {
  const makeN = (count: number): JournalMember[] =>
    Array.from({ length: count }, (_, i) =>
      makeMember(
        `id-${i}`,
        `Member ${String(i).padStart(3, "0")}`,
        `2026-05-${20 - (i % 10)}T10:00:00Z`,
      ),
    );

  it("first page = first JOURNAL_PAGE_SIZE; canLoadMore=true when more remain", () => {
    const view = deriveJournalListView(makeN(50), "", 1);
    expect(view.visible).toHaveLength(JOURNAL_PAGE_SIZE);
    expect(view.canLoadMore).toBe(true);
    expect(view.searchActive).toBe(false);
  });

  it("second page = first 2× JOURNAL_PAGE_SIZE; canLoadMore=true when more remain", () => {
    const view = deriveJournalListView(makeN(50), "", 2);
    expect(view.visible).toHaveLength(2 * JOURNAL_PAGE_SIZE);
    expect(view.canLoadMore).toBe(true);
  });

  it("last partial page → canLoadMore=false", () => {
    const view = deriveJournalListView(makeN(25), "", 2);
    expect(view.visible).toHaveLength(25);
    expect(view.canLoadMore).toBe(false);
  });

  it("search query filters across ALL members regardless of page count", () => {
    const view = deriveJournalListView(makeN(50), "Member 045", 1);
    expect(view.visible.map((m) => m.id)).toEqual(["id-45"]);
    expect(view.searchActive).toBe(true);
    expect(view.canLoadMore).toBe(false);
  });

  it("search result set is capped at JOURNAL_SEARCH_RESULT_CAP", () => {
    // 100 members whose name starts with "Member " — search "Member " matches all.
    const members = Array.from({ length: 100 }, (_, i) =>
      makeMember(`id-${i}`, `Member ${i}`, "2026-05-20T10:00:00Z"),
    );
    const view = deriveJournalListView(members, "Member", 1);
    expect(view.visible).toHaveLength(JOURNAL_SEARCH_RESULT_CAP);
  });
});
