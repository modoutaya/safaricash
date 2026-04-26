# Story 5.4: Commit advance transaction with audit entry

Status: ready-for-dev

## Story

As a **collector**,
I want **the advance commit to persist the transaction, update the cycle status, and trigger SMS dispatch**,
so that **the advance is recorded and the saver is notified (FR24 commit path).**

> **Predicate of this story.** Stories 5.1, 5.2, 5.3 shipped the **preview surface** of Flow 2: simulation panel, situation panel, suggested chips, amount input, motive textarea, saver-acknowledgment checkbox, and the precedence-ordered CTA gate. Story 5.4 ships the **commit path** that closes Epic 5: 1 schema migration (motive + saver_acknowledged columns), 1 SECURITY DEFINER RPC (`record_advance`), 1 hook (`useRecordAdvance`), 1 toast helper (`showAdvanceToast`), wiring of `onConfirm` in the route file, and the E2E spec. Story 3.3's `promote_cycle_on_advance` trigger handles the cycle-status transition (active → with_advance) for free. Story 4.3's `enqueue_sms_on_transaction` trigger handles the SMS enqueue for free. The audit trigger emits `transaction.committed` with the full row payload — including `motive` and `saver_acknowledged` (BDD line 946 — *"the audit-log event records the motive and acknowledgment state"*).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 943-949; the rest are spec-derived constraints.

1. **Schema migration — motive + saver_acknowledged columns.** New migration `20260426000007_add_advance_columns_to_transactions.sql`:
   - `ALTER TABLE public.transactions ADD COLUMN motive text NULL;` — nullable because `kind ∈ {contribution, rattrapage}` rows have no motive (only advances do).
   - `ALTER TABLE public.transactions ADD COLUMN saver_acknowledged boolean NULL;` — same nullability rationale.
   - **Cross-kind CHECK constraint** linking advance rows to motive + ack:
     ```sql
     ALTER TABLE public.transactions
       ADD CONSTRAINT transactions_advance_motive_ack_chk
       CHECK (
         (kind = 'advance' AND motive IS NOT NULL AND length(trim(motive)) >= 3 AND saver_acknowledged = true)
         OR
         (kind <> 'advance' AND motive IS NULL AND saver_acknowledged IS NULL)
       );
     ```
     This pairs with Story 4.4's `transactions_days_covered_kind_chk` — both encode "kind ⇒ kind-specific column shape". An auditor querying the table can rely on the invariant: every advance has a motive ≥ 3 chars + saver-ack = true; nothing else does.
   - **No backfill needed.** Existing rows are all `contribution` or `rattrapage` (Stories 4.3 + 4.4) — they already satisfy the `kind <> 'advance' AND motive IS NULL AND saver_acknowledged IS NULL` branch.
   - **Apply via `npm run db:migrate`** (CLAUDE.md — preserves seeded data).

