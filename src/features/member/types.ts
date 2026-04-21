// Story 2.1 — typed schemas for the member list surface.
//
// Layering: these are PostgREST row shapes + the derived view-model the UI
// consumes. Zod validates the server response at the boundary so a PostgREST
// schema change surfaces as a typed failure instead of a silent .map() crash.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enum shapes — mirrors public.{members_status_enum,cycles_status_enum}
// (supabase/migrations/20260419000001_init_schema.sql:46-48).
// ---------------------------------------------------------------------------

export const memberStatusSchema = z.enum(["active", "paused", "completed", "deleted"]);
export type MemberStatus = z.infer<typeof memberStatusSchema>;

export const cycleStatusSchema = z.enum(["active", "with_advance", "completed", "settled"]);
export type CycleStatus = z.infer<typeof cycleStatusSchema>;

// ---------------------------------------------------------------------------
// PostgREST row shapes (raw, pre-derivation).
// ---------------------------------------------------------------------------

export const memberRowSchema = z.object({
  id: z.string().uuid(),
  collector_id: z.string().uuid(),
  name: z.string(),
  phone_number: z.string().nullable(),
  daily_amount: z.coerce.number().int().positive(), // PostgREST returns numeric(12,0) as string
  status: memberStatusSchema,
  created_at: z.string(), // ISO-8601
  updated_at: z.string(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const cycleRowSchema = z.object({
  id: z.string().uuid(),
  cycle_number: z.number().int().positive(),
  start_date: z.string(), // YYYY-MM-DD
  end_date: z.string(),
  status: cycleStatusSchema,
});
export type CycleRow = z.infer<typeof cycleRowSchema>;

export const transactionTimestampSchema = z.object({
  created_at: z.string(),
});
export type TransactionTimestamp = z.infer<typeof transactionTimestampSchema>;

export const membersListRowSchema = memberRowSchema.extend({
  cycles: z.array(cycleRowSchema).nullish(),
  transactions: z.array(transactionTimestampSchema).nullish(),
});
export type MembersListRow = z.infer<typeof membersListRowSchema>;

// ---------------------------------------------------------------------------
// UI-facing view-model.
// ---------------------------------------------------------------------------

// StatusBadge owns the authoritative DisplayStatus union; re-exported here
// so member-feature consumers get both types from one barrel import.
import type { StatusBadgeKind } from "@/components/domain/StatusBadge";

/** The UX-level status used by the list UI. `hidden` rows are dropped
 *  before reaching the UI — the component type is DisplayStatus. */
export type DisplayStatus = StatusBadgeKind;
export type DerivedStatus = DisplayStatus | "hidden";

export interface MemberWithMeta {
  id: string;
  name: string;
  phoneNumber: string | null;
  dailyAmount: number;
  displayStatus: DisplayStatus;
  currentCycle: { id: string; startDate: string; dayNumber: number } | null;
  latestInteractionAt: string; // ISO-8601
}

/** TanStack Query key — exported for downstream stories to invalidate. */
export const MEMBERS_QUERY_KEY = ["members", "list"] as const;
