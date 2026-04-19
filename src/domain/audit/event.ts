// Canonical AuditEvent type. Mirrors the shape inserted by the Postgres
// trigger function `public.audit_emit()` in
// supabase/migrations/20260419000007_triggers_audit.sql.
//
// IMPORTANT: any field added or reordered here MUST be reflected in both
// (a) the SQL trigger's canonical serialization order, and
// (b) hashChain.ts canonical serialization,
// or the SQL ↔ TS contract test will fail.

export type AuditSource = "online" | "offline_reconciled";

export type AuditEntityTable = "members" | "cycles" | "transactions";

export type AuditEvent = {
  /** uuid v4 — primary key in audit_log */
  eventId: string;
  /** {entity}.{action_past_tense} per architecture.md § Event naming */
  eventType: string;
  /** owning collector (chain partition key) */
  collectorId: string;
  /** id of the affected row in the underlying table */
  entityId: string;
  /** source table name — one of `members` / `cycles` / `transactions` */
  entityTable: AuditEntityTable;
  /**
   * ISO 8601 UTC string with microsecond precision and trailing `Z`
   * (e.g. `2026-04-19T05:14:23.123456Z`). Postgres trigger uses
   * `to_char(timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.
   */
  timestamp: string;
  /** auth.uid() of the writing collector, or `'system'` for service-role / triggers */
  actor: string;
  /** Where the write originated. */
  source: AuditSource;
  /**
   * The committed row state (canonical jsonb form). Object keys are sorted
   * alphabetically by `canonicalJsonStringify()` to match Postgres jsonb
   * canonicalisation.
   */
  payload: Record<string, unknown>;
};

/**
 * Snapshot of an audit_log row for chain-verification helpers. Keys are
 * camelCased after `camelize()` from the snake_case Postgres column names.
 */
export type AuditLogRow = AuditEvent & {
  prevHash: Uint8Array | null;
  entryHash: Uint8Array;
};
