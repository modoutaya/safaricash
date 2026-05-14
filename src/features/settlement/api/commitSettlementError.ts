// Story 7.4 — typed error class for the commit-settlement mutation.
//
// Mirrors Story 6.6 ResendHistoryError + Story 6.7 ResendTransactionError
// shape so the dialog + toast layer can branch on `error.code` without
// parsing strings. `serverPayout` is optional and only populated for the
// "payout_mismatch" code so the UI can display the authoritative number.

export type CommitSettlementErrorCode =
  | "credentials_invalid"
  | "rate_limited"
  | "not_found"
  | "cycle_not_settleable"
  | "payout_mismatch"
  | "request_invalid"
  | "auth_unauthenticated"
  | "internal_unexpected"
  | "network"
  | "unknown";

export class CommitSettlementError extends Error {
  public readonly code: CommitSettlementErrorCode;
  /** Server-recomputed payout — populated for the `payout_mismatch` case only. */
  public readonly serverPayout: number | undefined;

  constructor(code: CommitSettlementErrorCode, message: string, serverPayout?: number) {
    super(message);
    this.code = code;
    this.serverPayout = serverPayout;
    this.name = "CommitSettlementError";
  }
}
