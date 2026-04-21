// Story 2.1 — public barrel for the member feature.
// Downstream stories (2.2 create, 2.5 edit, 4.x transactions, 9.x dashboard)
// consume this barrel; direct imports into features/member/api/ or
// features/member/ui/ are forbidden by the `import/no-internal-modules`
// ESLint rule.

export { useMembers } from "./api/useMembers";
export { MEMBERS_QUERY_KEY } from "./types";
export { MemberList } from "./ui/MemberList";
export { MemberCard } from "./ui/MemberCard";
export type {
  DisplayStatus,
  DerivedStatus,
  MemberRow,
  MemberStatus,
  MemberWithMeta,
  CycleRow,
  CycleStatus,
  TransactionTimestamp,
} from "./types";
