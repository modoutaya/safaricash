# Story 4.3: Record contribution (online commit path)

Status: ready-for-dev

## Story

As a **collector**,
I want to **tap a member, confirm the pre-filled amount, and commit a contribution in under 5 seconds**,
so that **I run a 150-member daily route efficiently (FR22, NFR-P1).**

> **Predicate.** Stories 4.1 + 4.2 shipped the UI surfaces (MemberActionSheet + ProgressiveToast). Story 4.3 wires the **online commit path**: RPC + sms_queue enqueue trigger + `useRecordContribution` hook + sonner mounting + 5-second undo. Offline path = Story 4.5; SMS lifecycle (`sending`/`delivered` states) = Story 6.x.

## Acceptance Criteria

1. **RPC.** New SECURITY DEFINER `record_contribution(p_member_id, p_cycle_id, p_amount, p_cycle_day)` returning the new `transactions.id`:
   - Verifies caller owns the member (RLS-equivalent).
   - Validates `p_amount > 0`, `p_cycle_day ∈ [1, 30]`.
   - Encrypts `p_amount` via `vault_encrypt`.
   - INSERTs into `transactions` with `kind='contribution'`, `source='online'`.
   - The Story 3.4 `reject_transaction_on_closed_cycle` BEFORE INSERT trigger naturally protects against insertions on completed/settled cycles (sqlstate 23514 propagates as 409).
   - GRANT EXECUTE TO authenticated.

2. **sms_queue enqueue trigger** (BDD line 841). New AFTER INSERT trigger on `transactions` (kind ∈ contribution/rattrapage/advance):
   - Looks up the member's decrypted phone via `vault_decrypt(members.phone_number_encrypted)`.
   - If phone is non-empty: INSERT INTO `sms_queue` with `collector_id`, `transaction_id`, `recipient_phone={decrypted phone}`, `body='[STUB] Cotisation enregistrée'`, `status='queued'`.
   - If phone is empty/null: skip (cash-only saver, no SMS to send).
   - **Body is a STUB** — Story 6.1 (sms-dispatch) will REPLACE the trigger with the real SMS template (amount, projected balance, receipt URL).

3. **`useRecordContribution` hook.** New `src/features/transaction/api/useRecordContribution.ts`:
   - TanStack `useMutation<string, RecordContributionError, RecordContributionInput>`.
   - Calls the RPC.
   - In-flight ref guard (mirror useUpdateMember pattern).
   - `classifyError` covers `unauthorized`, `cycle_closed` (sqlstate 23514 from Story 3.4), `validation`, `network`, `unknown`.
   - On success: invalidate `MEMBERS_QUERY_KEY` (member moves to top — `latestInteractionAt` recency sort).
   - Companion test file (RTL + 5 error-code cases).

4. **Toast wiring.** New `src/features/transaction/api/showContributionToast.ts` helper:
   - Mounts `<ProgressiveToast>` via `toast.custom(...)` with state `{ kind: "just-committed", secondsLeft: 5, memberName }`.
   - Internal `setInterval` ticks `secondsLeft` down each second; updates the toast via `toast.custom(... { id })`.
   - At `secondsLeft = 0`: dismisses the toast (Story 4.3 stops here; Stories 6.x will add `sending`/`delivered` lifecycle).
   - Provides the `onUndo` callback to the toast: stops the timer + dismisses + DELETEs the transaction.
   - Returns `void` (fire-and-forget).

5. **Undo path.** Within the 5-second window, tapping Annuler:
   - DELETEs the row via PostgREST (`supabase.from("transactions").delete().eq("id", txId)` — RLS-allowed).
   - Cascades: sms_queue row deleted (FK on delete cascade per migration 0001:159).
   - Audit chain: `transaction.committed` event from the INSERT + `transaction.deleted` event from the DELETE both land. The chain is internally consistent.
   - Invalidates `MEMBERS_QUERY_KEY` again (recency sort regresses).

6. **Wire in MemberList.** `MemberList.tsx` already renders `<MemberActionSheet>` (Story 4.1). Add `onRecordContribution={(memberId) => recordContribution.mutateAsync({...}); showContributionToast({...})}` — bridges the action sheet's CTA to the hook + toast.

7. **Sonner Toaster mount.** Sonner is already installed + mounted globally (Story 2.5+ uses it). No new wiring needed at the app shell.

8. **i18n.** No new keys — reuse `members.toast.*` shipped by Story 4.2 + add `transaction.error.*` for the hook's error mapping:
   - `cycle_closed` = "Le cycle est clôturé. Redémarrez-en un nouveau pour reprendre les cotisations." (reuse the Story 3.4 key)
   - `unauthorized` = "Vous devez être reconnecté pour enregistrer une cotisation"
   - `validation` = "Données invalides — vérifiez le montant"
   - `network` = "Pas de réseau — vérifiez votre connexion"
   - `unknown` = "Erreur inattendue — réessayez"
   These render in a sonner `toast.error()` distinct from the ProgressiveToast.

