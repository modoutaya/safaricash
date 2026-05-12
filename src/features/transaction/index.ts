// Story 6.7 — public surface for the transaction feature.
//
// Cross-feature consumers (the member route in /app/routes/members/[id].tsx)
// MUST import via this barrel, not by reaching into ./api or ./ui. ESLint
// rule (no-restricted-imports) enforces the boundary at lint time.

// `getReceiptUrlBase` is intentionally NOT exported — it's internal to
// `shareReceipt.ts`. Exposing it would invite callers to compose the
// /r/{token} URL outside the helper, bypassing the "never log the token"
// invariant the helper protects (code review patch P6, Story 6.7).
export { shareReceipt, type ShareReceiptResult, type ShareReceiptInput } from "./api/shareReceipt";
export {
  ResendTransactionError,
  type ResendTransactionErrorCode,
} from "./api/resendTransactionError";
export {
  useResendTransaction,
  type ResendTransactionInput,
  type ResendTransactionReason,
  type ResendTransactionResult,
} from "./api/useResendTransaction";
export {
  TransactionReceiptSheet,
  type TransactionReceiptSheetProps,
} from "./ui/TransactionReceiptSheet";
