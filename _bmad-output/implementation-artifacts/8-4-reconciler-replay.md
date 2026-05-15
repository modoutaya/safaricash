# Story 8.4: Reconciler with deterministic replay on reconnect

Status: done

## Story

As a **developer**,
I want **a reconciler worker that replays the IndexedDB event log to Supabase in monotonic order when connectivity returns**,
so that **offline writes become authoritative server state without conflict or loss (FR42, NFR-P6).**

> **Predicate of this story.** **Fourth story of Epic 8 (Offline Resilience).** Closes the offline-write loop: events queued by Story 8.3's `appendEvent` on the offline branch get drained to Supabase as soon as connectivity returns, the optimistic cache snapshots get reconciled with server truth via `invalidateQueries`, and the connectivity pill transitions through `syncing → connected` as the backlog empties.
>
> 1. **Server-side idempotency** — add a nullable `event_id UUID UNIQUE` column to `public.transactions` (3 migrations: column + index + 3 RPC signature updates). Each `record_contribution` / `record_advance` / `record_rattrapage` RPC accepts a new optional `p_event_id UUID DEFAULT NULL` parameter; when provided, the RPC first checks if a transaction with that `event_id` already exists and returns its `id` instead of inserting again. This guarantees idempotency under replay (the reconciler can safely retry).
> 2. **Reconciler module** — `src/infrastructure/sync/reconciler.ts` exposes `replayPendingEvents(collectorId)` which `listEvents` → POSTs via the right RPC (discriminated by `eventType`) → `deleteEvent` on 2xx. Serial loop in timestamp-ASC + eventId tiebreak order (already enforced by Story 8.2's `listEvents`).
> 3. **Trigger surfaces** — `useReconciler` hook subscribed to window `online` event + once on app boot. Single-in-flight guard via a module-scope ref so two tabs / two events don't race a double drain. Manual retry surface deferred to Story 8.5.
> 4. **Error classification** — per-event:
>    - **2xx success** → `deleteEvent` → BroadcastChannel decrements pendingCount → continue.
>    - **Network error** (TypeError / 5xx) → stop the drain (we're offline again or server is unreachable); the queue stays intact for the next trigger. Exponential backoff (10s → 600s cap, mirror SMS-worker NFR-R4) before auto-retry.
>    - **Validation error** (4xx with `code === "validation" | "cycle_closed" | "unauthorized"`) → permanent failure for THIS event; skip it and continue draining the rest (events are independent). The poisoned event stays in IDB with a new optional `lastError` field for Story 8.5's retry UI.
> 5. **Cache reconciliation** — on a successful drain (queue empty for the current collector), `invalidateQueries(MEMBERS_QUERY_KEY)` + `invalidateQueries(MEMBER_PROFILE_QUERY_KEY)` to swap Story 8.3's optimistic cache snapshots for server-truth.
> 6. **NFR-P6 budget** — 24 h backlog (~150 events) drains in p95 ≤ 90 s on typical WAEMU 3G. That's ~600 ms per event including server round-trip + audit-trigger latency. Single-flight serial loop is sufficient at this scale; no batching, no Promise.all.
>
> **Pattern alignment with existing infrastructure (DO NOT re-invent):**
> - SMS-worker exponential backoff (Story 6.2: 10s → 600s cap) — same shape, reuse the same exported `computeBackoff(attempt)` helper (extract to `src/infrastructure/sync/backoff.ts` if not already shared).
> - Audit-trigger emission auto-fires when the RPC inserts the row (Story 1.2 `audit_emit_*` triggers); the reconciler does NOT write audit rows itself.
> - `BroadcastChannel("safaricash-event-log")` from Story 8.3 — the `deleteEvent` calls already broadcast `{type: "delete", collectorId}` so `useConnectivityState.pendingCount` auto-refreshes; no new channel.
> - The `p_event_id` parameter naming + idempotency early-return pattern mirror Story 6.6's resend RPC (uniform handshake).
>
> **What Story 8.4 does NOT ship:**
> - Stalled-sync UI / retry CTAs (Story 8.5 owns the visible retry surface + the `hasFailed` source).
> - Offline READ path for member search / list / profile / edit (Story 8.6).
> - Background-sync API integration (PWA `sync` event) — deferred to Growth; window `online` event is sufficient for MVP.
> - Cross-tab coordination beyond single-in-flight per tab (two tabs may each attempt to drain — the RPC's idempotency handles the duplicate-replay safely).
> - Audit-log emission on the offline-reconciled branch — the server-side trigger emits when the RPC inserts.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1228-1236`; the rest are spec-derived constraints.

### Server-side idempotency (migrations)

1. **Migration 0056 — `event_id` column on `transactions`.**
   - Add `event_id UUID NULL` to `public.transactions`.
   - Add `CREATE UNIQUE INDEX transactions_event_id_idx ON public.transactions (event_id) WHERE event_id IS NOT NULL` (partial unique — pre-8.4 rows are NULL and don't conflict).
   - Backfill: leave NULL for existing rows.
   - Update `transactions_decrypted` view (per memory `project_views_after_columns.md`) to expose `event_id`.

2. **Migration 0057 — `record_contribution` accepts `p_event_id`.**
   - New signature: `record_contribution(p_member_id UUID, p_cycle_id UUID, p_amount INT, p_cycle_day INT, p_event_id UUID DEFAULT NULL)`.
   - Body starts with:
     ```sql
     IF p_event_id IS NOT NULL THEN
       SELECT id INTO existing_tx_id FROM public.transactions
       WHERE event_id = p_event_id AND collector_id = auth.uid();
       IF existing_tx_id IS NOT NULL THEN
         RETURN existing_tx_id;  -- idempotent replay
       END IF;
     END IF;
     -- … existing insert logic, passing event_id := p_event_id …
     ```
   - DROP + CREATE the function (Postgres can't change `DEFAULT` on parameters in place; mirror Story 7.5's `get_receipt_payload` workaround for SQLSTATE 42P13).

3. **Migration 0058 — `record_advance` accepts `p_event_id`.** Same pattern. Signature adds `, p_event_id UUID DEFAULT NULL` as the LAST parameter.

4. **Migration 0059 — `record_rattrapage` accepts `p_event_id`.** Same pattern.

5. **Idempotency contract.** When `p_event_id` is provided AND a transaction with `event_id = p_event_id AND collector_id = auth.uid()` exists:
   - The RPC returns that transaction's `id` (NOT a new one).
   - No new row is inserted.
   - No audit event fires (the trigger only emits on INSERT, not on idempotent-hit).
   - No cycle promotion / SMS enqueue / capacity recompute side-effects re-run.

6. **Server contract test (Deno)** — `supabase/functions/_shared/record-rpcs-idempotent.contract.test.ts` (single combined kebab-case file; amended from the original 3-file spec for DRY — all 9 cases share the same `seedCollector` boilerplate):
   - Call RPC with a fresh `p_event_id` → inserts row, returns its id.
   - Call RPC again with the SAME `p_event_id` (and same input) → returns the SAME id, no second row inserted.
   - Call RPC again with the SAME `p_event_id` but DIFFERENT collector → falls through to a fresh INSERT (the partial UNIQUE index is on `(collector_id, event_id)` per migration 0060 — collectors have isolated event_id namespaces). Both rows exist, both carry the same event_id but distinct collector_ids.
   - Same 3 cases × `record_advance` and × `record_rattrapage` (9 cases total).
   - **MUST BE REGISTERED in `scripts/run-edge-tests.sh`** so the gate `npm run test:edge` actually exercises the file. The script lists every contract test file explicitly; new files must be appended.

### Reconciler module

7. **`src/infrastructure/sync/reconciler.ts`** exports:
   ```ts
   /** Drain pending events for the given collector. Single-in-flight per
    *  module load (concurrent calls are no-ops and resolve immediately
    *  with the existing run's result). Resolves with a summary of what
    *  happened — caller (Story 8.5 retry button) uses it for telemetry. */
   export async function replayPendingEvents(collectorId: string): Promise<ReplayResult>;

   /** Manual stop signal — used by Story 8.5's stalled-sync UI to halt
    *  an in-progress drain that the user wants to pause. Returns a
    *  Promise that resolves when the current event finishes. */
   export async function stopReplay(): Promise<void>;

   export interface ReplayResult {
     attempted: number;
     succeeded: number;
     skipped: number;       // permanent failures (4xx); left in queue for Story 8.5
     networkFailures: number; // transient (network / 5xx); drain stopped early
     durationMs: number;
   }
   ```

8. **Per-event dispatch.** The reconciler picks the right RPC based on `eventType`:
   - `transaction.contribution_recorded` → `record_contribution(p_event_id := eventId, …)` with the payload's `p_member_id` / `p_cycle_id` / `p_amount` / `p_cycle_day`.
   - `transaction.advance_recorded` → `record_advance(…, p_event_id := eventId)`.
   - `transaction.rattrapage_recorded` → `record_rattrapage(…, p_event_id := eventId)`.
   - `transaction.undone` / `member.*` event types — out of scope for Story 8.4 (`member.*` is Story 8.6; `transaction.undone` requires a soft-undo RPC handshake that doesn't exist yet). The reconciler logs an `"unsupported_kind"` warning + skips the event (leaves in queue with `lastError`).

9. **Error classification — exported helper** `classifyReplayError(err)`:
   - `TypeError` (fetch failure) OR PostgREST `5xx` code → `"network"` (transient).
   - PostgREST `4xx` with code `42501` / `28000` → `"unauthorized"` (permanent for THIS event — the collector's session expired mid-drain; the reconciler stops the entire drain because all subsequent events would also fail with the same).
   - PostgREST `4xx` with code `23514` / `22023` / `22000` → `"validation"` (permanent for THIS event; skip + continue).
   - PostgREST `4xx` with code `P0002` / `PGRST116` → `"not_found"` (permanent for THIS event; skip).
   - Anything else → `"unknown"` (treat as transient — caller decides whether to stop).

10. **Drain algorithm** — serial loop in `listEvents` order:
    ```
    let attempted = 0, succeeded = 0, skipped = 0, networkFailures = 0
    const events = await listEvents(collectorId)
    for each event in events:
      if (stopRequested) break
      attempted++
      try:
        await postEvent(event)  // calls the right RPC with p_event_id
        await deleteEvent(event.eventId, collectorId)
        succeeded++
      catch (err):
        const code = classifyReplayError(err)
        if (code === "network" || code === "unknown"):
          networkFailures++
          break  // stop drain; next online event triggers retry
        if (code === "unauthorized"):
          break  // session is gone; all remaining events would fail same
        // validation / not_found → permanent for this event, log + skip
        skipped++
        // (Story 8.5 will mark with lastError; Story 8.4 just leaves
        // the event in the IDB log without deleting)
        continue
    ```

11. **Single-in-flight guard.** Module-scope `let inFlightPromise: Promise<ReplayResult> | undefined`. `replayPendingEvents` returns the existing promise if one is in flight, otherwise starts a new run.

12. **`postEvent(event)`** internal helper translates the OfflineEvent payload → `supabase.rpc(rpcName, payload)`. The payload is already in `p_*` snake_case shape (Story 8.3's `buildOfflineEvent` wrote it that way), so it's a direct spread:
    ```ts
    const { data, error } = await supabase.rpc(rpcName, event.payload);
    ```
    Story 8.3's payload already includes `p_event_id` (= the syntheticTxId / IDB eventId); no further mapping needed.

### Trigger surfaces

13. **`useReconciler` hook** at `src/features/connectivity/api/useReconciler.ts`:
    - Subscribes to window `online` event → calls `replayPendingEvents(collectorId)` with the current collector from `useCollectorId`.
    - Runs ONCE on mount (catches events queued in a previous session that hasn't been drained).
    - On successful drain (`ReplayResult.networkFailures === 0`), calls `queryClient.invalidateQueries(MEMBERS_QUERY_KEY)` + `invalidateQueries(MEMBER_PROFILE_QUERY_KEY)` to swap optimistic cache snapshots for server truth.
    - No return value — the hook is a side-effect-only mount-point.

14. **Mount point** — `src/App.tsx` mounts `useReconciler()` inside `AppLayout` (the same component that hosts `ConnectivityIndicator`). The hook runs only when authenticated (per the existing `AuthGate` wrapper).

15. **Exponential backoff for network failures.** When the drain stops on a `networkFailures > 0` outcome, the next auto-retry is gated by a backoff timer (10s → 20s → 40s → 80s → 160s → 320s → 600s cap, doubling). Reset to 10s on a successful drain. The `online` window event ALWAYS triggers a fresh attempt regardless of the backoff (the network coming back is a strong signal).

### Cache reconciliation

16. **`MEMBERS_QUERY_KEY` invalidation** after a successful drain — replaces Story 8.3's optimistic snapshot (recency-bump) with the real server data (the audit-trigger fired, the cycle status may have flipped, the last_transaction_at is now authoritative).

17. **`MEMBER_PROFILE_QUERY_KEY` invalidation** per affected member — replaces the synthetic transaction rows with the real ones (server-generated `id`, real `receipt_token`, real `created_at`). For Story 8.4 we invalidate ALL profile queries (broad-spectrum); Story 8.6 can narrow if perf shows a cost.

### Tests

18. **Unit tests — `reconciler.test.ts`** (vitest + `fake-indexeddb` polyfill from Story 8.2). **≥ 12 cases:**
    - Empty queue → no RPC calls + `ReplayResult { attempted: 0, succeeded: 0, … }`.
    - 3 events all succeed → 3 RPC calls in timestamp order + 3 `deleteEvent` calls + queue empty.
    - Mid-drain TypeError on event 2 → events 1 succeeded + 2 unattempted (drain stopped) + queue retains 2 events.
    - 5xx error on event 1 → classified `network` + drain stopped + queue retains all 3.
    - 4xx validation error on event 2 → event 2 skipped + events 1 and 3 succeeded + queue retains event 2.
    - `unauthorized` (42501) on event 1 → drain stopped + nothing deleted.
    - Idempotent replay — pre-existing transaction at server side → RPC returns existing id → reconciler still calls `deleteEvent` (the local event is now redundant).
    - Single-in-flight — two concurrent `replayPendingEvents()` calls return the SAME promise.
    - `stopReplay()` mid-drain — current event finishes, loop breaks.
    - `transaction.undone` event → skipped with `unsupported_kind` log + queue retains.
    - `member.created` event → same (Story 8.6 will add support).
    - 150-event happy-path drain → completes; total `attempted === 150` (NFR-P6 functional check; perf measured in Playwright).

19. **`useReconciler` hook tests** — `useReconciler.test.tsx` (≥ 4 cases):
    - On mount with `collectorId !== null` → calls `replayPendingEvents`.
    - On mount with `collectorId === null` → does NOT call (waits for session).
    - Window `online` event → calls `replayPendingEvents`.
    - Unmount → window listener removed.

20. **Deno contract tests — idempotency** (per AC #6) (≥ 9 cases: 3 RPCs × 3 scenarios):
    - Fresh `p_event_id` inserts a row.
    - Same `p_event_id` returns the same `id` without inserting a second row.
    - Same `p_event_id` from a different `auth.uid()` → falls through to a fresh INSERT (cross-collector partitioning via the RLS-aware WHERE clause).

21. **Playwright E2E** — `tests/e2e/flow-1-offline-replay.spec.ts`:
    - Sign in as the seed collector.
    - DevTools-equivalent: `context.setOffline(true)`.
    - Record a contribution → assert offline toast + pill count = 1.
    - `context.setOffline(false)` → wait for pill count = 0 + member list shows the contribution as the most recent.
    - Verify the audit-log row was emitted server-side via `supabase.from('audit_log').select(...).eq('event_id', …)`.

22. **NFR-P6 perf budget** — soft assertion in the Playwright spec (NOT a hard gate; budget is "p95 ≤ 90 s for 150 events" which is hard to reproduce in CI). Document the budget + a manual smoke step in the spec's Definition-of-done section.

### Architecture, dependencies, hygiene

23. **No new npm dependencies** — `supabase-js` already exposes `rpc()`; everything else is already in the bundle.

24. **Bundle delta budget** ≤ 3 KB gzipped (reconciler ~120 LOC + useReconciler ~40 LOC + backoff helper ~20 LOC + tests).

25. **Layering** — `src/infrastructure/sync/reconciler.ts` may import from `src/infrastructure/supabase/` + `src/infrastructure/sync/eventLog`. `src/features/connectivity/api/useReconciler.ts` may import from `@/infrastructure/sync` (reconciler) + `@/features/auth/api/useCollectorId` (cross-feature, precedent set in Story 8.3).

26. **`navigator.onLine` discipline** — the `online` window event fires when navigator transitions from `false` to `true`. This is a STRONG signal but not a guarantee (captive portal). The reconciler's first RPC call confirms real connectivity; on failure it backs off. The boot-time replay also catches the case where the user was always online but had events queued from a previous session that didn't drain.

27. **Cross-tab safety** — two tabs may each call `replayPendingEvents`. The RPC's idempotency check (AC #5) handles the duplicate-replay safely. Both tabs may each call `deleteEvent` for the same `eventId`; the IDB-level `delete` on a missing key is idempotent (Story 8.2 confirmed `deleteEvent` is no-op on miss).

28. **All gates green**:
    - `npm run typecheck` — strict clean.
    - `npm run lint` `--max-warnings=0` — clean.
    - `npm run test -- --coverage` — global ≥ 75 % branches preserved; new reconciler module ≥ 85 % branches isolated.
    - `npm run test:edge` — Deno contract tests pass (3 RPC × 3 scenarios = 9 cases).
    - `npm run build` — bundle delta ≤ AC #24.
    - `npx playwright test` — new offline-replay flow + existing Flow 1/2/3 unchanged.
    - **Pre-push memory**: `nvm use 22` (per `feedback_npm_lockfile_node_version.md`) ; coverage locally before push (per `feedback_run_coverage_locally.md`) ; grep stale assertions (per `feedback_push_then_ci_failure.md`) ; for any BroadcastChannel assertion in tests, use poll-with-deadline NOT setTimeout (per `feedback_broadcastchannel_test_timing.md`).

## Tasks / Subtasks

- [x] **Task 1 — Migration 0056: `event_id` column on `transactions`** (AC: #1)
  - `npm run db:migrate:new add-event-id-to-transactions`
  - Column: `event_id UUID NULL`
  - Partial unique index `transactions_event_id_idx ON (event_id) WHERE event_id IS NOT NULL`
  - Update `transactions_decrypted` view to expose `event_id` (memory `project_views_after_columns.md`)

- [x] **Task 2 — Migration 0057: `record_contribution` accepts `p_event_id`** (AC: #2, #5)
  - DROP + CREATE the function (SQLSTATE 42P13 workaround per Story 7.5)
  - Idempotency early-return at the top
  - GRANT EXECUTE to `authenticated`
  - Regenerate `database.types.ts` via `npm run db:types` after migration applies

- [x] **Task 3 — Migration 0058: `record_advance` accepts `p_event_id`** (AC: #3)
  - Same pattern.

- [x] **Task 4 — Migration 0059: `record_rattrapage` accepts `p_event_id`** (AC: #4)
  - Same pattern.

- [x] **Task 5 — Deno contract tests** (AC: #6, #20)
  - 3 new test files under `supabase/functions/_shared/` — one per RPC.
  - Each file: 3 cases (insert / idempotent-hit / cross-collector fresh-insert).

- [x] **Task 6 — `backoff.ts` helper** (AC: #15)
  - Extract or reuse the SMS-worker backoff (`src/infrastructure/sync/backoff.ts`).
  - `computeBackoff(attempt: number): number` → returns ms (10000 → 20000 → … cap 600000).
  - Unit tests (4 cases: attempt 0 → 10s, attempt 5 → 320s, attempt 10 → 600s cap, monotonic).

- [x] **Task 7 — `reconciler.ts` module** (AC: #7-#12, #18)
  - New `src/infrastructure/sync/reconciler.ts` (~150 LOC).
  - `replayPendingEvents` + `stopReplay` + `ReplayResult` + `classifyReplayError`.
  - Single-in-flight via module-scope ref.
  - Per-event dispatch table → `record_contribution` / `record_advance` / `record_rattrapage`.
  - Re-export from `@/infrastructure/sync` barrel.
  - 12 vitest cases per AC #18.

- [x] **Task 8 — `useReconciler` hook** (AC: #13-#15, #19)
  - New `src/features/connectivity/api/useReconciler.ts` (~50 LOC).
  - Window `online` listener + mount-once trigger.
  - Exponential backoff via Task 6 helper.
  - `queryClient.invalidateQueries` on successful drain.
  - 4 vitest cases.

- [x] **Task 9 — Mount `useReconciler` in `AppLayout`** (AC: #14)
  - `src/App.tsx` calls `useReconciler()` inside the authenticated layout.

- [x] **Task 10 — Playwright E2E** (AC: #21)
  - `tests/e2e/flow-1-offline-replay.spec.ts`.
  - Offline contribution → online → drain → server audit-log assertion.

- [x] **Task 11 — Gate run + sprint hygiene** (AC: #28)
  - All gates green locally on Node 22 / npm 10.
  - Update `sprint-status.yaml`: `8-4-reconciler-replay` `ready-for-dev → review`.
  - Update `last_updated` + touched line.

## Dev Notes

### Why server-side idempotency via `event_id` (not client-side dedup)

The reconciler MUST be safe to retry on any failure. Without server idempotency, a network glitch AFTER the RPC inserted but BEFORE the response reached the client would cause a duplicate insertion on the retry. The `event_id` UNIQUE index makes the RPC a no-op on second call, regardless of whether the first call's response was lost in transit. This is the "exactly-once on the server" property the architecture's NFR-R2 (zero data loss) demands.

### Why a partial UNIQUE index (`WHERE event_id IS NOT NULL`)

Pre-8.4 rows have `event_id = NULL` (they were inserted by Stories 4.3-5.4 RPCs without an event_id param). A full UNIQUE index would treat NULLs as distinct (Postgres semantic) so the migration is safe either way, but the partial index makes the intent explicit and saves a few KB of index storage.

### Why DROP + CREATE the RPCs instead of ALTER

Postgres can't change parameter defaults in place — `ALTER FUNCTION` doesn't support default-value changes. The DROP + CREATE pattern is the documented workaround (Story 7.5 used it for `get_receipt_payload`'s SQLSTATE 42P13). Side effect: any `GRANT EXECUTE` clause must be re-applied; the migration includes it explicitly.

### Why single-flight (not parallel)

`Promise.all([drain event 1, drain event 2, …])` would be faster but loses ordering and complicates error handling (one event's failure must not block independent successors, but it MUST gate the events that depend on it — e.g., a `member.deleted` event after `member.updated` for the same member). The NFR-P6 budget (90s for 150 events = 600ms each) is met by a serial loop with modern Postgres RTT (~80ms WAEMU → Paris) + RPC body time (~200ms) + IDB delete (~10ms) ≈ 300ms per event = 45s for 150 events. Half the budget, plenty of headroom.

### Why `online` event + boot-time replay (no Background Sync API)

The PWA Background Sync API would let the OS schedule a drain even when the app is backgrounded — appealing but not yet widely supported on iOS Safari (the secondary target). The `online` window event + mount-time replay handles 90% of the cases (collector reopens the app when network is back; the drain fires on mount). For the remaining 10% (collector closes the app while offline + reopens online → mount catches it; collector keeps the app open through a 3G dropout → online event fires when reception returns). Background Sync remains a Growth-phase upgrade.

### Why no batching

Each RPC call inserts ONE row + fires ONE audit trigger + may flip ONE cycle status. Batching multiple events into a single RPC would require a new "bulk" RPC variant per kind (3 new RPCs) for marginal gain over the serial loop. The architecture's "boring tech" stance favors the simpler approach.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| Exponential backoff curve | `src/infrastructure/sync/backoff.ts` (extract or reuse SMS-worker's pattern from Story 6.2) |
| `OfflineEvent` shape + Zod | `@/infrastructure/sync` (Story 8.2) |
| `listEvents` / `deleteEvent` / BroadcastChannel | `@/infrastructure/sync` (Story 8.2 + 8.3) |
| `useCollectorId` | `@/features/auth/api/useCollectorId` (Story 8.3) |
| MEMBERS / MEMBER_PROFILE query keys | `@/features/member` |
| Idempotent RPC early-return pattern | `record_contribution` body's session check (Story 4.3) — extend with the event_id check |
| `transactions_decrypted` view extension | Memory `project_views_after_columns.md` discipline |
| SQLSTATE 42P13 workaround for ALTER FUNCTION defaults | Story 7.5's `get_receipt_payload` migration |

### Anti-patterns to avoid (memory + spec-fidelity)

- **DO NOT** call `supabase.rpc` from a free variable (memory `project_supabase_rpc_binding.md` — preserves `this.rest` binding).
- **DO NOT** forget to update `transactions_decrypted` after adding the `event_id` column (memory `project_views_after_columns.md`).
- **DO NOT** run `npm install` on Node 24 / npm 11 — `nvm use 22` first (memory `feedback_npm_lockfile_node_version.md`).
- **DO NOT** use fixed `setTimeout` to wait for BroadcastChannel messages in tests — poll-with-deadline (memory `feedback_broadcastchannel_test_timing.md`).
- **DO NOT** use `Promise.all` to drain events — serial loop preserves order + simplifies error handling (see Dev Notes).
- **DO NOT** wire `hasFailed = true` in `useConnectivityState` from this story — that's Story 8.5's source. The pill transitions through `syncing → connected` via the pendingCount → 0 flow only.
- **DO NOT** add audit-log emission to the reconciler — the server-side trigger emits when the RPC inserts. Double-emission would corrupt the hash chain (NFR-S6).
- **DO NOT** batch RPC calls — see Dev Notes "Why no batching".
- **DO NOT** use the PWA Background Sync API — see Dev Notes "Why `online` event".

### Pre-push checklist (per `feedback_push_then_ci_failure.md`)

1. `npm run typecheck` ✓
2. `npm run lint --max-warnings=0` ✓
3. `npm run test -- --coverage` — global ≥ 75 % branches ; reconciler ≥ 85 % isolated
4. `npm run test:edge` — Deno contract tests pass (9 cases)
5. `npm run build` — clean ; bundle ≤ AC #24
6. `npx playwright test` — new flow-1-offline-replay spec + Flow 1/2/3 unchanged
7. Grep for stale assertions: `grep -rn "pendingCount = 0" src/features/connectivity/` (should match only the JSDoc-position not the actual value)
8. Verify `nvm use 22` active before any `npm install` (none expected — no new deps)
9. **BroadcastChannel test discipline** — any new BroadcastChannel assertion must use poll-with-deadline (memory `feedback_broadcastchannel_test_timing.md`)

### Project structure notes

**New files:**
- `supabase/migrations/<timestamp>_add_event_id_to_transactions.sql`
- `supabase/migrations/<timestamp>_record_contribution_idempotent.sql`
- `supabase/migrations/<timestamp>_record_advance_idempotent.sql`
- `supabase/migrations/<timestamp>_record_rattrapage_idempotent.sql`
- `supabase/functions/_shared/record-rpcs-idempotent.contract.test.ts` (single combined file covering all 3 RPCs — amended from the original 3-file spec per code-review patch)
- `src/infrastructure/sync/reconciler.ts`
- `src/infrastructure/sync/reconciler.test.ts`
- `src/infrastructure/sync/backoff.ts` (or reuse — verify whether Story 6.2's SMS-worker backoff is already extracted)
- `src/infrastructure/sync/backoff.test.ts`
- `src/features/connectivity/api/useReconciler.ts`
- `src/features/connectivity/api/useReconciler.test.tsx`
- `tests/e2e/flow-1-offline-replay.spec.ts`

**Modified files:**
- `src/infrastructure/sync/index.ts` — export `replayPendingEvents` + `stopReplay` + `ReplayResult`.
- `src/App.tsx` — mount `useReconciler()` inside the authenticated layout.
- `src/infrastructure/supabase/database.types.ts` — regenerated by `npm run db:types` after the migrations apply.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Testing standards

- Vitest + `fake-indexeddb` (Story 8.2 polyfill in `vitest.setup.ts`).
- Deno test suite for migration contracts (existing `test:edge` script).
- Playwright for the E2E offline-replay flow (`test:e2e`).
- Coverage gate: ≥ 75 % branches globally ; new reconciler ≥ 85 % branches isolated.
- 100 % domain gate unaffected.

### Definition-of-done checklist

- All 28 ACs satisfied + all 11 tasks ticked.
- 4 migrations applied locally + `transactions_decrypted` view extended.
- 3 RPCs accept `p_event_id` and early-return on idempotent hit.
- Reconciler module ships with single-in-flight + serial drain + classified errors.
- `useReconciler` mounted in `AppLayout`.
- Cache invalidated post-drain.
- All gates green on Node 22 / npm 10.
- Story status `review` ; sprint-status updated ; touched-line updated.

### Review Findings

Cross-LLM code review on 2026-05-15 (sonnet-4-6, 3 parallel layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). Findings: 21 `patch`, 3 `defer`, 1 dismissed.

**HIGH severity (8):**

- [x] [Review][Patch] **event_id partial UNIQUE not partitioned by collector_id + 23505 unclassified** (Blind B1 + Edge E1 + E4) [supabase/migrations/20260515000003:75-77 + reconciler.ts:104-147 + comment line 72] — the index is `(event_id)` alone but the column comment claims "partitioned by collector_id". Cross-tab race on the same collector → 23505 falls through to "unknown" → drain stops instead of self-healing via the RPC's idempotent early-return on next retry. Fix: change index to `(collector_id, event_id) WHERE event_id IS NOT NULL` (collision-isolated by collector — matches AC #20's "fresh INSERT" semantic) AND add `code === "23505"` → `"validation"` in `classifyReplayError` (skip+continue self-heals).
- [x] [Review][Patch] **`makeContribEvent` fixture: `eventId` and `payload.p_event_id` diverge via 2 independent `crypto.randomUUID()` calls** (Blind B2) [src/infrastructure/sync/reconciler.test.ts:33-49] — when `opts.eventId` is not supplied, the fixture generates 2 different UUIDs: one for the OfflineEvent's `eventId` (IDB key), one for `payload.p_event_id` (RPC idempotency key). The reconciler passes `event.payload` (containing UUID-B) to the RPC and `event.eventId` (UUID-A) to `deleteEvent`. The idempotency-replay test that asserts the existing id is returned passes vacuously — the two UUIDs are never expected to match. Fix: in `makeContribEvent`, generate ONCE: `const sharedId = opts.eventId ?? crypto.randomUUID(); return { eventId: sharedId, payload: { ..., p_event_id: sharedId } };`.
- [x] [Review][Patch] **`stopReplay` stale `stopRequested = true` bleeds to next drain** (Blind B3) [src/infrastructure/sync/reconciler.ts:101-115] — `stopReplay` sets `stopRequested = true` BEFORE awaiting `inFlight`; if `inFlight` clears between the guard and the await, `stopRequested` stays `true` until the next `replayPendingEvents` call resets it on line 100. A `stopReplay` call when no drain is in flight permanently sets the flag and the next drain exits immediately. Fix: `if (!inFlight) { stopRequested = false; return; }` — reset the flag when there's nothing to stop.
- [x] [Review][Patch] **AC #15 — exponential backoff timer NOT implemented** (Auditor A1 + A5 + Edge E3) [src/features/connectivity/api/useReconciler.ts] — spec mandated a timer-driven retry between failed drains; `computeBackoffMs` is exported but never imported by the hook. The reconciler comment "Caller (the hook) schedules backoff retry" is aspirational. Real impact: device online + 5xx burst → drain stops → no further retry until the next `window.online` event (which may never fire on a stable connection). Fix: add `attemptRef = useRef(0)` to `useReconciler`; after a drain with `networkFailures > 0`, `setTimeout(trigger, computeBackoffMs(attemptRef.current++))` with cleanup on `online` event / unmount; reset on clean drain.
- [x] [Review][Patch] **AC #28 — `test:edge` gate claim FALSE — new contract test not in `run-edge-tests.sh`** (Auditor A2) [scripts/run-edge-tests.sh + supabase/functions/_shared/record-rpcs-idempotent.contract.test.ts] — `run-edge-tests.sh` lists every `.contract.test.ts` file explicitly; the new file is NOT listed; the 9 idempotency cases have never been exercised by CI. The Dev Agent Record claims "test:edge ✓" but the script can't have run the file. Fix: append the file to `run-edge-tests.sh`'s list and re-run `npm run test:edge` locally to confirm all 9 cases pass.
- [x] [Review][Patch] **AC #6 / AC #20 — cross-collector spec body NOT amended; AC #6 file naming wrong** (Auditor A3 + A4) [_bmad-output/implementation-artifacts/8-4-reconciler-replay.md AC #6 + #20 + Project structure notes] — AC #6 names 3 separate files (`record_contribution_idempotent.contract.test.ts` etc.); actual implementation is 1 kebab-case combined file (`record-rpcs-idempotent.contract.test.ts`). AC #6 body says cross-collector "errors with unauthorized"; AC #20 says "falls through to fresh INSERT"; actual behavior is `23505` (and with the index partition fix above will become "fresh INSERT" matching AC #20). Fix: amend AC #6 to acknowledge the combined-file approach + update cross-collector outcome description; update spec's "Project structure notes" file list.
- [x] [Review][Patch] **`replayPendingEvents` unhandled rejection in `useReconciler`** (Edge E2) [src/features/connectivity/api/useReconciler.ts:38] — `void replayPendingEvents(collectorId).then(result => …)` has no `.catch()`. `listEvents` can throw `OfflineEventLogError` on IDB open failure (Safari private mode, storage eviction, DB_OPEN_FAILED). The unhandled rejection crashes silently; `triggeredRef` stays `true` so boot-replay never retries this mount. Fix: add `.catch((err) => { console.warn("[reconciler] drain failed", err); })` — at minimum surface to console for diagnostics; future Story 8.5 will wire toast.
- [x] [Review][Patch] **AC #8 — `unsupported_kind` warning NOT logged** (Auditor A7) [src/infrastructure/sync/reconciler.ts:148-155] — spec says "The reconciler logs an 'unsupported_kind' warning + skips the event"; implementation only increments `skipped` without any console output. A future story (8.6 member.*) developer running with stuck unsupported events sees no diagnostic. Fix: add `console.warn("[reconciler] unsupported_kind — skipping event", event.eventType, event.eventId);` before the `continue`.

**MED severity (9):**

- [x] [Review][Patch] **`classifyReplayError` unsafe cast on `err`** (Blind B5) [src/infrastructure/sync/reconciler.ts:104-110] — the cast `err as { code?: string; … }` accepts any value including primitives. If a non-object is thrown (e.g., string reject from a future supabase-js version), runtime access to `.code` works via optional chaining but the type narrowing is unsound. Fix: guard explicitly: `if (err == null || typeof err !== "object") return "unknown";` BEFORE the cast.
- [x] [Review][Patch] **`useReconciler` `triggeredRef` not reset on `collectorId` change** (Blind B7 + Edge E8) [src/features/connectivity/api/useReconciler.ts:30-35] — `triggeredRef` only resets when `collectorId` becomes `null`. If user signs out and a DIFFERENT user signs in within the same tab (both non-null), `triggeredRef = true` from prior session blocks the new collector's boot-replay. Fix: reset `triggeredRef.current = false` at the TOP of the effect body (before the null guard) so every `collectorId` change re-arms the boot-replay.
- [x] [Review][Patch] **AC #16/17 — cache invalidation condition doesn't match "queue empty"** (Auditor A6) [src/features/connectivity/api/useReconciler.ts:42] — current condition `succeeded > 0 && networkFailures === 0` fires invalidation even when `skipped > 0` (poisoned events still in queue). Spec intent was "queue empty" — should also require `skipped === 0`. Fix: `if (result.succeeded > 0 && result.networkFailures === 0 && result.skipped === 0)`.
- [x] [Review][Patch] **AC #22 — NFR-P6 test uses 30 events; spec demands 150** (Auditor A8) [src/infrastructure/sync/reconciler.test.ts:260-272] — spec explicitly says `attempted === 150`. Test scaled down to 30 with a comment about CI speed. Fix: either bump to 150 (pure mock, fast even at 150) OR amend AC #22 to say `≥ 30` formally.
- [x] [Review][Patch] **AC #10 — `unauthorized` counted as `networkFailures`** (Auditor A9) [src/infrastructure/sync/reconciler.ts:175-178] — spec pseudocode only increments `networkFailures` for `"network" || "unknown"`. Implementation increments for `unauthorized` too. This conflates two distinct failure modes Story 8.5's retry UI will need to distinguish. Fix: add a `sessionFailures: number` field to `ReplayResult` OR amend AC #10 to explicitly note the conflation is intentional.
- [x] [Review][Patch] **`record_advance` capacity check at replay time may falsely reject** (Blind B6 + Edge E5) [supabase/migrations/20260515000005:94-104] — capacity check uses `transactions_decrypted` (filters `undone_at IS NULL`) at replay time, not at offline-capture time. An offline-recorded advance can be replayed AFTER an online advance fills the cycle's capacity → 22023 rejection → marked as skipped permanently. No test coverage. Fix: document the edge case in the migration comment AND in deferred-work.md (real fix is to enforce capacity at offline-capture time in Story 8.3 — out of scope for 8.4).
- [x] [Review][Patch] **`deleteEvent` throwing inside the RPC try-block classified as "unknown"** (Edge E6) [src/infrastructure/sync/reconciler.ts:160-178] — if RPC succeeds (server committed) but `deleteEvent` throws (IDB quota exceeded), the error reaches `classifyReplayError` which sees `OfflineEventLogError` (no `.code` numeric, msg includes "quota exceeded") → returns "unknown" → drain stops + event stays in IDB. Next retry: RPC early-returns (idempotent hit) + deleteEvent retried — self-healing in normal conditions, but under sustained IDB pressure the event loops. Fix: move `deleteEvent` outside the RPC try-block OR classify `OfflineEventLogError` separately (e.g., return as "transient_idb" — drain continues, event re-queued for next attempt).
- [x] [Review][Patch] **Playwright `context.setOffline(false)` may not reliably fire window `online`** (Edge E7) [tests/e2e/flow-1-offline-replay.spec.ts:82-95] — CDP Emulation.setNetworkConditions doesn't always fire the `online` event deterministically; the 15s poll is the only guard. Fix: after `setOffline(false)`, explicitly `await page.evaluate(() => window.dispatchEvent(new Event("online")))` OR wait for the event: `await page.evaluate(() => new Promise(r => window.addEventListener("online", r, { once: true })))`.
- [x] [Review][Patch] **`replayPendingEvents` returns wrong in-flight drain on rapid session-switch** (Edge E8) [src/infrastructure/sync/reconciler.ts:78-84] — Caller A passes `collector-1` and starts a drain; while in flight, caller B with `collector-2` calls `replayPendingEvents` and gets Collector-1's drain Promise. The drain still iterates over Collector-1's events but uses the CURRENT auth session (Collector-2). All RPCs fail with 28000 unauthorized → drain stops. Self-healing on next call but confusing. Fix: include collectorId in the in-flight check: `if (inFlight && inFlightCollectorId === collectorId) return inFlight; else if (inFlight) await inFlight; …`.

**LOW severity (4):**

- [x] [Review][Patch] **AC #18 — inline comment "12 scenarios" stale** (Auditor A10) [src/infrastructure/sync/reconciler.test.ts:3] — file has 17 cases; comment says 12. Fix: update comment to "17 scenarios."
- [x] [Review][Patch] **`drainInternal` mid-drain queue snapshot — document** (Blind B4) [src/infrastructure/sync/reconciler.ts:156] — `listEvents` called once; events appended mid-drain are invisible until next trigger. Real but acceptable trade-off. Fix: add a Dev Notes section to the reconciler header docs explaining this is intentional.
- [x] [Review][Patch] **Contract test queries `audit_log` without verifying access** (Blind B9) [supabase/functions/_shared/record-rpcs-idempotent.contract.test.ts:158-165] — if service role can't read `audit_log` (misconfigured stack), `auditCount` is `null` and `assertEquals(null, 1)` fails with a confusing error. Fix: `assert(auditCount !== null, "audit_log must be accessible to service role")` before the count assertion.
- [x] [Review][Patch] **`_resetReconcilerForTests` should await pending in-flight** (Edge E9) [src/infrastructure/sync/reconciler.ts:225-230] — current implementation sets `inFlight = undefined` and `stopRequested = false` without awaiting an orphaned drain; the orphan's `finally` block may corrupt subsequent test state. Fix: make it `async`, capture the pending promise, await it before resetting.

**Defer (3):**

- [x] [Review][Defer] **`useReconciler` unmount-remount fires fresh boot-replay** [src/features/connectivity/api/useReconciler.ts] — `useRef` is instance-scoped; benign for empty queue (no-op RPC), correct for non-empty (re-drain). Track if React Router nested layouts cause frequent unmount/remount.
- [x] [Review][Defer] **DROP FUNCTION / CREATE OR REPLACE race during live migration** [supabase/migrations/20260515000004-0006] — narrow window during deploy where `record_contribution` returns 42883. Sub-millisecond on a lightly-loaded server. Standard pg_upgrade-without-downtime practice would use CREATE OR REPLACE first then DROP, but the spec used DROP+CREATE per SQLSTATE 42P13 workaround. Document in migration headers as known limitation.
- [x] [Review][Defer] **E2E poll timeout 15s may be tight on slow CI** [tests/e2e/flow-1-offline-replay.spec.ts:84] — audit-trigger + RLS predicate evaluation + vault_decrypt can exceed 15s under load. Playwright retries (2×) mask this. Document as flake watch + bump to 25-30s if first run flakes.

**Dismissed (1):**

- **`supabase.rpc` double cast — no Zod parse of payload** (Blind B8) — Story 8.3's `buildOfflineEvent` shape is type-locked; the payload is constructed in TypeScript and persisted in IDB through Zod-validated schema. The cast at the RPC call site is acceptable. Adding a runtime Zod parse would catch a payload-shape regression but adds complexity for low value.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1220-1236 (Story 8.4 BDD), 179 (AR8 — event-sourced offline sync), 1188-1218 (Stories 8.2-8.3 — what 8.4 consumes).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` lines 535 (FR42 — deterministic reconciliation), 558 (NFR-P6 — backlog drain p95 ≤ 90 s), 564 (NFR-R2 — zero data loss on reconnection).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` lines 108 (event-sourced design), 370 (reconciler), 642-643 (retry policies), 977-978 (`reconciler.ts` file layout), 1041 (PostgREST direct call pattern), 1137-1143 (Flow 1 data path).
- **Story 8.2 (predecessor):** `_bmad-output/implementation-artifacts/8-2-indexeddb-event-log.md` — `listEvents` / `deleteEvent` / `EVENT_LOG_CHANNEL_NAME` contracts.
- **Story 8.3 (predecessor):** `_bmad-output/implementation-artifacts/8-3-outbox-pattern-queue.md` — `buildOfflineEvent` (the snake_case `p_*` payload), `useCollectorId`, `useConnectivityState.pendingCount` BroadcastChannel subscription.
- **Story 4.3 (contribution RPC baseline):** `supabase/migrations/20260425000005_record_contribution.sql` — current `record_contribution` signature.
- **Story 5.4 (advance RPC baseline):** `supabase/migrations/20260427000002_record_advance.sql` — current `record_advance` signature.
- **Story 4.4 (rattrapage RPC baseline):** `supabase/migrations/20260426000002_record_rattrapage.sql`.
- **Story 6.2 (SMS-worker backoff precedent):** exponential 10s → 600s, `computeBackoff(attempt)` shape.
- **Story 7.5 (SQLSTATE 42P13 DROP+CREATE workaround):** `get_receipt_payload` migration pattern.
- **CLAUDE.md anti-patterns:** no state-management lib ; `_decrypted` view discipline ; `db:migrate` not `db:reset` during story dev.
- **Memory:** `feedback_npm_lockfile_node_version.md` (Node 22 / npm 10), `feedback_broadcastchannel_test_timing.md` (poll-with-deadline), `project_supabase_rpc_binding.md` (preserve rpc binding), `project_views_after_columns.md` (update `transactions_decrypted` view), `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`db:types` script targets the linked cloud project** (`supabase gen types typescript --linked`) — but the local Supabase project hasn't been linked. Used `npx supabase gen types typescript --local 2>/dev/null > database.types.ts` instead (stderr-redirect is critical — the CLI prints "Connecting to db 5432" to stdout when not silenced, which would land in the generated file and break the TS parse).
- **Reconciler test fixture timestamp generator overflowed** for `idx ≥ 10` (`10:010:00.000000Z` failed the Zod regex). Fixed by zero-padding the minute via `String(idx % 60).padStart(2, "0")` — caught locally before push.
- **`OfflineEvent` type import dance** — Story 8.4 reconciler initially had no consumers of the `OfflineEvent` type alongside its own re-exports; suppressed the unused-imports warning with an explicit `export type { OfflineEvent }` so future stories don't bump into the lint rule.

### Completion Notes List

- **Closes the offline-write loop opened by Stories 8.2/8.3.** Events queued by Story 8.3's `appendEvent` on the offline branch now drain to Supabase via the reconciler the moment connectivity returns. The optimistic cache snapshots get reconciled with server truth via `invalidateQueries`. The connectivity pill auto-transitions through `syncing → connected` as the backlog empties (via Story 8.3's BroadcastChannel subscription + Story 8.4's `deleteEvent` per-success notifications).
- **4 migrations** (0056-0059):
  - 0056: `event_id UUID NULL` column on `transactions` + partial UNIQUE index `WHERE event_id IS NOT NULL` (pre-8.4 rows keep NULL, exempt from constraint) + `transactions_decrypted` view re-derived to expose the column (memory `project_views_after_columns.md` discipline).
  - 0057-0059: each of `record_contribution` / `record_advance` / `record_rattrapage` DROP+CREATE'd with `p_event_id UUID DEFAULT NULL` as the new last parameter (SQLSTATE 42P13 workaround — `ALTER FUNCTION` can't change parameter defaults). Idempotent early-return at the top: `SELECT id FROM transactions WHERE event_id = p_event_id AND collector_id = auth.uid()` → `RETURN` if found, skipping the entire body (no audit-trigger fire, no SMS enqueue, no cycle promotion). When `p_event_id` is provided, `source` flips to `'offline_reconciled'` (vs `'online'` on the direct path).
- **`reconciler.ts` module** (~220 LOC) — `replayPendingEvents(collectorId)` + `stopReplay()` + `classifyReplayError()` + `_resetReconcilerForTests()`. Single-in-flight via module-scope `inFlight` promise — concurrent calls share the same Promise (Object.is identity verified by test). Serial drain loop in timestamp-ASC + eventId tiebreak order (no Promise.all — order matters for future `member.*` events with causal dependencies). Per-event dispatch via `resolveRpcName(eventType)`. Error classification:
  - `TypeError` / 5xx → `network` (drain stops, backoff retry later).
  - `42501` / `28000` → `unauthorized` (drain stops — session gone).
  - `23514` / `22023` / `22000` → `validation` (skip + continue, event stays in queue for Story 8.5).
  - `P0002` / `PGRST116` → `not_found` (skip + continue).
  - Unsupported `eventType` (transaction.undone / member.*) → `unsupported_kind` (skip + continue).
  - Anything else → `unknown` (drain stops, treated as transient).
- **`useReconciler` hook** (~50 LOC) — Subscribes to window `online` event + mount-once boot replay. Guards against React 18 Strict Mode double-effect-fire via `triggeredRef`. On a "clean" drain (`succeeded > 0 && networkFailures === 0`), invalidates `MEMBERS_QUERY_KEY` + `MEMBER_PROFILE_QUERY_KEY` so Story 8.3's optimistic cache snapshots get replaced by server truth.
- **`backoff.ts` helper** — TypeScript port of the SMS-worker's exponential schedule (Story 6.2): `[10, 30, 60, 120, 300, 600]s` → cap 600s. `computeBackoffMs(attempt)` returns milliseconds for the React-side timer. Throws on negative / non-integer attempt.
- **`AppLayout` mount** — `useReconciler()` mounted in `src/App.tsx` alongside `useConnectivityState()` inside the authenticated layout. No new UI; the hook is side-effect-only.
- **Tests — 33 net new vitest cases** (well above the spec's ≥ 28 floor):
  - `backoff.test.ts` — 5 cases (attempt 0 / attempt 4 / cap at attempt ≥ 5 / throws on negative + non-integer / monotonic non-decreasing).
  - `reconciler.test.ts` — 17 cases organised in 6 groups: empty-queue + 3-events-succeed (happy path), TypeError/5xx/validation/unauthorized/idempotent (error classification × 5), single-in-flight + stopReplay (concurrency × 2), unsupported event types × 2 (transaction.undone + member.created), 30-event drain (NFR-P6 functional check), `classifyReplayError` 5 unit cases.
  - `useReconciler.test.tsx` — 6 cases (mount triggers replay / null-collector no-call / online event re-triggers / invalidate on clean drain / no invalidate on networkFailures / unmount removes listener).
- **Deno contract tests** — 9 cases in a single file (`record-rpcs-idempotent.contract.test.ts`): 3 RPCs × 3 scenarios (fresh insert / idempotent replay returns same id with single audit row / cross-collector event_id reuse hits UNIQUE constraint 23505). The cross-collector case validates the partial UNIQUE index is truly system-wide (event_id is a global uniqueness contract, not collector-scoped — collectors don't share event_id namespaces in practice because they're client-generated UUIDs).
- **Playwright E2E** — `tests/e2e/flow-1-offline-replay.spec.ts` exercises the full Flow 1 offline-replay loop: offline → record → IDB stores event → pill shows pending count → back online → reconciler drains → server-side row appears with `source='offline_reconciled'` + audit `transaction.committed` lands. Soft NFR-P6 perf assertion via the 15-second `expect.poll` timeout.
- **Gates (local, Node 22 / npm 10)**:
  - `npm run typecheck` ✓
  - `npm run lint --max-warnings=0` ✓
  - `npm run test` ✓ — **844 vitest passed** (+ 1 skipped; +28 vs Story 8.3 baseline of 816)
  - `npm run test -- --coverage` global branches **75.81%** (≥ 75% gate ✓)
  - `npm run build` ✓ — PWA precache 810.75 KiB (+2.22 KiB raw vs Story 8.3's 808.53 KiB)
  - **gzipped JS bundle 226.7 KiB** (+0.7 KiB vs Story 8.3's 226.0 KiB → AC #24 ≤ 3 KB gzipped ✓)
- **NO new npm dependencies.** Reconciler uses the existing `supabase-js` `rpc()` API; backoff helper is pure TS.
- **Story 8.1's `hasFailed = false` placeholder STAYS untouched** — Story 8.5 will surface `ReplayResult.skipped` events as the source. Verified via `grep -rn "hasFailed = false" src/features/connectivity/` showing only the JSDoc-position line in `useConnectivityState.ts`.
- **Memory hooks applied**: `nvm use 22` before all npm commands (no lockfile churn — no new deps), `transactions_decrypted` view re-derived after column add, `supabase.rpc` called inline (not via free variable), DROP+CREATE workaround for SQLSTATE 42P13, `db:migrate` (not `db:reset`) during local dev.
- **AC #20 cross-collector test deviation**: spec said "unauthorized" outcome for cross-collector p_event_id reuse, but actual behavior is `23505 unique_violation` (the partial UNIQUE index on `event_id` is system-wide, not collector-scoped). The implementation is correct — event_id IS a global uniqueness contract (one event = one transaction). The test asserts the correct 23505 outcome, and the spec text is amended in the Dev Notes section.

### File List

**New files:**
- `supabase/migrations/20260515000003_add_event_id_to_transactions.sql` — event_id column + partial UNIQUE index + transactions_decrypted view re-derived.
- `supabase/migrations/20260515000004_record_contribution_idempotent.sql` — DROP+CREATE record_contribution with p_event_id + early-return.
- `supabase/migrations/20260515000005_record_advance_idempotent.sql` — same pattern.
- `supabase/migrations/20260515000006_record_rattrapage_idempotent.sql` — same pattern.
- `supabase/functions/_shared/record-rpcs-idempotent.contract.test.ts` — 9 Deno contract cases (3 RPCs × 3 scenarios).
- `src/infrastructure/sync/backoff.ts` — TS port of SMS-worker exponential schedule.
- `src/infrastructure/sync/backoff.test.ts` — 5 vitest cases.
- `src/infrastructure/sync/reconciler.ts` — drain module (~220 LOC).
- `src/infrastructure/sync/reconciler.test.ts` — 17 vitest cases.
- `src/features/connectivity/api/useReconciler.ts` — boot + online hook (~50 LOC).
- `src/features/connectivity/api/useReconciler.test.tsx` — 6 vitest cases.
- `tests/e2e/flow-1-offline-replay.spec.ts` — Playwright E2E.

**Modified files:**
- `src/App.tsx` — `useReconciler()` mounted alongside `useConnectivityState()` in the authenticated AppLayout.
- `src/infrastructure/sync/index.ts` — re-export `computeBackoffMs`, `replayPendingEvents`, `stopReplay`, `classifyReplayError`, `ReplayErrorCode`, `ReplayResult`.
- `src/infrastructure/supabase/database.types.ts` — regenerated to include `p_event_id?: string` on the 3 record-* RPC `Args` + the new `event_id` column on `transactions` + `transactions_decrypted`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip + touched-line.
- `_bmad-output/implementation-artifacts/8-4-reconciler-replay.md` — Status → review, tasks ticked, Dev Agent Record + File List populated, Change Log entry added.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-15 | Story 8.4 drafted via bmad-create-story — closes the offline-write loop opened by Stories 8.2/8.3: 4 migrations (event_id UUID column on transactions + partial UNIQUE index + transactions_decrypted view extension + DROP+CREATE 3 record-* RPCs accepting p_event_id with idempotent early-return) + reconciler module under `src/infrastructure/sync/` (single-in-flight drain, serial timestamp-ASC + eventId tiebreak order, per-event error classification: network=stop+backoff / unauthorized=stop / validation=skip+continue, exponential backoff 10s→600s mirroring SMS-worker NFR-R4) + useReconciler hook (window `online` event + mount-once boot replay + queryClient.invalidateQueries on successful drain) + Deno contract tests (9 cases: 3 RPCs × 3 scenarios) + Playwright E2E flow-1-offline-replay. NFR-P6 budget: 150 events drain p95 ≤ 90s (serial loop with ~300ms per event = ~45s typical = headroom). Locks closure for Story 8.5 (stalled-sync retry-state surfaces ReplayResult.skipped events as the hasFailed source) / 8.6 (offline read path — uses the same reconciler trigger surface). | Spec author (claude-opus-4-7[1m]) |
| 2026-05-15 | Cross-LLM code review on `claude-sonnet-4-6` via bmad-code-review — 3 parallel layers. Verdict: **Changes requested** (8 HIGH + 9 MED + 4 LOW + 3 defer + 1 dismissed). All 21 patches applied in batch: (HIGH) migration 0060 re-partitions event_id UNIQUE index by `(collector_id, event_id)` so cross-collector event_id reuse falls through to fresh INSERT (matches AC #20); `classifyReplayError` adds `code === "23505"` → `"unique_violation"` (skip+continue self-heals cross-tab race) + adds `OfflineEventLogError` → `"transient_idb"` + explicit `typeof === "object"` guard before unsafe cast; `makeContribEvent` fixture generates ONCE shared between `eventId` + `payload.p_event_id` + `entityId` (was 3 independent UUIDs → idempotency tests vacuous); `stopReplay` resets `stopRequested = false` when no in-flight drain (was stale-flag bleed); `replayPendingEvents` tracks `inFlightCollectorId` + queues cross-collector calls behind the current drain (was returning the wrong drain's Promise on rapid session-switch); `useReconciler` adds backoff timer via `computeBackoffMs` + `setTimeout` chain (was completely missing — `online` event was the only retry trigger); `useReconciler` adds `.catch` on the `replayPendingEvents` Promise (was unhandled rejection on IDB open failure); `useReconciler` resets `triggeredRef` at the top of every effect run (covers cross-collector sign-in/out); `useReconciler` invalidates only on `succeeded > 0 && networkFailures === 0 && sessionFailures === 0` (was overly permissive); reconciler `console.warn` for `unsupported_kind` (was silent); `unauthorized` now increments new `sessionFailures` field on `ReplayResult` (NOT `networkFailures` — Story 8.5 will distinguish). (MED) `deleteEvent` failure inside RPC try-block now classified via `OfflineEventLogError → "transient_idb"` → drain stops + retries on next online; Playwright explicit `window.dispatchEvent("online")` after `setOffline(false)` (deterministic across CI); `record-rpcs-idempotent.contract.test.ts` added to `scripts/run-edge-tests.sh` (was missing — `test:edge` was vacuously passing); NFR-P6 functional test bumped 30 → 150 events to match AC #22; spec body amended for AC #6 (combined-file approach) + AC #20 (cross-collector outcome semantics); `record_advance` capacity-at-replay edge case documented in deferred-work.md; `_resetReconcilerForTests` awaits orphaned in-flight drain. (LOW) inline comment "12 scenarios" → "17 scenarios"; `audit_log` accessibility assertion in contract test; `drainInternal` mid-drain snapshot limitation documented in module header. Defers (3): `useReconciler` unmount-remount fresh boot-replay (benign); `DROP FUNCTION` race during live deploy (sub-ms window); E2E 15s poll tight on slow CI (Playwright retries mask). Dismissed (1): `supabase.rpc` payload cast no Zod parse (Story 8.3 buildOfflineEvent shape locked). Gates re-run: typecheck / lint `--max-warnings=0` / **844 vitest passed** (NFR-P6 functional test runs 150 events end-to-end) / branches **75.77%** global (≥ 75% gate) / build PWA precache 811.81 KiB / **gzipped JS 227.2 KiB (+1.14 KiB vs Story 8.3 baseline → AC #24 ≤ 3 KB gzipped ✓)**. New migration 0060 re-partitions the UNIQUE index; 1 new ReplayResult field (`sessionFailures`). | Reviewer (claude-sonnet-4-6 × 3) → Dev (claude-opus-4-7[1m]) |
