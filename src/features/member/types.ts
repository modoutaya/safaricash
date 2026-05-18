// Story 2.1 — typed schemas for the member list surface.
//
// Layering: these are PostgREST row shapes + the derived view-model the UI
// consumes. Zod validates the server response at the boundary so a PostgREST
// schema change surfaces as a typed failure instead of a silent .map() crash.

import { z } from "zod";

import type { StatusBadgeKind } from "@/components/domain/StatusBadge";
import { formatE164, isValidSenegalPhone } from "@/features/auth/ui/phoneFormat";

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
  // Story 6.7 — exposed so the per-transaction receipt sheet can disable
  // the SMS button when the saver has opted out. The column is added by
  // Story 6.5 migration 0044. Default false at the DB level → safe optional.
  sms_opt_out: z.boolean().optional().default(false),
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

// Story 2.4 — full transaction row (decrypted via transactions_decrypted view).
// Mirrors public.transactions_kind_enum (migration 0001 line 49).
export const transactionKindSchema = z.enum(["contribution", "rattrapage", "advance"]);
export type TransactionKind = z.infer<typeof transactionKindSchema>;

export const transactionRowSchema = z.object({
  id: z.string().uuid(),
  member_id: z.string().uuid(),
  cycle_id: z.string().uuid(),
  kind: transactionKindSchema,
  amount: z.coerce.number().int().positive(), // decrypted from numeric(12,0)
  cycle_day: z.number().int().min(1).max(30),
  created_at: z.string(), // ISO-8601
  // Story 6.7 — exposed via transactions_decrypted (migration 0054) for the
  // share button to compose `${VITE_RECEIPT_URL_BASE}/{token}` client-side.
  // 32-hex token (Story 6.3 contract). Optional in the schema so older
  // PostgREST responses (pre-view-extension) still parse.
  receipt_token: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "receipt_token must be 32 hex chars")
    .optional(),
});
export type TransactionRow = z.infer<typeof transactionRowSchema>;

// ---------------------------------------------------------------------------
// UI-facing view-model.
// ---------------------------------------------------------------------------

// StatusBadge owns the authoritative DisplayStatus union; re-exported here
// so member-feature consumers get both types from one barrel import.

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
  /** Sum of advance amounts booked in the current cycle. 0 when there are
   *  no advances or no current cycle. */
  cycleAdvancesTotal: number;
  /** Projected final payout for the current cycle (dailyAmount × 29 −
   *  advances, via the Story 3.2 cycle engine). null when no current cycle. */
  projectedBalance: number | null;
}

/** TanStack Query key — exported for downstream stories to invalidate. */
export const MEMBERS_QUERY_KEY = ["members", "list"] as const;

// ---------------------------------------------------------------------------
// Story 2.2 — manual member creation.
// ---------------------------------------------------------------------------

/** Story 2.2 — UX threshold for "Ajouter un membre" CTA placement.
 *  ≤ this many visible members → header button (visible without scroll).
 *  > this many → FAB (ergonomic on long-scroll lists). */
export const MEMBER_HEADER_CTA_THRESHOLD = 10;

/** Form input shape for the manual create-member flow. Used by both the
 *  MemberForm (RHF resolver) and useCreateMember (defense-in-depth re-parse). */
export const createMemberInputSchema = z.object({
  name: z.string().trim().min(2, "Au moins 2 caractères").max(80, "Maximum 80 caractères"),
  // Required — every member must have a phone (E.164 Senegal mobile).
  // formatE164 normalises the input first, so a bare 9-digit local
  // number (e.g. 771234567) is accepted — the +221 indicatif is
  // optional, mirroring the login field.
  phoneNumber: z
    .string()
    .trim()
    .min(1, "Numéro requis")
    .transform(formatE164)
    .refine(isValidSenegalPhone, "Numéro invalide"),
  dailyAmount: z.coerce
    .number()
    .int("Montant entier requis")
    .min(100, "Minimum 100 FCFA")
    .max(100000, "Maximum 100 000 FCFA"),
});
export type CreateMemberInput = z.infer<typeof createMemberInputSchema>;

// ---------------------------------------------------------------------------
// Story 2.5 — edit member with impact alert (FR10).
// ---------------------------------------------------------------------------

/** Same shape + same rules as create. Aliased for call-site clarity. */
export const updateMemberInputSchema = createMemberInputSchema;
export type UpdateMemberInput = z.infer<typeof updateMemberInputSchema>;

/** Result of `computeEditImpact()` — drives the in-flight cycle warning. */
export type EditImpact = "none" | "cycle-affecting";

// ---------------------------------------------------------------------------
// Story 2.4 — member 360 profile.
// ---------------------------------------------------------------------------

/** TanStack Query key prefix for the per-member profile read. Story 2.5 /
 *  2.6 / 4.x will invalidate by this prefix when they mutate. */
export const MEMBER_PROFILE_QUERY_KEY = ["members", "profile"] as const;

/** Pure derived stats per FR17 — re-exported from the domain cycle engine
 *  (Story 3.2). Kept here as a type-alias re-export so existing imports
 *  from this barrel keep working unchanged. */
export type { MemberStats } from "@/domain/cycle";
