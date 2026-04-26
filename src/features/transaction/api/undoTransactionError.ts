// Story 4.5 — UndoTransactionError + classifier.
//
// Mirrors the typed-error pattern from Stories 4.3 / 4.4 RPCs so the
// consumer (MemberList onUndo wrapper) can map sqlstates → i18n copy.

import type { PostgrestError } from "@supabase/supabase-js";

export type UndoTransactionErrorCode =
  | "unauthorized"
  | "not_found"
  | "window_expired"
  | "already_undone"
  | "network"
  | "unknown";

export class UndoTransactionError extends Error {
  public readonly code: UndoTransactionErrorCode;
  constructor(code: UndoTransactionErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "UndoTransactionError";
  }
}

export function classifyUndoError(
  err: PostgrestError | { message?: string; code?: string } | null,
): UndoTransactionErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  const code = "code" in err ? err.code : undefined;

  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if (code === "42501" || code === "28000") return "unauthorized";
  if (code === "P0002" || code === "PGRST116") return "not_found";
  if (msg.includes("not_found")) return "not_found";
  if (code === "22023" || msg.includes("window_expired")) return "window_expired";
  if (code === "0L000" || msg.includes("already_undone")) return "already_undone";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}
