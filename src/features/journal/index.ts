// Story 12.1 — public barrel for the journal feature.
// Downstream consumers (the /journal route, future Story 12.x extensions)
// import from this barrel; direct imports into features/journal/api/ or
// features/journal/ui/ are forbidden by the `import/no-internal-modules`
// ESLint rule.

export { JournalPage } from "./ui/JournalPage";

export type { JournalMember, JournalCycleBounds } from "./api/useJournalMembers";
export type { JournalTransaction } from "./api/useJournalTransactions";
export type { JournalPeriod } from "./api/period";
