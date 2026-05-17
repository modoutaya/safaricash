// Story 5.4 / FR24 + FR25 — Zod schema at the API boundary.
//
// Defence-in-depth on top of the RPC's server-side validation:
//   - Client gate: CTA disabled until the amount is valid.
//   - Hook gate (this schema): rejects bad inputs before the network call.
//   - Server gate (record_advance RPC): re-validates everything.
//   - DB CHECK: cross-kind motive/ack invariant (advance ⟺ motive present).
//
// Story 4.6 — `motive` is optional (any string, including ""); the
// "Prêt Express" mockup labels the field optional. `saverAcknowledged`
// uses z.literal(true) — false / undefined are impossible to satisfy.

import { z } from "zod";

export const RecordAdvanceInputSchema = z.object({
  memberId: z.string().uuid(),
  cycleId: z.string().uuid(),
  amount: z.number().int().positive(),
  cycleDay: z.number().int().min(1).max(30),
  motive: z.string(),
  saverAcknowledged: z.literal(true),
});

export type RecordAdvanceInput = z.infer<typeof RecordAdvanceInputSchema>;