9. **Tests.**
   - **Hook test:** `useRecordContribution.test.tsx` — 5 cases (happy path + 4 error codes).
   - **Toast helper test:** `showContributionToast.test.ts` — minimal (mock sonner.toast.custom + advance timers + assert state transitions).
   - **MemberList test extension:** existing card-tap test asserts the action-sheet's primary CTA is now ENABLED (was disabled in Story 4.1's default).
   - **DB contract test:** `record-contribution.contract.test.ts` (Deno) — 4 cases:
     - Happy path → row inserted, audit `transaction.committed` lands, sms_queue row enqueued (if phone present).
     - Member without phone → row inserted, NO sms_queue row.
     - Closed cycle → 23514 (Story 3.4 trigger fires).
     - Foreign collector → RLS rejection.

10. **E2E.** New `tests/e2e/flow-1-record-contribution.spec.ts`:
    - Seed 1 member (active cycle, dailyAmount=500).
    - Navigate to /members → assert member card visible.
    - Tap card → action sheet opens → primary CTA reads "Enregistrer cotisation — 500 FCFA".
    - Tap primary CTA → ProgressiveToast appears with "Cotisation enregistrée — Member RECORD-1" + countdown badge.
    - Service-role check: `transactions` row exists with `kind='contribution'`, `member_id=target.memberId`.
    - audit_log assertion: `transaction.committed` row exists with `actor=collector.userId`.
    - sms_queue assertion: 1 row enqueued with `transaction_id=new-tx-id`, `status='queued'`.
    - Undo assertion deferred (covered by component-level test of the toast helper).

