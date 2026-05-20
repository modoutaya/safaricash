// Story 12.1 — pure sort + search-filter + paginate helper for the
// Journal member list. Extracted so JournalPage's behaviour is testable
// without rendering.

import type { JournalMember } from "./useJournalMembers";

export const JOURNAL_PAGE_SIZE = 20;
/** Hard cap on a name-search result set; defensive against pathological
 *  one-character queries on a 500-member collector. */
export const JOURNAL_SEARCH_RESULT_CAP = 50;

/** Sort members by `lastActivityAt` descending, NULLS LAST (members with
 *  no transaction yet sink to the bottom). Stable on ties via name. */
export function sortByLastActivity(members: ReadonlyArray<JournalMember>): JournalMember[] {
  return members.slice().sort((a, b) => {
    if (a.lastActivityAt && b.lastActivityAt) {
      if (a.lastActivityAt === b.lastActivityAt) return a.name.localeCompare(b.name, "fr");
      return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
    }
    if (a.lastActivityAt && !b.lastActivityAt) return -1;
    if (!a.lastActivityAt && b.lastActivityAt) return 1;
    return a.name.localeCompare(b.name, "fr");
  });
}

/** Case-insensitive substring match on `name`. French accents are
 *  preserved (matches `Khadim` exactly, not `khadim` → `e` ≡ `é` style
 *  diacritic-stripping). Matches the search behaviour of MemberList. */
export function filterByNameQuery(
  members: ReadonlyArray<JournalMember>,
  query: string,
): JournalMember[] {
  const q = query.trim().toLowerCase();
  if (q === "") return members.slice();
  return members.filter((m) => m.name.toLowerCase().includes(q));
}

export interface JournalListView {
  visible: JournalMember[];
  /** True iff a "Voir plus" button should appear at the bottom (more
   *  paginated rows available; search bar is empty). */
  canLoadMore: boolean;
  /** True iff a search query is active and produced fewer matches than
   *  the cap — the consumer can render a "search results" header. */
  searchActive: boolean;
}

/** Compose sort + filter + paginate into the view-model the page renders.
 *  - When `searchQuery` is empty: sort + slice the first `pageCount * PAGE_SIZE`.
 *  - When `searchQuery` is non-empty: sort + filter + slice to SEARCH_RESULT_CAP. */
export function deriveJournalListView(
  members: ReadonlyArray<JournalMember>,
  searchQuery: string,
  pageCount: number,
): JournalListView {
  const sorted = sortByLastActivity(members);
  if (searchQuery.trim() !== "") {
    const filtered = filterByNameQuery(sorted, searchQuery).slice(0, JOURNAL_SEARCH_RESULT_CAP);
    return { visible: filtered, canLoadMore: false, searchActive: true };
  }
  const limit = pageCount * JOURNAL_PAGE_SIZE;
  return {
    visible: sorted.slice(0, limit),
    canLoadMore: sorted.length > limit,
    searchActive: false,
  };
}