2. **`record_advance` RPC.** New migration `20260426000008_record_advance.sql` defines `public.record_advance(p_member_id, p_cycle_id, p_amount, p_cycle_day, p_motive, p_saver_acknowledged)` returning `uuid`:
   - SECURITY DEFINER + `set search_path = public, pg_temp`. Mirror Story 4.3 / 4.4 RPC structure.
   - Validates `auth.uid()` non-null → `28000`.
   - Validates `p_amount > 0` → `22000`.
   - Validates `p_cycle_day ∈ [1, 30]` → `22000`.
   - Validates `length(trim(p_motive)) >= 3` → `22000` ("invalid_motive: motive must be at least 3 characters"). Defence-in-depth — the client gate from Story 5.3 already enforces this, but a tampered client cannot bypass.
   - Validates `p_saver_acknowledged = true` → `22000` ("missing_acknowledgment: saver acknowledgment required"). Same defence-in-depth.
   - Verifies member ownership via `auth.uid()`.
   - **Verifies cycle capacity** — calls into the cycle engine's invariant on the server side: load existing advances for the cycle, sum them, check `sum + p_amount <= dailyAmount × 29`. **If breached** → `22023` ("over_limit: advance exceeds projected available balance"). The client already prevents this via Story 5.1's `<AdvanceSimulationPanel>` over-limit state, but the server is the canonical truth.
   - Encrypts `p_amount::text` via `vault_encrypt`.
   - INSERTs into `transactions` with `kind='advance'`, `source='online'`, `motive=trim(p_motive)`, `saver_acknowledged=true`, `days_covered=1` (advances are point-events per Story 4.4 AC #6).
   - Returns the new `transactions.id`.
   - GRANT EXECUTE TO authenticated.
   - **Triggers fire automatically (in order documented in Story 4.4 AC):**
     1. BEFORE INSERT: `reject_transaction_on_closed_cycle` (Story 3.4) — gates closed cycles.
     2. (INSERT itself).
     3. AFTER INSERT: `audit_emit` (Story 1.2) — emits `transaction.committed` with `payload` containing motive + saver_acknowledged (the trigger's `to_jsonb(NEW)` captures every column).
     4. AFTER INSERT: `enqueue_sms_on_transaction` (Story 4.3) — enqueues `sms_queue` row (kind ∈ contribution/rattrapage/advance, body STUB; Story 6.1 will template).
     5. AFTER INSERT: `promote_cycle_on_advance_trigger` (Story 3.3) — flips cycle status `active → with_advance`.

3. **Useful comment in the migration header** citing BDD lines 943-949 + FR24 + FR25 + the trigger ordering.

4. **`useRecordAdvance` hook.** New `src/features/transaction/api/useRecordAdvance.ts`:
   - `useMutation<string, RecordAdvanceError, RecordAdvanceInput>`.
   - `RecordAdvanceInput = { memberId: string; cycleId: string; amount: number; cycleDay: number; motive: string; saverAcknowledged: boolean }`.
   - Pre-call **Zod validation** at the boundary using `RecordAdvanceInputSchema`:
     ```ts
     export const RecordAdvanceInputSchema = z.object({
       memberId: z.string().uuid(),
       cycleId: z.string().uuid(),
       amount: z.number().int().positive(),
       cycleDay: z.number().int().min(1).max(30),
       motive: z.string().refine((s) => s.trim().length >= 3, "Motif trop court"),
       saverAcknowledged: z.literal(true), // BDD line 932 — must be true
     });
     ```
     Defence-in-depth on top of the RPC's server-side checks.
   - Error codes: `unauthorized | cycle_closed | over_limit | invalid_motive | missing_acknowledgment | validation | not_found | network | unknown`. New error class `RecordAdvanceError` mirroring Stories 4.3 / 4.4 patterns. `classifyError` distinguishes:
     - sqlstate `28000` → `unauthorized`
     - sqlstate `23514` → `cycle_closed` (Story 3.4 trigger)
     - sqlstate `22023` → `over_limit` (RPC capacity check)
     - sqlstate `22000` + message contains `"motive"` → `invalid_motive`
     - sqlstate `22000` + message contains `"acknowledgment"` → `missing_acknowledgment`
     - sqlstate `22000` other → `validation`
     - sqlstate `P0002` / `PGRST116` → `not_found`
     - network → `network`
     - else → `unknown`
   - In-flight ref guard.
   - On success: `queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY })` (recency sort) AND `queryClient.invalidateQueries({ queryKey: MEMBER_PROFILE_QUERY_KEY })` (the cycle status changes from `active` → `with_advance`; the profile re-fetch picks it up).
   - 9 RTL test cases (happy path + 8 error code paths).

5. **`showAdvanceToast` helper.** New `src/features/transaction/api/showAdvanceToast.ts`:
   - Same shape as `showRattrapageToast` (Story 4.4) — re-uses the shared `mountJustCommittedToast({ bodyText, onUndo })` inner helper if Story 4.4 extracted it; otherwise mirror the inline pattern.
   - Body text: `t("members.toast.advance_committed", { name })` → *"Prêt accordé — {name}"* (BDD line 949).
   - 5-second undo countdown identical to contribution/rattrapage.
   - **Undo path:** `onUndo` calls `undoTransaction(txId, queryClient)` (Story 4.5's soft-undo helper, which UPDATES `undone_at` rather than DELETEing). The advance row's status flip (active → with_advance from Story 3.3) is NOT automatically reverted by the undo — the `with_advance` status is sticky until cycle settlement. **Document this** in Dev Notes: an undone advance leaves the cycle in `with_advance` status; the projected balance recovers (because `transactions_decrypted` filters undone rows), but the badge stays. Story 7.x settlement reconciles. **OR** — defensive option: a future patch updates `promote_cycle_on_advance` to also handle the undo path. **Story 5.4 ships the simpler path**: undo reverses the financial impact via the view filter, leaves the status sticky. Note this as a known limitation.

6. **Route wiring.** Edit `src/app/routes/members/[id].advance.tsx`:
   - Currently delegates to `<AdvanceFlow memberId={id} />` without an `onConfirm` prop (Story 5.2's choice — kept the route minimal).
   - Story 5.4 wires `onConfirm`:
     ```tsx
     const recordAdvance = useRecordAdvance();
     const queryClient = useQueryClient();
     const navigate = useNavigate();
     const { data } = useMemberProfile(id); // already fetched by the screen, but the route also needs `name` for the toast

     const handleConfirm = async (payload: AdvanceConfirmPayload) => {
       if (!data?.member || !data.currentCycle) return;
       try {
         const txId = await recordAdvance.mutateAsync({
           memberId: id,
           cycleId: data.currentCycle.id,
           amount: payload.amount,
           cycleDay: data.stats.cycleDay,
           motive: payload.motive,
           saverAcknowledged: payload.acknowledged,
         });
         showAdvanceToast({
           memberName: data.member.name,
           onUndo: () => { void undoTransaction(txId, queryClient); },
         });
         navigate(`/members/${id}`); // back to the profile after commit
       } catch (err) {
         if (err instanceof RecordAdvanceError) {
           toast.error(t(`advance.error.${err.code}`));
         } else {
           toast.error(t("transaction.error.unknown"));
         }
       }
     };
     ```
   - The route component fetches the same `useMemberProfile` query that `<AdvanceFlow>` already fetches — TanStack Query de-dupes; same cache key, single RTT.

7. **`<AdvanceFlow>` receives `onConfirm` and consumes it.** Story 5.3 already exported the prop; Story 5.4 confirms the route now passes it. The CTA's onClick (when enabled per Story 5.3's gate) calls `onConfirm({ amount, motive: motive.trim(), acknowledged: true })`. No change to `<AdvanceFlow>` itself in this story.

8. **i18n keys — error mappings + toast body.** Add to `src/i18n/fr.json`:
   - `members.toast.advance_committed` = `"Prêt accordé — {name}"`
   - `advance.error.unauthorized` = `"Vous devez être reconnecté pour accorder un prêt"`
   - `advance.error.cycle_closed` = `"Le cycle est clôturé. Impossible d'accorder un prêt."`
   - `advance.error.over_limit` = `"Le prêt dépasse le solde disponible. Réduisez le montant."`
   - `advance.error.invalid_motive` = `"Saisissez un motif d'au moins 3 caractères."`
   - `advance.error.missing_acknowledgment` = `"L'acquittement du saver est requis."`
   - `advance.error.validation` = `"Données invalides — vérifiez les champs."`
   - `advance.error.not_found` = `"Membre ou cycle introuvable."`
   - `advance.error.network` = `"Pas de réseau — vérifiez votre connexion."`
   - `advance.error.unknown` = `"Erreur inattendue — réessayez."`
   - 10 keys. The `members.toast.advance_committed` key sits alongside `members.toast.committed` (Story 4.3) and `members.toast.rattrapage_committed` (Story 4.4) for taxonomic consistency.

9. **Tests — RPC contract (Deno).** New `supabase/functions/_shared/record-advance.contract.test.ts`. Cases:
   - **Happy path:** insert via RPC → row exists with `kind='advance'`, `motive=trimmed`, `saver_acknowledged=true`, `days_covered=1`, decrypted `amount` matches input. Audit `transaction.committed` event fires with `motive` + `saver_acknowledged` in the payload. `sms_queue` row enqueued. Cycle status flips to `with_advance` (Story 3.3 trigger).
   - **Motive too short:** `length(trim(motive)) < 3` → RPC raises `22000` with "invalid_motive" message.
   - **Acknowledgment false:** `saver_acknowledged=false` → RPC raises `22000` with "missing_acknowledgment" message.
   - **Over-limit:** existing advances + new amount > `dailyAmount × 29` → RPC raises `22023` with "over_limit".
   - **Closed cycle:** RPC validations pass, INSERT hits Story 3.4 BEFORE INSERT trigger → `23514`.
   - **Foreign collector:** `28000`.
   - **Direct INSERT bypassing RPC** with `kind='advance'` + `motive=NULL` → DB CHECK constraint `transactions_advance_motive_ack_chk` rejects (defence-in-depth on AC #1).
   - **Direct INSERT** with `kind='contribution'` + `motive='hello'` → CHECK rejects (only advances may have motive).
   - **Audit payload integrity:** assert the audit_log row's `payload` JSON contains `"motive"` and `"saver_acknowledged"` keys with the expected values (BDD line 946 explicit requirement).
   - Add path to `scripts/run-edge-tests.sh`.

10. **Tests — vitest.**
    - **Hook test** `src/features/transaction/api/useRecordAdvance.test.tsx` — 9 cases (happy + 8 error codes). Mirror Story 4.3 hook test pattern.
    - **Schema test** `src/features/transaction/api/RecordAdvanceInputSchema.test.ts` — 5 cases (valid input passes; each invalid field rejects).
    - **Toast helper test** `src/features/transaction/api/showAdvanceToast.test.ts` — 1 case (mounts toast with correct body, advances timer, asserts dismiss).
    - **Route test extension** for `[id].advance.tsx` — assert `onConfirm` wires correctly. Mock `useRecordAdvance.mutateAsync` happy path; assert `showAdvanceToast` called + navigate to profile. 1 error case asserting `toast.error` is called with the mapped key.

11. **Tests — E2E (Playwright).** New `tests/e2e/flow-2-advance.spec.ts`:
    - Seed: 1 member with active cycle, `dailyAmount=5000`, `cycleDay=10`, no existing advances.
    - Login → `/members` → tap card → action sheet → tap "Prêt" → URL is `/members/:id/advance`.
    - Assert situation panel shows "Jour 10 sur 30", "Versé : 0 FCFA", "Avances en cours : 0 FCFA".
    - Tap suggested-amount chip "100 000 FCFA".
    - Type motive: "Frais de scolarité de la fille".
    - Check the saver-ack box.
    - Assert primary CTA enables.
    - Tap CTA → toast appears with "Prêt accordé — {name}".
    - Assert URL navigates back to `/members/:id`.
    - Service-role assertions:
      - `transactions` row exists with `kind='advance'`, `motive='Frais de scolarité de la fille'`, `saver_acknowledged=true`, `days_covered=1`, decrypted amount = 100000.
      - `audit_log` `transaction.committed` row's payload contains `"motive"` + `"saver_acknowledged": true`.
      - `sms_queue` row queued with `transaction_id = new-tx-id`.
      - `cycles.status = 'with_advance'` (flipped from `active` by Story 3.3 trigger).
    - **Run LOCALLY** before push (Story 2.5 retro).

12. **Closed-cycle gate is automatic.** Story 3.4's BEFORE INSERT trigger raises `23514` for `kind='advance'` on `completed`/`settled` cycles (Story 3.4 AC #3 — "trigger rejects ALL kinds"). Story 5.4 does NOT add a separate gate. Story 5.2's `<AdvanceFlow>` redirect (AC #10) prevents the entry path; the trigger is the last line of defence.

13. **No new dependencies.**

14. **All gates green.**
    - `npm run db:migrate` — applies 2 new migrations (advance columns + RPC).
    - `npm run db:types` — regenerates `database.types.ts` so `record_advance` is typed + new columns appear.
    - `npm run typecheck` / `npm run lint` / `npm test -- --coverage` / `npm run test:edge` / `npm run build` — all green.
    - Domain still 100 %; new files ≥ 80 %.
    - `npx playwright test` — full suite green LOCALLY before push. 1 new spec.

## Tasks / Subtasks

- [ ] **Task 0 — Schema migration (AC #1).** Create `20260426000007_add_advance_columns_to_transactions.sql`. Adds `motive` + `saver_acknowledged` columns + cross-kind CHECK constraint. Apply via `npm run db:migrate`.

- [ ] **Task 1 — RPC migration (AC #2 #3).** Create `20260426000008_record_advance.sql`. SECURITY DEFINER + ownership + capacity check + Vault encrypt + INSERT. Returns `uuid`.

- [ ] **Task 2 — Regenerate types.** `npm run db:types`.

- [ ] **Task 3 — Zod schema + hook (AC #4 #10).** Create `src/features/transaction/api/RecordAdvanceInputSchema.ts` + `.test.ts` (5 cases). Create `src/features/transaction/api/useRecordAdvance.ts` + `.test.tsx` (9 cases). Create `src/features/transaction/api/RecordAdvanceError.ts` (or co-locate with the hook).

- [ ] **Task 4 — Toast helper (AC #5 #10).** Create `src/features/transaction/api/showAdvanceToast.ts` + `.test.ts`. Reuse `mountJustCommittedToast` if Story 4.4's refactor extracted it; otherwise mirror the inline pattern. **Document the cycle-status sticky-after-undo limitation.**

- [ ] **Task 5 — Route wiring (AC #6 #7).** Edit `src/app/routes/members/[id].advance.tsx`. Wire `useRecordAdvance` + `showAdvanceToast` + error toast. Pass `onConfirm` to `<AdvanceFlow>`.

- [ ] **Task 6 — i18n (AC #8).** Add 10 keys.

- [ ] **Task 7 — Edge contract test (AC #9).** New `supabase/functions/_shared/record-advance.contract.test.ts`. ≥ 9 cases. Add path to `scripts/run-edge-tests.sh`.

- [ ] **Task 8 — E2E (AC #11).** New `tests/e2e/flow-2-advance.spec.ts`. **Run LOCALLY** before push.

- [ ] **Task 9 — All gates (AC #14).** `db:migrate` / `db:types` / `typecheck` / `lint` / `test --coverage` / `test:edge` / `build` / `npx playwright test`.

- [ ] **Task 10 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `5-4-commit-advance-transaction: ready-for-dev → review`. **Closes Epic 5** — confirm `epic-5: in-progress` stays until all 4 stories reach `done`; do NOT flip to `done` from this story.
  - Document the cycle-status-sticky-after-undo limitation for the future Story 7.x settlement work.

## Dev Notes

### Architecture compliance

- **Layering.** Migration + RPC at the SQL layer → Zod schema + hook + toast helper in `features/transaction/api/` → wired in `app/routes/members/[id].advance.tsx`. No `domain/` changes (math reused from Story 3.2). No `infrastructure/` changes (Supabase client already configured).
- **Cite sources.** Each new file cites BDD lines 943-949 + FR24 + FR25 + the relevant predecessor stories.
- **Defence-in-depth.** Triple-gated:
  - Client gate (Story 5.3): CTA disabled until amount + motive + ack are valid.
  - Hook gate (Story 5.4): Zod schema rejects bad inputs before they reach the RPC.
  - Server gate (Story 5.4): RPC validates ownership + amount + cycle_day + motive + ack + capacity. DB CHECK constraint enforces the kind ⇒ motive/ack invariant.
- **Free triggers.** Story 3.3 (status flip), Story 3.4 (closed-cycle gate), Story 4.3 (SMS enqueue), Story 1.2 (audit emit) — all fire automatically. Story 5.4 ships the *least* code that completes the contract.

### Why server-side capacity check (vs trusting the client)

Story 5.1's `<AdvanceSimulationPanel>` renders the over-limit state when `canAcceptAdvance(...)` returns false. Story 5.3's CTA gate respects this. **But** a tampered client could call the RPC directly with an over-limit amount. Without server-side validation, the advance would land, the saver's projected balance would go negative at settlement time, and Story 7.x would have to either short-pay the saver or absorb the loss. The RPC's capacity check ensures the cycle invariant holds even under client tampering. Cost: 1 SQL `SELECT sum(amount) FROM transactions WHERE cycle_id = ? AND kind = 'advance' AND undone_at IS NULL` (the `undone_at` filter ties to Story 4.5).

### Why the cycle-status sticky-after-undo limitation

Story 3.3's `promote_cycle_on_advance` AFTER INSERT trigger flips `active → with_advance`. There is NO trigger that flips back. When Story 4.5's soft-undo runs (UPDATE `undone_at = now()`), the cycle status stays at `with_advance`. **Why ship this limitation?**
- A reverse-flip trigger would need to query "are there any non-undone advances on this cycle?" before flipping back to `active`. That's a stateful aggregation that Story 3.3 deliberately avoided (the original trigger is one-shot per insert).
- The financial impact is reverted (the advance row is filtered from `transactions_decrypted`), so the projected balance recovers correctly.
- The visible badge staying at `with_advance` is a minor UX inconsistency, NOT a correctness issue.
- Fixing it cleanly belongs to a future patch that re-evaluates the cycle status from scratch (likely as part of Story 7.x settlement when the cycle is finalised).
- Document the limitation. Track in `_bmad-output/implementation-artifacts/deferred-work.md` (the file already exists per the repo).

### Why a NEW i18n namespace `advance.error.*` (instead of reusing `transaction.error.*`)

Story 4.3 introduced `transaction.error.*` for contribution-specific copy. Story 4.4 was supposed to add `transaction.error.rattrapage_invalid_days` (Story 4.4 AC #16). Story 5.4 introduces advance-specific error copy under `advance.error.*` — namespace separation prevents collision (e.g., `transaction.error.over_limit` would be ambiguous if both contribution and advance were to use it). Each transaction kind owns its error-copy namespace.

### Anti-patterns (do NOT do)

- **Do NOT** trust the client-supplied amount or capacity. RPC re-validates.
- **Do NOT** skip the DB CHECK constraint on `kind ⇒ motive/ack`. Defence-in-depth.
- **Do NOT** skip the server-side motive trim. The audit log payload comes from `to_jsonb(NEW)` — if the client passes whitespace-padded motive, it lands in audit untrimmed. Trim at the RPC entry.
- **Do NOT** add a reverse-flip trigger for the cycle status on undo. Out of scope; documented as a deferred limitation.
- **Do NOT** introduce a new `record_transaction` umbrella RPC. Three RPCs (contribution / rattrapage / advance) with distinct validation contracts is clearer than one over-parameterised RPC.
- **Do NOT** pass `motive` to the audit-log payload via a separate column. The audit trigger's `to_jsonb(NEW)` already captures every column on the transactions row.
- **Do NOT** ship the route file without `useQueryClient` import — `useRecordAdvance` returns invalidations but the toast's `onUndo` also needs the queryClient.
- **Do NOT** silently swallow errors in the route handler. The `toast.error` mapping is required for collector visibility.
- **Do NOT** hard-code the profile-redirect URL in `<AdvanceFlow>`. The route owns navigation; the screen owns the form.
- **Do NOT** add `motive` to the `transactions_decrypted` view at MVP. The view is for the transactions list (Story 2.4) which doesn't display motive at this stage. If a future story (member profile transaction history with motive) needs it, add then.

### Edge cases worth testing

- **Motive of exactly 3 chars after trim** (`"abc"`). Passes both Zod + RPC.
- **Motive of 280 chars** (the maxLength). Passes; audit payload size impact is negligible.
- **Saver_acknowledged: false** explicitly. Zod rejects (`z.literal(true)`).
- **Amount exactly at the boundary** (`dailyAmount × 29 - sum(existing)`). RPC accepts (boundary equality per Story 3.2 INV-3).
- **Amount 1 unit over** the boundary. RPC raises 22023.
- **Member with closed cycle** (direct URL → bypassed Story 5.2's redirect via cached state). RPC raises 23514.
- **Two advances back-to-back** on the same cycle. First succeeds; cycle becomes `with_advance`. Second: same cycle status (`with_advance`); Story 3.3 trigger no-ops because already in `with_advance`. Both advances persisted; audit chain has two `transaction.committed` events.
- **Undo within 5 s** (Story 4.5 path). Cycle status stays `with_advance`; `transactions_decrypted` no longer returns the row; projected balance recovers.
- **Network error mid-commit.** Hook surfaces `network`; toast shows the error message; `<AdvanceFlow>` returns to the form unchanged (Story 5.3's gate state preserved). Collector retries.
- **Concurrent commit + read race** (collector commits while saver reads receipt URL). RLS-safe; the saver's view is service-role-rendered (Story 6.4) and reads the just-committed row.

### Definition-of-done checklist

- All 14 ACs satisfied + all 11 tasks ticked.
- 2 migrations applied via `npm run db:migrate`.
- `npm run db:types` regenerated.
- 9+ Deno contract tests pass.
- 9 hook tests + 5 schema tests + 1 toast test + 2 route tests pass.
- 1 E2E spec passes locally.
- All gates green.
- Story status set to `review`; sprint-status updated.
- Cycle-status-sticky-after-undo limitation documented in `deferred-work.md`.
- Epic 5 has all 4 stories at `ready-for-dev` or `review`/`done`.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 935-949 (Story 5.4 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` (FR24 — advance commit; FR25 — motive + acknowledgment).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:1086` (FR15-21 home: cycle module + features/cycle).
  - `_bmad-output/planning-artifacts/architecture.md:1087` (transaction capture: `src/features/transaction/`).
  - `_bmad-output/planning-artifacts/architecture.md:1113` (Flow 2 component map).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:765-792` (Flow 2 mermaid).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:1014` (advance flow as ceremony — slower, multi-step).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql:131-150` (transactions table).
  - `supabase/migrations/20260425000005_record_contribution.sql` (RPC template — Story 4.3).
  - `supabase/migrations/20260425000003_promote_cycle_on_advance.sql` (the status-flip trigger that fires for free).
- **Companion stories:**
  - Story 3.2 — cycle engine math (capacity check uses `canAcceptAdvance` semantics).
  - Story 3.3 — `promote_cycle_on_advance` trigger (active → with_advance).
  - Story 3.4 — `reject_transaction_on_closed_cycle` BEFORE INSERT trigger (closed-cycle gate).
  - Story 4.3 — `enqueue_sms_on_transaction` AFTER INSERT trigger (SMS enqueue) + RPC + hook + toast templates.
  - Story 4.4 — `days_covered` column + cross-kind CHECK precedent + `mountJustCommittedToast` shared helper.
  - Story 4.5 — `undoTransaction` soft-undo helper (the toast's `onUndo` callback).
  - Story 5.1 — `<AdvanceSimulationPanel>`.
  - Story 5.2 — `<AdvanceFlow>` route surface.
  - Story 5.3 — motive + ack form fields + `onConfirm` prop + `AdvanceConfirmPayload` type.
- **Existing patterns to mirror:**
  - `record_contribution.sql` (Story 4.3 — SECURITY DEFINER RPC structure).
  - `record_rattrapage` (Story 4.4 — server-side derived value pattern; here the derived value is the `motive` trim + cycle capacity check).
  - `useRecordContribution.ts` (Story 4.3 — hook structure).
  - `record-contribution.contract.test.ts` (Deno test template).
  - `flow-1-record-contribution.spec.ts` (E2E template).
- **Process discipline:** `npm run db:migrate` (CLAUDE.md). Run Playwright LOCALLY (Story 2.5 retro).

## Dev Agent Record

### Agent Model Used

(filled in by dev agent at implementation time)

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 5.4 spec generated by `bmad-create-story`. Closes Epic 5 by shipping the Flow 2 commit path: 2 migrations (motive + saver_acknowledged columns + cross-kind CHECK constraint, then `record_advance` SECURITY DEFINER RPC with server-side capacity check), `RecordAdvanceInputSchema` (Zod) + `useRecordAdvance` hook + `showAdvanceToast` helper + route wiring of `onConfirm`. Triggers fire for free: Story 3.4 (closed-cycle gate), Story 1.2 (audit `transaction.committed` with motive + ack in payload), Story 4.3 (SMS enqueue), Story 3.3 (active → with_advance flip). Cycle-status-sticky-after-undo documented as a deferred limitation (no reverse-flip trigger; Story 7.x settlement reconciles). 10 i18n keys under `advance.error.*` namespace + `members.toast.advance_committed`. New Flow 2 E2E. Status → ready-for-dev. |
