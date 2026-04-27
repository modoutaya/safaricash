// Story 5.4 / FR24 + FR25 — Zod schema at the API boundary.
//
// Defence-in-depth on top of the RPC's server-side validation:
//   - Client gate (Story 5.3): CTA disabled until amount/motive/ack valid.
//   - Hook gate (this schema): rejects bad inputs before the network call.
//   - Server gate (RPC migration 0033): re-validates everything.
//   - DB CHECK (migration 0032): cross-kind motive/ack invariant.
//
// `acknowledged` uses z.literal(true) — false / undefined are
// impossible to satisfy.

import { z } from "zod";

export const RecordAdvanceInputSchema = z.object({
  memberId: z.string().uuid(),
  cycleId: z.string().uuid(),
  amount: z.number().int().positive(),
  cycleDay: z.number().int().min(1).max(30),
  motive: z.string().refine((s) => s.trim().length >= 3, "Motif trop court"),
  saverAcknowledged: z.literal(true),
});

export type RecordAdvanceInput = z.infer<typeof RecordAdvanceInputSchema>;
