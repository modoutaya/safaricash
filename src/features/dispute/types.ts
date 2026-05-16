// Story 10.3 — dispute feature types + query keys.

import { z } from "zod";

/** Base TanStack Query key for dispute queries. `useDisputes(memberId)`
 *  scopes under `[...DISPUTES_QUERY_KEY, "member", memberId]`. */
export const DISPUTES_QUERY_KEY = ["disputes"] as const;

export const disputeStatusSchema = z.enum(["open", "resolved", "dismissed"]);

/** A `public.disputes` row, as the collector-side surface reads it.
 *  `notes` is the saver's optional free-text; plaintext (no vault). */
export const disputeRowSchema = z.object({
  id: z.string().uuid(),
  transaction_id: z.string().uuid(),
  notes: z.string().nullable(),
  flagged_at: z.string(),
  status: disputeStatusSchema,
});

export type DisputeRow = z.infer<typeof disputeRowSchema>;
