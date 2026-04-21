// Story 2.1 — stable recency sort for the member list.
//
// Order: latestInteractionAt DESC, then created_at-like secondary, then id
// lex DESC. Tertiary sort guarantees deterministic output so tests don't
// flake on ms-ties.

export interface RecencySortable {
  id: string;
  latestInteractionAt: string; // ISO-8601
  createdAt: string;
}

export function sortMembersByRecency<T extends RecencySortable>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.latestInteractionAt !== b.latestInteractionAt) {
      return a.latestInteractionAt < b.latestInteractionAt ? 1 : -1;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    // Tertiary lex DESC on id — deterministic even when timestamps collide.
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
}
