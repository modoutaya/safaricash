// Story 10.3 — public barrel for the dispute feature.
// Direct imports into features/dispute/api/ or features/dispute/ui/ are
// forbidden by the `import/no-internal-modules` ESLint rule.

export { useDisputes } from "./api/useDisputes";
export { useResolveDispute } from "./api/useResolveDispute";
export { useDisputeRealtime } from "./api/useDisputeRealtime";
export { DisputeInlineBanner } from "./ui/DisputeInlineBanner";
export { DisputeDetailSheet } from "./ui/DisputeDetailSheet";
export { DISPUTES_QUERY_KEY, disputeRowSchema, type DisputeRow } from "./types";