11. **Performance note (NFR-P1).** The BDD targets p95 ≤ 5s on mid-range Android / 3G. Story 4.3 doesn't ship a perf measurement harness; that's a future infra story. The optimistic-UI pattern (mutation fires + toast appears immediately, doesn't await server roundtrip) keeps perceived latency near-zero.

12. **Out-of-scope (explicit).**
    - `sending` / `delivered` / `failed` toast states — Story 6.x (SMS realtime subscription).
    - Offline path / IndexedDB event log — Story 4.5 / 8.x.
    - Real SMS dispatch via Termii — Story 6.x (sms-worker).
    - Performance measurement — future infra story.

## Tasks / Subtasks

- [ ] **Task 0 — Migration A: `record_contribution` RPC.** Create `supabase/migrations/20260425000005_record_contribution.sql`. SECURITY DEFINER, validates inputs, encrypts amount, inserts. GRANT EXECUTE TO authenticated. Apply via `npm run db:migrate`.

- [ ] **Task 1 — Migration B: sms_queue enqueue trigger.** Create `supabase/migrations/20260425000006_enqueue_sms_on_transaction.sql`. AFTER INSERT trigger on transactions for kind ∈ (contribution, rattrapage, advance). Looks up decrypted phone, enqueues if non-empty, body='[STUB] Cotisation enregistrée'. Comment notes Story 6.1 will replace the body with the real template.

- [ ] **Task 2 — Database type.** Edit `src/infrastructure/supabase/database.types.ts` — add `record_contribution` RPC entry.

- [ ] **Task 3 — `useRecordContribution` hook.** New `src/features/transaction/api/useRecordContribution.ts` + companion test. Mirror `useUpdateMember` pattern.

- [ ] **Task 4 — `showContributionToast` helper.** New `src/features/transaction/api/showContributionToast.ts` + minimal test. Mounts ProgressiveToast via `toast.custom` with the 5-second countdown + onUndo wiring.

- [ ] **Task 5 — Undo helper.** New `src/features/transaction/api/undoTransaction.ts` (or inline in showContributionToast) — direct DELETE via supabase, invalidates MEMBERS_QUERY_KEY.

- [ ] **Task 6 — Wire MemberList.** Pass `onRecordContribution` to `<MemberActionSheet>`. The handler bridges the hook + toast.

- [ ] **Task 7 — i18n.** Add `transaction.error.*` namespace.

- [ ] **Task 8 — Deno contract test.** `record-contribution.contract.test.ts` per AC #9.

- [ ] **Task 9 — E2E.** `flow-1-record-contribution.spec.ts` per AC #10.

- [ ] **Task 10 — All gates + LOCAL Playwright.** typecheck / lint / vitest / test:edge / build + full Playwright suite locally before push.

- [ ] **Task 11 — Hygiene.** Story file + sprint-status flip.

## Dev Notes

### Architecture compliance

- New code in `src/features/transaction/` (matches `architecture.md:1087` slot for transaction capture).
- Sonner already wired globally (Story 2.5+).
- Cycle-engine helpers + Story 3.4 server-side gate already enforced — Story 4.3 just needs to call the right paths and let the trigger reject closed cycles.

### Why an RPC instead of direct PostgREST insert

The transaction has `amount_encrypted` (Vault uuid). The client doesn't call `vault_encrypt` directly (it would require multiple roundtrips). The RPC bundles encrypt + insert atomically. Same pattern as `create_member_with_cycle` (Story 2.2) and `update_member` (Story 2.5).

### Why the sms_queue body is a stub now

Story 6.1 (sms-dispatch) owns the SMS template (amount, projected balance, receipt URL). Story 4.3's BDD requires the trigger to enqueue (line 841), but doesn't specify the body. Stub body = stub for now; Story 6.1 will REPLACE the trigger function with the real template logic. Two-trigger-migrations is acceptable.

### Why undo = DELETE (not soft-delete)

The audit_log captures both the `transaction.committed` (INSERT) AND `transaction.deleted` (DELETE) events. The chain is internally consistent. Soft-delete adds a column + cascading complexity for zero MVP value (the user has 5s — beyond that, the cycle math has moved on).

### Anti-patterns

- **Do NOT add an IndexedDB event log** — that's Story 4.5 (offline path).
- **Do NOT add `sending` / `delivered` / `failed` toast states** — Story 6.x.
- **Do NOT add Termii integration** — Story 6.x.
- **Do NOT add a performance measurement harness** — future infra story.
- **Do NOT compute the SMS body** — Story 6.1's trigger replacement.

### Definition-of-done

- All 12 ACs satisfied + 11 tasks ticked.
- Tap card → action sheet → primary CTA → ProgressiveToast appears.
- DB row inserted; sms_queue row enqueued (if phone present); audit `transaction.committed` lands.
- Undo within 5s deletes the row.
- Member moves to top of list after commit.
- typecheck / lint / vitest / test:edge / build green.
- **`npx playwright test` (full suite) green LOCALLY before push** (Story 2.5 discipline).
- Story status `review`; sprint-status updated.

## References

- **Epic spec:** `epics.md:830-845` (Story 4.3 BDD).
- **PRD:** `prd.md:505` (FR22 — record contribution with pre-suggested amount).
- **Architecture:**
  - `architecture.md:1087` (transaction capture component slot),
  - `architecture.md:1112` (Flow 1 component map),
  - `architecture.md:1136-1142` (Flow 1 data-flow steps).
- **Schema:** `supabase/migrations/20260419000001_init_schema.sql:130-145` (transactions table), `:154-175` (sms_queue table — `transaction_id` has ON DELETE CASCADE).
- **RLS:** `supabase/migrations/20260419000002_rls_policies.sql:74-80` (transactions_collector_isolation — authenticated INSERT/DELETE allowed for own rows).
- **Companion stories already-shipped:**
  - Story 3.4 — `reject_transaction_on_closed_cycle` BEFORE INSERT trigger (kicks in for closed cycles).
  - Story 3.3 — `promote_cycle_on_advance` AFTER INSERT trigger (advances flip status; harmless for contribution kind).
  - Story 4.1 — `MemberActionSheet` shell with optional `onRecordContribution` prop.
  - Story 4.2 — `ProgressiveToast` pure component.
- **Existing patterns to mirror:**
  - `useUpdateMember.ts` (Story 2.5 — mutation hook shape, in-flight ref guard).
  - `create_member_with_cycle` (Story 2.2 — SECURITY DEFINER + vault_encrypt pattern).
  - `promote-cycle-on-advance.contract.test.ts` (Story 3.3 — Deno SQL contract test pattern).
- **Process discipline:** Run Playwright LOCALLY before each push.

## Dev Agent Record

### Implementation Plan
_(populated by dev agent)_

### Completion Notes
_(populated by dev agent)_

### Debug Log
_(populated by dev agent)_

## File List
_(populated by dev agent)_

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-24 | Winston (architect) | Story 4.3 spec generated by `bmad-create-story`. Wires Flow 1's online commit path: SECURITY DEFINER `record_contribution` RPC + sms_queue enqueue trigger (stub body — Story 6.1 replaces) + `useRecordContribution` hook + sonner-mounted ProgressiveToast in `just-committed` state with 5-second undo. Undo = direct DELETE (audit chain captures both events). Cycle-closed gate inherited from Story 3.4's trigger. SMS lifecycle (`sending`/`delivered`/`failed` states) explicitly deferred to Story 6.x. Status → ready-for-dev. |
