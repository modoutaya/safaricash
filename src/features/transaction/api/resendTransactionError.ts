// Story 6.7 — Typed error class for the per-transaction resend mutation.
//
// Mirrors Story 4.5's UndoTransactionError pattern: lets the UI branch on
// `err.code` rather than parsing Postgres / PostgREST message strings.

export type ResendTransactionErrorCode =
  | "auth_unauthenticated"
  | "not_found"
  | "network"
  | "internal_unexpected"
  | "unknown";

export class ResendTransactionError extends Error {
  public readonly code: ResendTransactionErrorCode;
  constructor(code: ResendTransactionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ResendTransactionError";
  }
}
