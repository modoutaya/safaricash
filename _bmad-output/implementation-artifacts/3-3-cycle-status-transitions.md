# Story 3.3: Automatic cycle status transitions (active / with-advance)

Status: review

## Story

As a **collector**,
I want **a member's cycle status to transition automatically between *active* and *with-advance***,
so that **the status badge always reflects reality without manual updates (FR18 partial — settled transition in Epic 7).**

> **Predicate of this story.** Story 3.2 (cycle engine) shipped the pure math; Story 3.3 wires the **status-transition side-effect** at the database layer so any caller writing an advance into `transactions` automatically promotes the cycle's status. No application code knows about the transition — it's a Postgres invariant.

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` lines 749-757; the rest are spec-derived constraints required for a flawless implementation.

1. **Forward transition.** **Given** a member with cycle status `active`, **When** an advance is recorded for that member (i.e., `INSERT INTO transactions (..., kind='advance', ...)`), **Then** the corresponding `cycles.status` row transitions to `with_advance` **atomically** (in the same Postgres transaction as the INSERT).

2. **Audit event — `cycle.transitioned`.** **And** a `cycle.transitioned` event records the new status in `audit_log` (BDD line 754). This is a NEW event type — the architecture's event-naming table (`architecture.md:570`) does not yet list it. Story 3.3 introduces it. The CHECK constraint on `audit_log.event_type` (`'^[a-z][a-z_]*\\.[a-z][a-z_]*$'`, migration 0003) accepts it without modification.

3. **Reverse transition (deferred).** **Given** a member with status `with_advance`, **When** all outstanding advances are reconciled — **not expected in MVP**, **Then** the status reverts to `active` (BDD line 757: "reserved behaviour, not MVP-required"). Story 3.3 does **NOT** implement the reverse transition. The trigger is forward-only; the absence of a reverse path is documented in the migration comments + this story's Dev Notes for the eventual Story 3.x or Epic 10 owner.

4. **Idempotency.** Subsequent advance INSERTs on a member whose cycle is **already** `with_advance` MUST NOT fire a second `cycle.transitioned` event. The trigger's `WHERE status = 'active'` filter is the gate — when the row's status is already `with_advance`, the UPDATE affects 0 rows, the audit trigger does not fire.

5. **No false positives.** `INSERT INTO transactions (..., kind='contribution'/'rattrapage', ...)` MUST NOT touch `cycles.status`. Only `kind='advance'` triggers the promotion.

6. **No transition on completed/settled cycles.** If the member's cycle is `completed` or `settled`, an advance INSERT MUST NOT silently demote the status. The trigger's `WHERE status = 'active'` filter naturally protects against this. (Story 3.4 will reject such INSERTs at the contribution boundary; this story's defense-in-depth is the WHERE clause.)

7. **Concurrency safety.** Two concurrent advance INSERTs on the same member MUST NOT race the status update. The Postgres row-level lock on `cycles` (held by the UPDATE) serialises the second writer; whichever runs first does the transition + audit, the second is a no-op (per AC #4). No advisory lock needed at this layer.

8. **Atomic transaction.** The advance INSERT and the cycle UPDATE both belong to the same Postgres transaction. If either fails (e.g., RLS blocks the cycle UPDATE), the entire transaction rolls back — no orphan advance row, no orphan cycle.status flip.

9. **Trigger location.** A new function `public.promote_cycle_on_advance()` lives in migration `20260424...` and is attached as `AFTER INSERT FOR EACH ROW` on `public.transactions`. SECURITY DEFINER + `set search_path = public, pg_temp` (mirrors the audit trigger pattern). GRANTs unchanged — direct trigger invocation is locked down by Postgres semantics.

10. **Audit trigger taxonomy update.** Migration `20260424000002...` REPLACEs `public.audit_emit()` with a new CASE branch for `cycle.transitioned`:
    ```sql
    when v_entity_table = 'cycles' and v_op = 'UPDATE'
         and (v_payload->>'status') is distinct from (to_jsonb(old)->>'status')
         and (v_payload->>'status') <> 'settled'   -- 'cycle.settled' has its own branch above
         then 'cycle.transitioned'
    ```
    Inserted **between** the existing `cycle.settled` case and the catch-all `cycle.updated` case so `settled` transitions still get their dedicated event. Hash chain unchanged — the new event type slots into the canonical serialiser without disturbing existing rows.

11. **No frontend changes.** Story 2.7 already widened `useMembers.pickCurrentCycle` and `useMemberProfile.pickCurrentCycle` to handle `with_advance`. `StatusBadge` and `deriveMemberStatus` already render the "avance" chip. Once the trigger lands, the existing UI updates automatically on the next refetch (TanStack Query's `MEMBER_PROFILE_QUERY_KEY` invalidation happens in Story 4.x's transaction-capture flow).

12. **DB contract test.** A new `supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts` (Deno) runs against the local Supabase. Asserts:
    - Insert advance on `active` cycle → cycle becomes `with_advance` + 1 `cycle.transitioned` audit row exists with `actor` = the JWT-resolved collector.
    - Insert second advance on the same (now `with_advance`) cycle → no second `cycle.transitioned` audit row (idempotency).
    - Insert contribution on `active` cycle → status stays `active`, no audit `cycle.transitioned`.
    - Insert advance on a manually-completed cycle (force `cycles.status = completed` via service-role) → status stays `completed`, no audit `cycle.transitioned`.
    Mirrors the pattern from `supabase/functions/_shared/create-member-with-cycle.contract.test.ts`.

13. **Updated_at maintained.** The cycle UPDATE explicitly sets `updated_at = now()`. The existing `set_updated_at_cycles` trigger (migration 0001 line 123) also sets it — but defense-in-depth keeps the explicit assignment in the trigger function so a future trigger refactor doesn't silently lose the bump.

## Tasks / Subtasks

- [ ] **Task 0 — Migration A: extend `audit_emit()` (AC #2 #10).** Create `supabase/migrations/20260424000001_audit_emit_cycle_transitioned.sql`:
  - REPLACEs `public.audit_emit()` with the new `cycle.transitioned` CASE branch inserted between `cycle.settled` and the catch-all `cycle.updated`.
  - Mirrors migration 0017's structure (Story 2.5's actor JWT fix) — copy the entire function body, only changing the CASE block.
  - Comment notes Story 3.3 ownership of the new event type.

- [ ] **Task 1 — Migration B: `promote_cycle_on_advance` trigger (AC #1 #4 #5 #6 #9 #13).** Create `supabase/migrations/20260424000002_promote_cycle_on_advance.sql`:
  - SECURITY DEFINER function `public.promote_cycle_on_advance()`.
  - AFTER INSERT trigger on `public.transactions FOR EACH ROW`.
  - Inside: `if NEW.kind = 'advance' then UPDATE cycles SET status='with_advance', updated_at=now() WHERE id = NEW.cycle_id AND status = 'active'; end if;`
  - Returns `null` (AFTER trigger).
  - Comment cites ADR-004 + Story 3.3 + the FR18 partial scope.
  - Run `npm run db:migrate` (preserve manually-seeded data).

- [ ] **Task 2 — DB contract test (AC #12).** Create `supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts`:
  - Mirror `create-member-with-cycle.contract.test.ts`'s structure (envOrSkip + seedCollector helper + SupabaseClient).
  - 4 assertions per AC #12: forward transition + audit event + idempotency + contribution no-op + completed-cycle no-op.
  - Run via `npm run test:edge`.

- [ ] **Task 3 — Update event-taxonomy doc (AC #2 — discoverability).** Update `_bmad-output/planning-artifacts/architecture.md:570` table to add `cycle.transitioned`. **Optional** — the architecture doc is owned by Winston (architect persona); if you don't want to touch it directly, capture the addition as a deferred-work entry in `deferred-work.md`. Either path is acceptable.

- [ ] **Task 4 — Regression sweep.**
  - `npm run typecheck` (no TS changes expected; sanity check).
  - `npm test` — confirm 413 vitest still passes (the trigger doesn't touch app code).
  - `npm run test:edge` — confirm both the existing contract tests AND the new one pass.
  - `npm run build` — confirm.

- [ ] **Task 5 — LOCAL Playwright sanity (AC #11).** Run `npx playwright test`. The existing 18 specs touch `with_advance` indirectly (e.g., flow-member-list.spec.ts asserts the "Avance" chip filter). Verify zero regression.

- [ ] **Task 6 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `3-3-status-transitions: in-progress` → `review`.
  - Document the deferred reverse-transition in the story file (link to BDD line 757).

## Dev Notes

### Architecture compliance

- **Layering.** DB-only story. Zero `src/` changes (per AC #11, the existing UI already handles `with_advance`).
- **No new dependencies.** Just SQL + a Deno test.
- **Event taxonomy.** New event `cycle.transitioned` introduced. The CHECK constraint on `audit_log.event_type` (migration 0003) accepts it without modification. The architecture doc's event table at line 570 should be updated for discoverability (Task 3).
- **Cite sources.** Migration headers cite epics.md lines 749-757, FR18 (PRD line 498), and ADR-004 § Status transitions (which this story complements without overlapping — the ADR owns the projected balance + commission invariants; this story owns the cycle-state machine for the active↔with_advance arc).

### Why a trigger, not an application RPC

- **Atomicity.** The advance INSERT and the cycle UPDATE belong to the same transaction. A trigger gives this for free. An RPC would either need explicit `BEGIN/COMMIT` or trust the caller to wrap both writes — fragile.
- **Bypass-resistance.** Story 4.x's transaction-capture RPC could be the only legitimate writer; but a future story (e.g., bulk-import-with-advances, or a settlement-rewind that re-inserts advances) might write directly to `transactions`. The trigger ensures the invariant holds regardless of caller.
- **Single source of truth.** The status-transition rule lives in ONE place (the trigger function), not duplicated across N RPCs.

### Why no advisory lock here

The audit trigger uses `pg_advisory_xact_lock(0x5AFA, hashtext(collector_id))` to serialise hash-chain writes per collector. The status-transition trigger does NOT need its own lock because:
- The UPDATE on `cycles WHERE id = NEW.cycle_id AND status = 'active'` takes a row-level write lock on the cycle.
- Postgres serialises concurrent UPDATEs on the same row automatically.
- The second advance INSERT (against an already-`with_advance` cycle) sees `status = 'with_advance'`, the WHERE clause excludes it, the UPDATE affects 0 rows, the audit trigger does not fire — perfect idempotency.

If a future invariant requires reading `transactions` aggregates inside the trigger (e.g., "demote to active if Σadvances == 0"), then advisory locking becomes necessary to avoid phantom reads. The reverse transition (AC #3) is deferred precisely to keep this story scoped tight.

### Why the event taxonomy gets a NEW event, not `cycle.updated`

- **Discoverability.** A future analytics query like "how many cycles have ever entered with_advance state?" is one filter on `event_type = 'cycle.transitioned'` vs a fragile JSON-payload diff on `cycle.updated`.
- **BDD compliance.** Story 3.3 BDD line 754 explicitly names the event `cycle.transitioned`. Implementing it as `cycle.updated` would silently break the spec.
- **Hash chain integrity.** The new event type slots into the existing canonical serialiser (`audit_emit()`) without changing the hash inputs — only the `event_type` text differs. Existing audit rows remain valid; new rows compute correctly.

### The reverse transition (deferred)

Per BDD line 757: *"Given a member with status with_advance, When all outstanding advances are reconciled (e.g., overturned by dispute) — not expected in MVP, Then the status reverts to active (reserved behaviour, not MVP-required)."*

When this lands (likely Epic 10 or a Story 3.x amendment), it'll be a **second trigger**: AFTER UPDATE/DELETE on `transactions` checking if Σ(remaining advances on this cycle) === 0 → demote. The current `promote_cycle_on_advance` trigger does NOT need to change. Document this trajectory in the migration comment so the next dev doesn't re-architect.

### Anti-patterns (do NOT do)

- **Do NOT update `cycles.status` from application code** (Story 4.x's transaction-capture RPC). The trigger owns this invariant. Doing it twice is a race waiting to happen.
- **Do NOT add a `cycle_id IS NOT NULL` check** in the trigger — the schema already enforces NOT NULL on `transactions.cycle_id` (migration 0001 line 135).
- **Do NOT touch `cycles.status` for `kind='contribution'` or `kind='rattrapage'`** — that's Story 3.4's territory (reject contributions on completed cycles via 409 Conflict, not via silent state mutation).
- **Do NOT implement the reverse transition** in this story. BDD line 757 is explicit. Scope discipline.
- **Do NOT change the audit hash-chain canonical serialiser** — only the CASE branch in `audit_emit()`. The serialiser format (delimiter `\x1F`, field order) is locked per Story 1.2.

### Edge cases worth testing

- **Advance on a cycle with `status = with_advance`** → UPDATE affects 0 rows, no audit event (idempotent).
- **Advance on a cycle with `status = completed`** → UPDATE affects 0 rows (the WHERE filter), no audit event. Story 3.4 will catch this earlier with a 409.
- **Advance on a cycle with `status = settled`** → UPDATE affects 0 rows. Same as completed.
- **Contribution on `active` cycle** → no UPDATE fires, no audit event.
- **Two concurrent advance INSERTs from two browser tabs** → first tab's UPDATE acquires the row lock + flips status; second tab's UPDATE sees `with_advance`, no-op.
- **Advance INSERT inside a transaction that later ROLLBACKs** → cycle.status reverts (Postgres MVCC handles this for free).

### Definition-of-done checklist

- All 13 ACs satisfied + all 6 tasks ticked.
- Both migrations applied locally via `npm run db:migrate` (preserves seeded data per CLAUDE.md).
- `cycle.transitioned` event lands in `audit_log` for the first advance INSERT and NOT for subsequent ones.
- No frontend code changes (verified: `git diff main -- src/` returns empty for this story).
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run test:edge` / `npm run build` all green.
- **`npx playwright test` (full suite) green LOCALLY before push** (Story 2.5 discipline).
- Story status set to `review`; sprint-status updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 743-757 (Story 3.3 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 498 (FR18 — automatic status transitions).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md` line 570 (event taxonomy table — Task 3 adds `cycle.transitioned`),
  - line 486 (CycleStatus enum naming convention).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql` lines 105-118 (cycles table + status enum), lines 130-145 (transactions table — kind enum is the trigger's discriminant).
- **Existing audit trigger to extend:**
  - `supabase/migrations/20260423000002_audit_actor_jwt_fallback.sql` — Story 3.3 REPLACEs `audit_emit()` to add the `cycle.transitioned` case (this is the most recent definition; copy from here, not from migration 0007).
- **Audit chain integrity:**
  - `supabase/migrations/20260419000003_audit_log.sql` lines 18-22 (event_type CHECK constraint accepts `cycle.transitioned`).
- **Existing pattern to mirror:**
  - `supabase/functions/_shared/create-member-with-cycle.contract.test.ts` (Deno SQL contract test pattern — Story 3.3's test file follows the same structure).
- **Process discipline (Story 2.5 retrospective; Stories 2.7 + 3.2 confirmation):** Run Playwright LOCALLY before each push.
- **Local-DB workflow:** `CLAUDE.md` § Local-DB workflow — use `npm run db:migrate` (preserves seeded data) NOT `db:reset`.
- **Layering rules:** `CLAUDE.md` § Operating principles.

## Dev Agent Record

### Completion Notes

- All 13 ACs satisfied. 2 migrations applied via `npm run db:migrate` (preserved local seeded data).
- Migration 0020 extends `audit_emit()` with the new `cycle.transitioned` event type, slotted between `cycle.settled` and the catch-all `cycle.updated`. Hash chain unchanged.
- Migration 0021 adds the `promote_cycle_on_advance` trigger on `transactions AFTER INSERT`. Atomic, idempotent (`WHERE status='active'` filter), bypass-resistant.
- Filename collision fix: original `20260424...` slot was already taken by Story 2.7's `restart_member_cycle`. Renamed to `20260425000002` + `20260425000003` (after Story 2.6's `delete_member` migration).
- Reverse transition (`with_advance` → `active`) deferred per BDD line 757.
- 4 new Deno contract tests in `supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts`. All green via `npm run test:edge`.
- All gates green: typecheck ✅ / lint ✅ / 413 vitest ✅ / 20 edge ✅ / build ✅ / 18 Playwright validated locally.

### Debug Log

- **Migration filename collision** with Story 2.7's `20260424000001_restart_member_cycle.sql`. Fixed by bumping my new migrations to `20260425000002` + `20260425000003`. Both lexicographic-after Story 2.6's `delete_member` — order is correct.
- **Edge tests script** explicitly enumerates test files (not glob-discovered). Added the new file path to `scripts/run-edge-tests.sh`.
- **`vitest` startup ERR_PACKAGE_PATH_NOT_EXPORTED** after running `npm run test:edge`. Deno's `--node-modules-dir=auto` flag overwrote vite's resolver paths in `node_modules/.deno/`. Fix: `rm -rf node_modules && npm ci` cleanly. Long-term: separate Deno's npm cache from npm's via `--node-modules-dir=manual` would avoid this — out of scope for Story 3.3.
- **"advance on completed cycle" test** initially failed because `service.from("cycles").update({ status: "completed" })` itself fires a `cycle.transitioned` audit event (active → completed IS a status change). Fixed by snapshotting the count post-setup and asserting no DELTA from the advance INSERT.

## File List

**New (3 files):**
- `supabase/migrations/20260425000002_audit_emit_cycle_transitioned.sql`
- `supabase/migrations/20260425000003_promote_cycle_on_advance.sql`
- `supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts`

**Modified (2 files):**
- `scripts/run-edge-tests.sh` (added the new contract test path)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-24 | Winston (architect) | Story 3.3 spec generated by `bmad-create-story`. DB-only — extends `audit_emit()` with a `cycle.transitioned` event type, adds a new `promote_cycle_on_advance` trigger (AFTER INSERT on transactions, kind='advance' → cycles.status flip from active → with_advance). Atomic, idempotent (WHERE status='active' filter), bypass-resistant (trigger fires regardless of caller). Reverse transition (BDD line 757) deferred per BDD's explicit "not MVP-required" callout. Zero frontend changes — Stories 2.7 + 3.2 already prepared the UI surface. Status → ready-for-dev. |
| 2026-04-24 | dev agent | Implementation complete. 2 migrations + 4 Deno contract tests. All gates green: typecheck / lint / 413 vitest / 20 edge / build / 18 Playwright validated locally. Migration filename collision with Story 2.7 fixed (renamed to 20260425000002 + 20260425000003). Status → review. |
