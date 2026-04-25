# Story 4.5: Undo a just-committed transaction within 5 seconds

Status: ready-for-dev

## Story

As a **collector**,
I want to **cancel an accidental transaction within 5 seconds of commit**,
so that **a wrong tap doesn't force me into the edit-and-audit flow (FR22 support).**

> **Predicate of this story.** Story 4.3 shipped a 5-second undo affordance via the `ProgressiveToast`'s "Annuler" button + `undoTransaction` helper that performs a **hard DELETE** on the `transactions` row (with `sms_queue` cascading via FK). That ship sailed (PR #32, merged 2026-04-25). Story 4.5's BDD line 877 is **explicit** that the undo MUST be **event-sourced** (*"inserts a compensating event, not a hard delete"*) — the current implementation violates that contract. Story 4.5 **rewrites the undo path** to a soft-undo pattern that preserves the original transaction row, marks it undone, transitions the queued `sms_queue` row to `abandoned`, and emits a typed `transaction.undone` audit event. The hard-DELETE path is retired (consumers and the FK cascade are updated accordingly). Story 4.4's rattrapage path inherits the new undo for free (same `undoTransaction` helper). The BDD's "*redirect to member profile's transaction-edit flow*" after 5 s is forward-looking — at MVP the toast simply auto-dismisses (Story 4.3 behaviour); a transaction-edit flow has no FR yet and no story owner.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md` lines 873-882; the rest are spec-derived constraints.

1. **Soft-undo schema.** New migration `20260426000003_add_undone_at_to_transactions.sql`:
   - `ALTER TABLE public.transactions ADD COLUMN undone_at timestamptz NULL;`
   - `ALTER TABLE public.transactions ADD COLUMN undone_event_id uuid NULL;` (the `audit_log.event_id` of the `transaction.undone` event — set in the same RPC body for traceability).
   - **No CHECK constraint** linking `undone_event_id` to `audit_log.event_id`: cross-table CHECKs are not idiomatic in Postgres; the RPC enforces consistency at the application layer (defence-in-depth via the contract test).
   - **No index on `undone_at`**: queries always filter by `(member_id, undone_at IS NULL)` which is covered by the existing `(member_id)` index — adding a partial index would be premature.
   - Backfill: existing rows have `undone_at = NULL` (default for new column). Story 4.3's hard-DELETEd rows are GONE — they don't migrate. The audit chain already captured `transaction.deleted` for them; no retroactive surgery.

2. **Drop the FK CASCADE.** Same migration alters `sms_queue.transaction_id` to `ON DELETE SET NULL` (or remove the cascade entirely — keep `ON DELETE SET NULL` to allow lookup for any future audit/forensic queries):
   - `ALTER TABLE public.sms_queue DROP CONSTRAINT sms_queue_transaction_id_fkey;`
   - `ALTER TABLE public.sms_queue ADD CONSTRAINT sms_queue_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE SET NULL;`
   - **Why:** Story 4.5 stops DELETEing transactions on undo. The cascade is no longer needed and could mask a bug if a future code path DELETEs by mistake. `ON DELETE SET NULL` keeps the cascade semantically meaningful (orphan SMS rows don't break) without silently nuking SMS history.
   - Compatible with sms_queue's status-driven worker drain: the worker queries `WHERE status = 'queued'` and ignores `transaction_id` for delivery — the `transaction_id` column is for traceability only.

3. **`undo_transaction` RPC.** New migration `20260426000004_undo_transaction.sql` defines `public.undo_transaction(p_transaction_id uuid)` returning `void`:
   - SECURITY DEFINER + `set search_path = public, pg_temp`.
   - Validates `auth.uid()` non-null → `28000` if absent.
   - Reads the target transaction (`SELECT collector_id, undone_at, created_at FROM transactions WHERE id = p_transaction_id`).
   - **Not-found:** `P0002`.
   - **Foreign collector:** `28000`.
   - **Already undone (`undone_at IS NOT NULL`):** `0L000` (idempotent — raises a typed error so the client can ignore gracefully if the user double-taps Annuler).
   - **Window-expired (`now() - created_at > interval '5 seconds'`):** `22023` (out-of-range / window violation). The window is enforced server-side as defence-in-depth — the toast already hides Annuler at T-0, but a tampered client cannot extend the window.
   - **Atomic update + sms_queue cancel + audit emit, in order:**
     1. `UPDATE transactions SET undone_at = now() WHERE id = p_transaction_id` — fires the audit trigger which now emits `transaction.undone` (per AC #4).
     2. `UPDATE sms_queue SET status = 'abandoned' WHERE transaction_id = p_transaction_id AND status = 'queued'` — only `queued` rows are cancelled; if the worker has already moved the row to `sent`/`delivered`, the SMS has already left the building and abandonment is moot (the saver received the receipt — undo just rolls back the DB state, not reality).
     3. The audit trigger (Story 1.2 + this story's AC #4 patch) emits `transaction.undone` automatically. The RPC reads back `event_id` from `audit_log` and writes it to `transactions.undone_event_id` for traceability.
   - GRANT EXECUTE TO authenticated.
   - Comment cites BDD lines 873-882 + Story 4.3 (the hard-DELETE this rewrites) + Story 1.2 (the audit trigger).

4. **Audit trigger patch — typed `transaction.undone` event.** Edit `supabase/migrations/20260419000007_triggers_audit.sql`'s `audit_emit()` function (or ship a small migration that `CREATE OR REPLACE`s the function — preferred to keep the original migration immutable). The new migration is `20260426000005_audit_emit_transaction_undone.sql`:
   - Detect the undo pattern: `v_entity_table = 'transactions' AND v_op = 'UPDATE' AND OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL` → emit `transaction.undone` (instead of generic `transaction.updated`).
   - Mirror the `cycle.settled` precedent (audit_emit lines 157-159) — same status-transition pattern.
   - All other UPDATE paths (e.g., `set_updated_at` trigger updates) keep emitting `transaction.updated`.
   - Coverage in the contract test (AC #11): the typed `transaction.undone` event lands; a generic UPDATE on a non-undone column still emits `transaction.updated`.

5. **`transactions_decrypted` view excludes undone rows.** Edit `supabase/migrations/20260419000005_vault_setup.sql`'s view via a `CREATE OR REPLACE` migration `20260426000006_transactions_decrypted_excludes_undone.sql`:
   - Add `WHERE t.undone_at IS NULL` to the view's `FROM` clause.
   - **Effect:** undone transactions disappear from the member-profile transaction list (Story 2.4) and from any future read that goes through the decrypted view. The `transactions` table itself still has the row — auditors can query it directly.
   - **Why a view filter, not a row delete:** the audit chain depends on the row's `id` continuing to exist (the audit_log payload references `entity_id`). Hard DELETE would orphan the audit references; soft-undo + view-filter preserves the chain.
   - The `useMembers` query (Story 2.1) reads `transactions.created_at` for recency sort — it queries the raw `transactions` table, not the view (line 111 of `useMembers.ts`). AC #6 patches that query.

6. **`useMembers` recency sort excludes undone rows.** Edit `src/features/member/api/useMembers.ts`:
   - The `transactionsResult` query at line 111 (`supabase.from("transactions").select("member_id, created_at")`) needs `.is("undone_at", null)` filter.
   - Without this, an undone transaction's `created_at` would still bump the member to the top of the list — semantically wrong; the user just cancelled the action that put them there.
   - The existing `transactionTimestampSchema` (line 49 of `types.ts`) doesn't include `undone_at` — no schema change needed; we just filter at the query level.
   - 1 new test in `useMembers.test.ts` covering the filter behaviour.

7. **Refactor `undoTransaction` to call the RPC.** Edit `src/features/transaction/api/undoTransaction.ts`:
   - Replace the `supabase.from("transactions").delete()` call with `supabase.rpc("undo_transaction", { p_transaction_id: transactionId })`.
   - On error: throw with a typed code like Story 4.3's `RecordContributionError`. New file `src/features/transaction/api/undoTransactionError.ts` defining `UndoTransactionError` + `classifyUndoError()`. Error codes: `unauthorized | not_found | window_expired | already_undone | network | unknown`.
   - On success: the existing `queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY })` stays (recency sort regresses).
   - **Backwards compat:** the helper's signature `undoTransaction(transactionId, queryClient): Promise<void>` is unchanged; only the implementation swaps.
   - 4-6 new test cases covering the error classifier paths.

8. **Toast undo behaviour.** No change to `showContributionToast.ts` / `showRattrapageToast.ts` (Story 4.4) — the toast already calls `onUndo` only within the 5-second window because:
   - The countdown timer dismisses the toast at T-0 (line 51-55 of `showContributionToast.ts`).
   - The `Annuler` button only renders when `state.kind === "just-committed"` (line 65 of `ProgressiveToast.tsx`).
   - **However:** add a `try/catch` around the `onUndo()` callback so a server-side `window_expired` error (from a slow client clock or network jitter) shows a `toast.error()` with `t("transaction.error.undo_window_expired")` instead of crashing silently. The MemberList wiring (AC #9) is the catch site.

9. **MemberList error handling.** Edit `src/features/member/ui/MemberList.tsx`:
   - The current `onUndo: () => { void undoTransaction(txId, queryClient); }` swallows errors silently. Replace with:
     ```ts
     onUndo: async () => {
       try {
         await undoTransaction(txId, queryClient);
       } catch (err) {
         if (err instanceof UndoTransactionError) {
           toast.error(t(`transaction.error.${err.code}`));
         } else {
           toast.error(t("transaction.error.unknown"));
         }
       }
     }
     ```
   - Apply the same wrap to the rattrapage handler (Story 4.4's `onRattrapage` will land via PR #34's follow-up feat work — at the time 4.5 dev starts, 4.4's spec PR is merged and the feat work is either parallel or pending; the wire-in for rattrapage's onUndo applies to whatever surface exists when 4.5 lands).
   - **Mock the toast helpers** in the existing `MemberList.test.tsx` (already done in Story 4.3); add 1 new test case covering the `window_expired` toast path.

10. **i18n keys.** Add to `src/i18n/fr.json`:
    - `transaction.error.window_expired` = `"Délai dépassé — la cotisation est conservée. Modifiez-la depuis le profil du membre."`
    - `transaction.error.already_undone` = `"Cotisation déjà annulée."`
    - `transaction.error.undo_window_expired` is an alias of `window_expired` — keep ONE key (`transaction.error.window_expired`) and reuse it; the AC #8 catch site uses this same key.
    - **Note:** existing `transaction.error.{unauthorized,validation,network,unknown,cycle_closed,not_found}` keys (Story 4.3) cover the rest. The `not_found` key is reused if the RPC returns `P0002` for a transaction that the soft-undo machinery can't locate (rare; RLS-protected).

11. **Tests — DB contract (Deno).** New `supabase/functions/_shared/undo-transaction.contract.test.ts`. Cases:
    - **Happy path:** insert via `record_contribution`, immediately call `undo_transaction` → row's `undone_at` is set, `sms_queue` row's status flipped from `queued` to `abandoned`, audit chain has both `transaction.committed` AND `transaction.undone` events with consistent `prev_hash` chaining, `transactions_decrypted` view no longer returns the row, raw `transactions` table still has it.
    - **Window expired:** insert via RPC, advance the system clock by `interval '6 seconds'` (use `pg_sleep(6)` OR set `created_at` directly via service role), call `undo_transaction` → `22023`.
    - **Already undone (idempotent guard):** call `undo_transaction` twice → first succeeds, second returns `0L000`.
    - **Foreign collector:** another collector tries to undo → `28000`.
    - **Not found:** random uuid → `P0002`.
    - **`sms_queue` already dispatched:** insert via RPC, manually flip the queued sms_queue row to `sent` (service role), undo → transaction is undone but the sms_queue row stays in `sent` status (the SMS already left). Verify with assertions.
    - **`transaction.undone` event type:** assert the audit_log row for the UPDATE has `event_type = 'transaction.undone'` (not `transaction.updated`).
    - Add the new path to `scripts/run-edge-tests.sh`.

12. **Tests — view filter contract.** Add to `undo-transaction.contract.test.ts` (or a sibling file): seed 2 transactions, undo one, query `transactions_decrypted` → only the non-undone row returned. Query the raw `transactions` table → both rows. This validates AC #5.

13. **Tests — vitest hook + helper.**
    - `undoTransaction.test.ts` (existing — Story 4.3 wrote it via `tests/api/undoTransaction.test.ts` if any; if not, create). Cover:
      - Happy path → RPC called with `{ p_transaction_id }`, query invalidates, returns void.
      - Each error code path (5 codes) → throws `UndoTransactionError` with the right `code`.
    - The classifier function (`classifyUndoError`) is exported from `undoTransactionError.ts` and tested directly with PostgrestError-shaped inputs.

14. **Tests — MemberList error handling.** Edit `src/features/member/ui/MemberList.test.tsx`:
    - 1 new case: `useRecordContribution` mocks happy path, `undoTransaction` mock rejects with `new UndoTransactionError("window_expired", "...")`, tap Annuler, `toast.error` is called with `t("transaction.error.window_expired")`.

15. **Tests — useMembers filter.** Edit `src/features/member/api/useMembers.test.ts`:
    - Stub `supabase.from("transactions").select(...).is(...)` to verify the `.is("undone_at", null)` filter is included.
    - Or test the pure transform with raw rows that DO NOT include undone ones (since the filter is applied at the query layer) and assert recency sort is correct.

16. **Tests — E2E.** Edit `tests/e2e/flow-1-record-contribution.spec.ts` (the existing spec from Story 4.3) to add an undo step:
    - Existing happy path: tap card → action sheet → primary CTA → ProgressiveToast appears.
    - **NEW:** within 1 s, tap Annuler → toast disappears → service-role assertion: `transactions` row's `undone_at IS NOT NULL`, `sms_queue` row's status = `abandoned`, audit_log has `transaction.undone` row.
    - Member list assertion: the member's `latestInteractionAt` reverts to the pre-contribution timestamp (no longer at the top of the recency list — verify by seeding 2 members and asserting list order).
    - **DO NOT** assert the post-5s "redirect" behaviour — it's a forward-looking BDD line with no shipped flow. Document the gap in Dev Notes.
    - Run LOCALLY before push.

17. **No new dependencies.** All work is SQL + existing TanStack Query / Supabase JS / sonner. No npm install.

18. **Backwards compat with Story 4.3 `audit_log` rows.** Existing `transaction.deleted` events from Story 4.3's hard-DELETEs stay in the audit chain — they're historical truth and remain valid. The new `transaction.undone` event is for transactions undone after Story 4.5 lands. Both event types co-exist in the chain.

19. **Forward-looking BDD line — out of scope.** BDD line 880-882 (*"5 seconds elapse → action is unavailable AND the UI redirects the collector to the member profile's transaction-edit flow"*) describes a transaction-edit flow that has **no FR**, no UX flow, no architecture file slot, and no story owner at MVP. Story 4.5 satisfies the "action is unavailable" half (the toast auto-dismisses at T-0, so there's no Annuler button to tap). The "redirect" half is **explicitly deferred**. Document in Dev Notes for the eventual Story 9.x or Growth-phase feature that would ship a per-transaction edit flow (akin to Story 2.5's member-edit but per-row in the transaction history).

20. **All gates green.**
    - `npm run db:migrate` — applies 4 new migrations (`add_undone_at`, `undo_transaction` RPC, `audit_emit_transaction_undone`, `transactions_decrypted_excludes_undone`).
    - `npm run db:types` — regenerates `database.types.ts` so the new RPC + `undone_at` column are typed.
    - `npm run typecheck` / `npm run lint` / `npm test -- --coverage` / `npm run test:edge` / `npm run build` — all green.
    - `npx playwright test` — full suite green LOCALLY before push (Story 2.5 retro). 1 spec extended.
    - Coverage: domain still 100 %; new files ≥ 80 %.

## Tasks / Subtasks

- [ ] **Task 0 — Schema migration (AC #1 #2).** Create `20260426000003_add_undone_at_to_transactions.sql`. Adds `undone_at` + `undone_event_id` columns; flips `sms_queue.transaction_id` FK from `ON DELETE CASCADE` to `ON DELETE SET NULL`. Apply via `npm run db:migrate`.

- [ ] **Task 1 — `undo_transaction` RPC (AC #3).** Create `20260426000004_undo_transaction.sql`. SECURITY DEFINER, validates ownership + 5-s window + idempotency. Atomic UPDATE + sms_queue cancel + audit-event lookup. Returns void.

- [ ] **Task 2 — Audit trigger patch (AC #4).** Create `20260426000005_audit_emit_transaction_undone.sql`. `CREATE OR REPLACE` of `audit_emit()` with the new branch detecting `OLD.undone_at IS NULL AND NEW.undone_at IS NOT NULL` → `transaction.undone`.

- [ ] **Task 3 — View filter (AC #5).** Create `20260426000006_transactions_decrypted_excludes_undone.sql`. `CREATE OR REPLACE VIEW transactions_decrypted` with `WHERE t.undone_at IS NULL`.

- [ ] **Task 4 — Regenerate types.** `npm run db:types`.

- [ ] **Task 5 — `useMembers` filter (AC #6).** Edit `src/features/member/api/useMembers.ts` to add `.is("undone_at", null)` to the transactions query. Add 1 new test case.

- [ ] **Task 6 — `undoTransaction` rewrite + error class (AC #7).** Edit `src/features/transaction/api/undoTransaction.ts`. Create `undoTransactionError.ts` with `UndoTransactionError` + `classifyUndoError`. 5+ test cases.

- [ ] **Task 7 — MemberList error handling (AC #9 #14).** Edit `MemberList.tsx` to wrap `onUndo` in try/catch + `toast.error` mapping. Add 1 new test case.

- [ ] **Task 8 — i18n (AC #10).** Add 2 keys to `fr.json`.

- [ ] **Task 9 — Edge contract test (AC #11 #12).** Create `supabase/functions/_shared/undo-transaction.contract.test.ts`. ≥ 7 cases. Add path to `scripts/run-edge-tests.sh`.

- [ ] **Task 10 — E2E extension (AC #16).** Edit `tests/e2e/flow-1-record-contribution.spec.ts` to add the undo step. Run LOCALLY.

- [ ] **Task 11 — All gates (AC #20).** `db:migrate` / `db:types` / `typecheck` / `lint` / `test --coverage` / `test:edge` / `build` / `npx playwright test`.

- [ ] **Task 12 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `4-5-undo-transaction-window: ready-for-dev → review`.
  - Confirm Story 4.4's onUndo wiring (when feat lands) uses the same `undoTransaction` helper unchanged — Story 4.5 owns the helper's contract.

## Dev Notes

### Architecture compliance

- **Layering.** SQL migrations + RPC at the data layer → typed error class in `features/transaction/api/` → existing `MemberList.tsx` consumer. No `domain/` changes (the undo logic is purely operational, not domain math). No `infrastructure/` changes.
- **Cite sources.** Each new migration / file header cites BDD lines 873-882 + FR22 + Story 4.3 (the rewrite target) + Story 1.2 (the audit trigger).
- **Defence-in-depth on the 5-s window.** The toast hides Annuler at T-0 (client) AND the RPC raises `22023` past 5 s (server). Both layers cooperate.
- **Audit chain integrity.** Soft-undo + view-filter preserves the chain. The `transactions.id` survives, the audit_log row references it via `entity_id`, and the chain's hash continuity is unbroken. Hard-DELETE would have orphaned the chain references — Story 4.3's choice was technically a chain-integrity violation that this story fixes.

### Why soft-undo (not the offline event-log)

The architecture file (`architecture.md:367-371`) describes the offline sync layer's event-sourced design. **That layer is for offline reconciliation** — a separate concern owned by Epic 8. Story 4.5's online undo doesn't need to write to the IndexedDB event log; it's a synchronous server-side state transition. The "event-sourced" language in the BDD refers to the **audit_log** chain, not the offline event log. The audit_log already has `transaction.committed` events; we add `transaction.undone` events. That's the compensating-event pattern at the audit layer.

### Why rewrite Story 4.3's hard-DELETE instead of leaving it alone

The BDD is explicit: *"inserts a compensating event, not a hard delete"*. Story 4.3's choice was a knowing shortcut (Story 4.3's Dev Notes admits "audit chain captures both events" — true but the chain references a row that no longer exists). Story 4.5 closes the gap with the canonical pattern. The cost is 4 small migrations + a helper rewrite; the benefit is auditor-defensible chain integrity (NFR-S6 compliance).

### Why drop the `sms_queue` FK CASCADE

Two reasons:
1. Story 4.5 stops DELETEing transactions, so the cascade is dead code. Dead code is risk surface — a future bug that DELETEs a transaction would silently delete the SMS row too, hiding the bug.
2. The `ON DELETE SET NULL` form keeps cascade semantics meaningful (orphan SMS rows preserve their content for forensics) while allowing the soft-undo path to mark `status='abandoned'` cleanly without DB-level cascading side effects.

### Why a typed `transaction.undone` event (not generic `transaction.updated`)

Auditors querying the chain need a stable taxonomy. Mixing undo events with arbitrary updates (e.g., a future `set_updated_at` bump) would force every consumer to inspect the payload diff to distinguish them. Following the `cycle.settled` precedent (line 157-159 of audit_emit), Story 4.5 promotes the undo pattern to a typed event. The architecture's naming convention (`{entity}.{action}` past-tense, lowercase) is preserved.

### Why `now() - created_at > 5 seconds` (not `now() - created_at >= 5 seconds`)

The toast's countdown hits 0 at exactly the 5-s mark and dismisses. A user who taps Annuler right at T-0 may have a network round-trip that lands the RPC call at T+0.2s — strict-greater allows that within tolerance. If we used `>=`, a clock-skewed client could fail validly-tapped undos. The 5-s window is a UX promise; the server is generous on the boundary.

### Story 4.4 + Story 4.5 ordering

If Story 4.4's feat work lands BEFORE Story 4.5's feat work:
- Story 4.4 ships `showRattrapageToast` which calls `onUndo: () => undoTransaction(txId, queryClient)`.
- Story 4.5 then rewrites `undoTransaction` — **no changes** to the rattrapage call site needed because the helper's signature is preserved.

If Story 4.5's feat work lands BEFORE Story 4.4's:
- Story 4.5 rewrites `undoTransaction` for the contribution path.
- Story 4.4 inherits the new soft-undo for free.

Either order works. The two stories are spec-independent.

### Anti-patterns (do NOT do)

- **Do NOT** keep the hard-DELETE path. The whole point of Story 4.5 is to retire it.
- **Do NOT** keep the FK CASCADE. Drop it (or convert to `SET NULL`).
- **Do NOT** add a `transaction_undos` table. The `undone_at` column is sufficient; a separate table would duplicate audit_log without benefit.
- **Do NOT** filter undone rows at the application layer when the view filters them naturally. Single source of truth = the view.
- **Do NOT** ship the transaction-edit redirect (BDD line 880-882). It has no spec, no FR, no UX flow.
- **Do NOT** make the 5-s window configurable via env. It's a UX promise, not a tuning knob.
- **Do NOT** issue `transaction.undone` from the RPC manually if the audit trigger does it automatically — that would emit two events. The trigger's typed-branch is the single emit point.
- **Do NOT** allow the undo to succeed if `undone_at IS NOT NULL` already (idempotent guard via `0L000`). Allowing it would re-emit `transaction.undone` for the same transaction.

### Edge cases worth testing (covered by Task 9)

- **Window boundary at 5.000 s.** Server uses `>` not `>=`, so a 5.000 s tap succeeds; a 5.001 s tap fails.
- **Concurrent undo by two clients.** RLS-isolated; collectors can't undo each other's txs. Same collector double-tap → one succeeds, second hits `0L000`.
- **SMS already sent.** Worker drained the queue before undo. `sms_queue` row status is `sent` — UPDATE filter `WHERE status = 'queued'` doesn't touch it. Transaction still goes to `undone_at`. **Forensic record:** the SMS was sent with the original (now undone) amount; saver may be confused. **Mitigation:** out-of-scope for MVP — collector handles the conversation manually. Document.
- **Transactions hard-DELETEd by Story 4.3 prior to 4.5 landing.** Their `transaction.deleted` events are historical. Story 4.5 doesn't backfill or revert — it only governs new transactions.
- **Server clock skew.** If the DB clock drifts, the 5-s window is wrong. Acceptable: collectors typically have synced devices, and the server time is the canonical truth. No client-side compensation needed.
- **Idempotent client retry.** Network blip → client re-tries the RPC. First call succeeded (sets `undone_at`), retry hits `0L000`. The MemberList wrapper translates `already_undone` to a no-op user-facing toast (or silent — design choice; AC #10 ships the i18n key for visibility).

### Definition-of-done checklist

- All 20 ACs satisfied + all 13 tasks ticked.
- 4 migrations applied via `npm run db:migrate`.
- `npm run db:types` regenerated.
- 7+ Deno contract tests pass.
- `useMembers` query filters undone rows; transactions_decrypted view filters undone rows.
- `undoTransaction` calls the RPC and throws typed errors.
- MemberList wraps `onUndo` in try/catch + toast.error.
- 2 new i18n keys.
- Playwright spec extended with the undo step + assertions; runs locally.
- All gates green.
- Story status set to `review`; sprint-status updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 866-882 (Story 4.5 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` (FR22 — undo support; the BDD references "edit-and-audit flow" which is forward-looking).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md:572` (`transaction.committed` event in the audit taxonomy — the new `transaction.undone` joins the same family).
  - `_bmad-output/planning-artifacts/architecture.md:367-371` (offline event log — explicitly NOT what this story is about).
  - `_bmad-output/planning-artifacts/architecture.md:1105` (NFR-S6 hash-chained audit — the contract this story upholds).
- **UX spec:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md:476` (5-s undo window UX rationale).
  - `_bmad-output/planning-artifacts/ux-design-specification.md:1081` (toast progression: 0–5 s undoable window).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql:131-150` (transactions table).
  - `supabase/migrations/20260419000001_init_schema.sql:154-176` (sms_queue table — FK to be altered).
  - `supabase/migrations/20260419000005_vault_setup.sql:177-198` (transactions_decrypted view).
  - `supabase/migrations/20260419000007_triggers_audit.sql:98-230` (audit_emit function).
- **Companion stories:**
  - Story 4.3 — the hard-DELETE undo this rewrites; the `showContributionToast` + 5-s timer pattern.
  - Story 4.4 — rattrapage path inherits the new undo for free.
  - Story 1.2 — the audit trigger this story patches.
  - Story 3.4 — `isCycleClosedForTransactions` (not directly used here, but the BEFORE INSERT trigger pattern is a precedent for cross-table integrity in PG).
- **Existing patterns to mirror:**
  - `audit_emit` cycle.settled branch (lines 157-159) — same status-transition detection idea.
  - `record_contribution` RPC (Story 4.3, migration 0023) — same SECURITY DEFINER + typed errors structure.
  - `record-contribution.contract.test.ts` — Deno contract test template.
- **Process discipline:** Run Playwright LOCALLY (Story 2.5 retro). Use `npm run db:migrate` (CLAUDE.md).

## Dev Agent Record

### Agent Model Used

(filled in by dev agent at implementation time)

### Debug Log References

### Completion Notes List

### File List

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-26 | Winston (architect) | Story 4.5 spec generated by `bmad-create-story`. Closes Epic 4 by **rewriting** Story 4.3's hard-DELETE undo to a soft-undo pattern faithful to the BDD: adds `transactions.undone_at` + `undone_event_id` columns, drops the `sms_queue` FK CASCADE in favour of `ON DELETE SET NULL`, ships an `undo_transaction` SECURITY DEFINER RPC with a server-side 5-s window guard, patches the audit trigger to emit a typed `transaction.undone` event for the undo UPDATE pattern, filters undone rows from the `transactions_decrypted` view + the `useMembers` recency query, and wraps `onUndo` in `MemberList.tsx` with typed-error toast handling. The post-5-s "redirect to transaction-edit flow" half of the BDD is explicitly deferred (no FR, no UX flow, no story owner). Story 4.4's rattrapage path inherits the new undo for free. Status → ready-for-dev. |
