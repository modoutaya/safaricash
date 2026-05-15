# Story 8.5: Stalled-sync alert with manual retry

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector**,
I want **to be notified when a pending operation has been stuck too long, with a way to manually retry it**,
so that **I can intervene before a sync delay becomes a problem (FR43, NFR-P7).**

> **Predicate of this story. FIFTH story of Epic 8 (Offline Resilience).** Stories 8.2-8.4 built the offline-write loop: events queue in IndexedDB (8.2), the record-* hooks append on the offline branch with optimistic UI (8.3), and the reconciler drains them to Supabase when connectivity returns (8.4). That loop is *silent on failure* — if an event cannot drain (server keeps erroring, session expired, a poisoned validation event), the connectivity pill just sits in `syncing` forever and the collector has no signal and no recourse. Story 8.5 closes that gap.
>
> 1. **Stalled detection.** An event still pending in the local queue **> 15 minutes after reconnection** (NFR-P7 threshold) marks the sync as *stalled*. The detection is time-based and survives an app reload.
> 2. **Visible alert.** `useConnectivityState`'s `hasFailed` placeholder (hardcoded `false` since Story 8.1) becomes a real value. When stalled, the existing `deriveState` already promotes the pill to the `sync-failed` state — copy `connectivity.state.sync_failed` ("Erreur • {count}") and a subtle amber pulse.
> 3. **Manual retry surface.** The `ConnectivitySyncDrawer` skeleton (Story 8.1 shipped title + close + placeholder text) gets its real body: the pending operations listed by member, and a "Retenter" action. Tapping it calls `replayPendingEvents(collectorId)` — the reconciler re-attempts with the current (fresh) auth session.
> 4. **No event-log mutation.** The IndexedDB event log is append-only and immutable by design (Story 8.2, `eventLog.ts` header). Story 8.5 does NOT add fields to `OfflineEvent`. Stalled state is tracked separately (a small persisted marker), and retry simply re-invokes the existing `replayPendingEvents`.
>
> **Pattern alignment with existing infrastructure (DO NOT re-invent):**
> - `replayPendingEvents` / `stopReplay` / `ReplayResult` already exist in `src/infrastructure/sync/reconciler.ts` (Story 8.4) — the retry button is a thin caller, not a new drain implementation.
> - `useConnectivityState.deriveState` already handles the `sync-failed` state and its priority ordering (`offline > sync-failed > syncing > connected`) — Story 8.5 only supplies the real `hasFailed` input.
> - `connectivity.state.sync_failed` + `sync_failed_idle` i18n keys already exist in `fr.json` — no new state-label keys.
> - The `ConnectivitySyncDrawer` `<dialog>` shell, focus management, and open/close shim already exist — Story 8.5 fills the body only.
> - Member-name resolution: read the `MEMBERS_QUERY_KEY` cache (already populated) — do NOT fetch members again.
>
> **What Story 8.5 does NOT ship:**
> - Offline READ path for member search / list / profile / edit (Story 8.6).
> - Push-notification delivery of the stalled-sync warning (PRD Growth "Push Notification Strategy" — out of scope; in-app pill + drawer only).
> - Per-event error-reason detail in the drawer beyond a generic stalled message (the reconciler's `ReplayResult` is aggregate-only; surfacing per-event `lastError` would require new reconciler plumbing — deferred).
> - Background Sync API integration (Growth, same as Story 8.4).
> - Mutating / re-ordering / discarding events from the drawer (no "delete this stuck event" affordance — retry only).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1244-1251`; the rest are spec-derived constraints.

### Stalled detection (15-minute threshold — NFR-P7)

1. **Given** an event pending in the local queue for **> 15 minutes after reconnection**, **When** the sync status is updated, **Then** the sync is classified as *stalled*.
   - "Reconnection" = the transition into an online state while the queue is non-empty (the `window.online` event, OR app boot while `navigator.onLine === true` with a non-empty queue).
   - The threshold is `STALLED_THRESHOLD_MS = 15 * 60 * 1000`, exported as a named constant from the connectivity feature.

2. **Stalled marker is persisted and reload-durable.** When the queue first becomes non-empty *while online*, a `stalledSince` timestamp is recorded (per collector). It is cleared when `pendingCount` reaches 0. The marker persists across an app reload (so a collector who closes and reopens the app does not reset the 15-minute clock) — store it in `localStorage` under a per-collector key (e.g. `safaricash:sync:stalled-since:{collectorId}`).

3. **Stalled predicate.** The sync is stalled when ALL of: `navigator.onLine === true` AND `pendingCount > 0` AND `now - stalledSince >= STALLED_THRESHOLD_MS`. While offline, the sync is NEVER stalled (no network = expected, not an error — UX "offline-as-empowerment", `ux-design-specification.md:72`).

4. **`stalledSince` resets correctly.** Going offline does NOT clear `stalledSince` (the clock pauses conceptually but the marker stays — an event queued, then 20 min offline, then online, is immediately past threshold and that is acceptable: it HAS been pending > 15 min). The marker is cleared ONLY when the queue empties (`pendingCount === 0`) or the collector signs out.

### Connectivity state wiring

5. **`useConnectivityState.hasFailed` becomes real.** Replace the hardcoded `const hasFailed = false` (`useConnectivityState.ts:131`) with the stalled predicate from AC #3. No change to `deriveState` — it already returns `"sync-failed"` when `hasFailed` is true (`useConnectivityState.ts:47`).

6. **State priority preserved.** `deriveState` ordering stays `offline > sync-failed > syncing > connected`. A stalled queue while offline shows `offline` (not `sync-failed`) — AC #3 already guarantees `hasFailed` is false while offline, so this falls out for free; add a regression test.

7. **The pill reflects `sync-failed`.** When stalled, `ConnectivityIndicator` renders the `connectivity.state.sync_failed` copy ("Erreur • {count}", or `sync_failed_idle` "Erreur" when count is 0 — though count is `> 0` whenever stalled per AC #3). Amber Warning palette (`#854F0B` accent on `#FAEEDA`, `ux-design-specification.md:990`).

8. **Subtle pulse animation on the stalled pill.** The `sync-failed` pill has a subtle pulse (`ux-design-specification.md:990` — "subtle pulse"). It MUST respect `prefers-reduced-motion: reduce` (no animation when the user opts out — accessibility). Use a Tailwind `animate-*` utility or a tokenised keyframe; never a JS timer.

### Sync drawer body — pending operations list + retry

9. **Given** the sync is stalled, **When** the collector opens the sync drawer, **Then** the drawer shows the stalled operation(s) with a "Retenter" action.
   - The drawer is opened by tapping the pill (already wired in Story 8.1 — verify the wiring still holds).

10. **Pending operations list.** When `pendingCount > 0`, the drawer body lists the pending events (replace the `connectivity.drawer.placeholder_pending` placeholder text). Each row shows: the operation kind (contribution / advance / rattrapage — human-readable French), the member name, and the recorded time (relative, e.g. "il y a 23 min"). Source the events via `listEvents(collectorId)` from `@/infrastructure/sync`.

11. **Member-name resolution from cache.** Resolve `entityId` / payload `p_member_id` → member name by reading the `MEMBERS_QUERY_KEY` cache via `queryClient.getQueryData`. If a member is not in cache (edge case), fall back to a neutral label (e.g. "Membre"). Do NOT trigger a network fetch.

12. **"Retenter" action.** The drawer shows a "Retenter" CTA (primary button) whenever `pendingCount > 0`. Tapping it calls `replayPendingEvents(collectorId)` (the Story 8.4 reconciler). It re-attempts with the *current* auth session — "fresh context" per the BDD.

13. **When** the collector taps "Retenter", **Then** the reconciler re-attempts the event(s) with fresh context, **And** the button shows an in-progress state (disabled + spinner) for the duration of the drain, **And** on completion the drawer reflects the new queue (rows removed for succeeded events; if the queue empties, the drawer shows `connectivity.drawer.empty` and the stalled state clears).

14. **Retry outcome feedback.** After a retry drain completes:
    - Queue empties (`succeeded` drained everything) → stalled marker cleared, pill returns to `connected`, optional success toast.
    - Queue still non-empty (`networkFailures` / `sessionFailures` / `skipped` remain) → the drawer stays open showing the still-pending rows; the pill stays `sync-failed`. No red alarm — amber, calm copy (UX "never a red alarm", `ux-design-specification.md:475`).
    - `sessionFailures > 0` (session expired, 42501/28000) → surface a distinct hint that the collector must re-authenticate (copy: re-login needed) rather than implying a plain retry will help.

15. **Idempotent / safe re-entry.** Tapping "Retenter" while a drain is already in flight is safe — `replayPendingEvents` is single-in-flight (Story 8.4) and returns the existing promise. The button's disabled-while-pending state (AC #13) is the primary guard; the reconciler's single-flight is the backstop.

### Drawer — `state` prop reinstated

16. **`ConnectivitySyncDrawer` accepts the connectivity `state` prop.** Story 8.4 deliberately omitted it (`ConnectivitySyncDrawerProps` comment). Story 8.5 adds it back: `state: ConnectivityStateValue`. The drawer uses it to decide whether to render the stalled banner (only in `sync-failed`).

17. **Stalled banner inside the drawer.** In the `sync-failed` state, the drawer shows an amber banner above the list explaining the sync is stuck and the collector can retry (copy: stalled explanation). In `syncing` state (pending but not yet stalled) the drawer shows the list WITHOUT the alarming banner — calm "synchronisation en cours" framing. The "Retenter" CTA is present in both `syncing` and `sync-failed` (a collector may want to retry early).

### i18n

18. **New i18n keys** under `connectivity.drawer.*` in `src/i18n/fr.json` (French only — single-locale project). Required keys (names indicative, dev may adjust):
    - `connectivity.drawer.stalled_banner` — the stalled explanation banner copy.
    - `connectivity.drawer.retry_cta` — "Retenter".
    - `connectivity.drawer.retry_in_progress` — in-progress label / aria.
    - `connectivity.drawer.session_expired_hint` — re-auth needed hint (AC #14).
    - `connectivity.drawer.row_kind_contribution` / `_advance` / `_rattrapage` — human-readable operation kinds.
    - `connectivity.drawer.row_recorded_at` — relative-time prefix or pattern.
    - `connectivity.drawer.member_fallback` — "Membre" fallback (AC #11).
    - `connectivity.drawer.retry_success` — success toast/inline copy (AC #14).
    Reuse existing `connectivity.drawer.title` / `empty` / `close_label`. The `placeholder_pending` key MAY be removed (its placeholder text is now replaced by the real list) — if removed, delete it from `fr.json`; if kept, leave it unused-free of references.

19. **i18n key registration.** If the project's `src/i18n/keys.ts` enforces a typed key registry, add the new keys there too (verify the pattern — Story 8.1 added 12 connectivity keys; mirror that).

### Accessibility

20. **Drawer list is screen-reader correct.** The pending list is a semantic list (`<ul>`/`<li>` or `role="list"`). The stalled banner uses `role="status"` + `aria-live="polite"` (informational, not an interruptive `alert` — consistent with the "never a red alarm" UX and Story 4.2 ProgressiveToast's `role` discipline for non-failures... note: this IS a failure, but a soft one — use `status`, not `alert`, to avoid alarming; document the choice).
21. **Retry button accessibility.** The "Retenter" button has an accessible name; its in-progress state is announced (`aria-disabled` + an `aria-live` update or an accessible busy label). Touch target ≥ 44 px (UX NFR-A1, mirrors the pill).
22. **`axe` clean.** The drawer in `syncing` and `sync-failed` states passes `@axe-core/playwright` with zero violations (Story 8.1 set this bar for the connectivity surface).

### Tests

23. **Unit tests — stalled detection** (`useStalledSync.test.ts` or equivalent, vitest + `vi.useFakeTimers()`):
    - Online + non-empty queue + `now - stalledSince < 15min` → NOT stalled.
    - Online + non-empty queue + `now - stalledSince >= 15min` → stalled.
    - Offline + non-empty queue + past threshold → NOT stalled (AC #3).
    - Empty queue → NOT stalled + `stalledSince` cleared from `localStorage`.
    - `stalledSince` persists across a remount (simulate reload — value already in `localStorage`).
    - Sign-out (collectorId → null) clears the marker.
    - Threshold boundary (`=== 15min`) → stalled (inclusive per AC #1 "> 15 min" — pick `>=` and document, or `>` strictly; be consistent with AC #3's `>=`).

24. **Unit tests — `useConnectivityState`** — extend `useConnectivityState.test.ts`: `hasFailed` true → `deriveState` returns `sync-failed`; offline + would-be-stalled → `offline` wins (AC #6).

25. **Unit tests — `ConnectivitySyncDrawer`** — extend `ConnectivitySyncDrawer.test.tsx`:
    - Empty queue → `connectivity.drawer.empty`, no list, no retry CTA.
    - Non-empty + `syncing` → list rendered, retry CTA present, NO stalled banner.
    - Non-empty + `sync-failed` → list + stalled banner + retry CTA.
    - Member name resolved from a seeded `MEMBERS_QUERY_KEY` cache; fallback label when absent.
    - "Retenter" click → `replayPendingEvents` called with the collector id; button disabled during the in-flight promise.
    - `sessionFailures > 0` result → session-expired hint rendered.

26. **Playwright E2E** — extend or add to `tests/e2e/`: a stalled-sync flow. Because waiting 15 real minutes is infeasible, the `STALLED_THRESHOLD_MS` MUST be overridable by the test. Provide a documented test seam: `useStalledSync` reads an override from `localStorage` key `safaricash:e2e:stalled-threshold-ms` when present, else the 15-min default. The E2E:
    - Sign in, go offline (`context.setOffline(true)`), record a contribution → pill `offline • 1`.
    - Set the threshold override to a small value (e.g. 1500 ms) via `page.evaluate(localStorage.setItem(...))`.
    - Go online (`context.setOffline(false)` + dispatch `online`) but with the reconciler unable to drain (simulate: keep the server unreachable, OR use a poisoned event) so the queue stays non-empty.
    - Wait past the (tiny) threshold → assert pill transitions to `sync-failed` ("Erreur").
    - Open the drawer → assert the stalled banner + the pending row + "Retenter".
    - Tap "Retenter" with the server now reachable → assert the queue drains, pill returns to `connected`.
    - **Pre-push memory**: verify the E2E offline event-dispatch pattern from `flow-1-offline-replay.spec.ts` (explicit `window.dispatchEvent(new Event("offline"/"online"))` after `context.setOffline`, AND `networkMode: "always"` already lets the offline branch run — see memory `feedback_tanstack_networkmode_offline.md`).

### Architecture, dependencies, hygiene

27. **No new npm dependencies.** Everything needed (`localStorage`, `replayPendingEvents`, TanStack Query cache reads, Tailwind animation utilities) is already present.

28. **Bundle delta budget ≤ 3 KB gzipped** (consistent with Stories 8.1-8.4 — `useStalledSync` hook ~60 LOC + drawer body ~120 LOC + i18n keys).

29. **Layering.** `useStalledSync` lives in `src/features/connectivity/api/`. It may import from `@/infrastructure/sync` (`countEvents` / `listEvents`) and `@/features/auth/api/useCollectorId` (cross-feature, precedent set in Stories 8.3/8.4). The drawer stays in `src/features/connectivity/ui/`. No `src/infrastructure/` changes expected (the event log stays immutable — AC #4 of the predicate).

30. **All gates green**:
    - `npm run typecheck` — strict clean.
    - `npm run lint --max-warnings=0` — clean (no hard-coded hex — use tokens; the amber palette is already tokenised from Story 8.1).
    - `npm run test -- --coverage` — global ≥ 75 % branches preserved; new `useStalledSync` ≥ 85 % branches isolated.
    - `npm run build` — bundle delta ≤ AC #28.
    - `npx playwright test` — new stalled-sync flow + existing Flow 1/2/3 + `flow-1-offline-replay` unchanged.
    - **Pre-push memory**: `nvm use 22` (`feedback_npm_lockfile_node_version.md`); coverage locally before push (`feedback_run_coverage_locally.md`); grep stale assertions (`feedback_push_then_ci_failure.md`); run the full Playwright suite locally before push (`feedback_tanstack_networkmode_offline.md` — offline behavior is not caught by mocked-guard unit tests).

## Tasks / Subtasks

- [x] **Task 1 — `useStalledSync` hook + `STALLED_THRESHOLD_MS` constant** (AC: #1-#4, #26 test seam)
  - New `src/features/connectivity/api/useStalledSync.ts` (~60-80 LOC).
  - Export `STALLED_THRESHOLD_MS = 15 * 60 * 1000`.
  - Track `stalledSince` in `localStorage` per collector; set when online+non-empty, clear when empty / sign-out.
  - Derive the stalled boolean per AC #3; re-evaluate on a timer (the threshold boundary needs an active re-check — use a `setTimeout`/`setInterval` that fires when the threshold would be crossed, cleaned up on unmount).
  - Test seam: read `localStorage["safaricash:e2e:stalled-threshold-ms"]` override if present.

- [x] **Task 2 — Wire `hasFailed` into `useConnectivityState`** (AC: #5, #6)
  - Replace `const hasFailed = false` with the `useStalledSync` result.
  - Keep `deriveState` untouched; add regression tests for the offline-wins-over-stalled priority.

- [x] **Task 3 — Pulse animation on the `sync-failed` pill** (AC: #8)
  - Add a subtle pulse to `ConnectivityIndicator` for the `sync-failed` state.
  - Respect `prefers-reduced-motion: reduce` (Tailwind `motion-reduce:` variant or a media query).

- [x] **Task 4 — `ConnectivitySyncDrawer` body: pending list + retry** (AC: #9-#17)
  - Add the `state: ConnectivityStateValue` prop back to `ConnectivitySyncDrawerProps`.
  - Render the pending-operations list (via `listEvents`), member names from the `MEMBERS_QUERY_KEY` cache.
  - Stalled banner (only in `sync-failed`).
  - "Retenter" CTA → `replayPendingEvents(collectorId)`; in-progress disabled+spinner state; outcome feedback (AC #14).
  - Update the `ConnectivityIndicator` call-site to pass `state` to the drawer.

- [x] **Task 5 — i18n keys** (AC: #18, #19)
  - Add the new `connectivity.drawer.*` keys to `src/i18n/fr.json`.
  - Register in `src/i18n/keys.ts` if a typed registry exists.
  - Remove `placeholder_pending` if fully unreferenced.

- [x] **Task 6 — Unit tests** (AC: #23, #24, #25)
  - `useStalledSync` threshold + persistence + sign-out + boundary cases (`vi.useFakeTimers()`).
  - `useConnectivityState` `hasFailed`-true + offline-priority regression.
  - `ConnectivitySyncDrawer` empty / syncing / sync-failed / retry-click / session-expired.

- [x] **Task 7 — Playwright E2E** (AC: #26)
  - Stalled-sync flow with the `STALLED_THRESHOLD_MS` test seam.
  - `axe` assertions on the drawer in `syncing` + `sync-failed` (AC #22).

- [x] **Task 8 — Gate run + sprint hygiene** (AC: #30)
  - All gates green locally on Node 22 / npm 10; full Playwright suite locally before push.
  - Update `sprint-status.yaml`: `8-5-stalled-sync-alert` `ready-for-dev → review`.
  - Update `last_updated` + touched line.

## Review Findings

Cross-LLM code review on 2026-05-15 (claude-sonnet-4-6, 3 parallel layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). Triage: 10 patch, 1 defer, 7 dismissed.

- [x] [Review][Patch] `retrySucceeded` shows the success banner on a PARTIAL drain — `succeeded > 0` true even when `networkFailures`/`skipped` remain; gate on `networkFailures === 0 && skipped === 0` [src/features/connectivity/ui/ConnectivitySyncDrawer.tsx — `retrySucceeded`] (blind+edge+auditor; AC #14)
- [x] [Review][Patch] `retryResult` / `events` / `loadedAt` never reset on drawer close → a stale session-expired hint or success banner shows on the next open [src/features/connectivity/ui/ConnectivitySyncDrawer.tsx] (blind+edge)
- [x] [Review][Patch] AC #22 — E2E uses `jest-axe` (component-level) instead of the spec-mandated `@axe-core/playwright`; the Dev Agent Record claim "no E2E uses @axe-core/playwright" is factually wrong (`tests/e2e/fixtures/axe.ts` exists and is used). Add an axe assertion to the E2E via the existing fixture + correct the record [tests/e2e/flow-8-stalled-sync.spec.ts] (auditor; AC #22)
- [x] [Review][Patch] `resolveThresholdMs` accepts a `0` override (`parsed >= 0`) → a stray `safaricash:e2e:stalled-threshold-ms="0"` forces instant `sync-failed`; require `parsed > 0` [src/features/connectivity/api/useStalledSync.ts] (edge)
- [x] [Review][Patch] `loadedAt === 0` initial state → every pending row renders "à l'instant" until `listEvents` resolves, regardless of true age; guard `recordedLabel` for `loadedAt === 0` [src/features/connectivity/ui/ConnectivitySyncDrawer.tsx] (edge)
- [x] [Review][Patch] AC #13 — the empty-state branch is gated only on the `pendingCount` prop, not local `events`; after a full-success retry there is a window where the non-empty branch renders with an empty list. Gate the empty state on `pendingCount === 0 || events.length === 0` [src/features/connectivity/ui/ConnectivitySyncDrawer.tsx] (auditor; AC #13)
- [x] [Review][Patch] AC #5 — the Story 8.1 "outline Fermer button fires onOpenChange(false) exactly once" test was dropped in the drawer test rewrite and not replaced; re-add it [src/features/connectivity/ui/ConnectivitySyncDrawer.test.tsx] (auditor)
- [x] [Review][Patch] Missing unit test — retry success → drawer empty-state transition + assert the refreshed (drained) list [src/features/connectivity/ui/ConnectivitySyncDrawer.test.tsx] (auditor+blind; AC #25)
- [x] [Review][Patch] E2E threshold-override timing (edge E6) — investigated + the proposed fix REJECTED: moving the `setItem` after reconnection breaks the test because `useStalledSync` reads the threshold once per effect run (not reactively from localStorage), so a post-reconnection change is never picked up. The threshold stays set early (before the offline write); the offline guard keeps the pill calm until reconnection anyway. Instead the genuine E2E flake — `page.unroute` not deterministically removing the replay block before the reconciler / manual retries fired — was fixed by gating replay on a mutable `blockReplay` flag the route handler reads per-request (synchronous flip, no unroute race). Verified 3× green. [tests/e2e/flow-8-stalled-sync.spec.ts]
- [x] [Review][Patch] `useStalledSync` test "initial pendingCount 0 … does NOT clear an existing marker" asserts only localStorage, not the returned `result.current`; add the boolean assertion [src/features/connectivity/api/useStalledSync.test.ts] (blind)
- [x] [Review][Defer] `handleRetry` has no cancellation guard if `collectorId` changes mid-retry (sign-out during a drain) → a stale replay result could render for a freshly signed-in collector [src/features/connectivity/ui/ConnectivitySyncDrawer.tsx] — deferred, low-probability (sign-out mid-drain); a cancellation flag is non-trivial; filed in deferred-work.md
- Dismissed (7): flip-timer "stale closure" (cleanup is correct — FUD); `flush()` test-mechanism coupling (FUD); `kindKey` default branch untested (defensive dead path — `member.*`/`undone` are not queued by the record-* hooks); `memberName` via `getQueryData` not cache-subscribed (spec-mandated by AC #11 — "read the cache, no fetch"); E2E `count === 2` "vacuous" (false positive — `seedMembersForCollector` seeds 1 contribution, identical to flow-1-offline-replay's verified baseline); i18n `{minutes}` interpolation syntax (false positive — project uses `{x}`, see `connectivity.state.syncing`); `row_recorded_at` key name (spec AC #18 explicitly says "names indicative, dev may adjust").

## Dev Notes

### Why a separate persisted marker, not an `OfflineEvent` field

The IndexedDB event log is append-only and immutable by design — `eventLog.ts`'s header explicitly says "8.5 may introduce a parallel retry-state store; this canonical event log stays immutable." Adding `attempts` / `lastError` / `stalledSince` to `OfflineEvent` would mean mutating persisted rows, which breaks that contract and complicates the Zod schema. The stalled state is *derived* (online + non-empty + elapsed) and only needs ONE persisted scalar per collector: `stalledSince`. `localStorage` is the right store for a single reload-durable timestamp — no new IndexedDB object store, no schema version bump.

### Why time-based detection (not per-event attempt counting)

The epic AC is explicitly a *time* threshold ("pending for > 15 minutes after reconnection"), not an attempt count. The reconciler already retries with exponential backoff (Story 8.4). Story 8.5's job is to notice that the *backlog as a whole* is not clearing, not to forensically analyse each event. A global `stalledSince` per collector is sufficient and matches NFR-P7's intent ("unacknowledged pending-sync state").

### Why "Retenter" is just `replayPendingEvents`

"Fresh context" in the BDD means a fresh auth session + a fresh RPC attempt. `replayPendingEvents` already reads the live `supabase` client (current session) and re-drains the queue. There is no separate "retry one event" API and we should not build one — the reconciler drains the whole queue serially, and a single stuck event at the head will be re-attempted first. Single-in-flight (Story 8.4) makes a double-tap safe.

### Stalled detection interacts with the reconciler's own backoff

`useReconciler` (Story 8.4) already schedules backoff retries (10 s → 600 s cap) after a failed drain. Story 8.5 does NOT replace or duplicate that — the reconciler keeps auto-retrying in the background. Story 8.5 only adds the *visible* 15-minute escalation + the *manual* override. A manual "Retenter" tap should ideally also reset the reconciler's backoff attempt counter so the next auto-retry is prompt — but `useReconciler`'s `attemptRef` is internal. Keep it simple: the manual retry calls `replayPendingEvents` directly; if it succeeds the queue empties and everything resets naturally. Do NOT try to reach into `useReconciler`'s internals.

### Reduced-motion discipline

The pulse animation MUST honour `prefers-reduced-motion`. Tailwind's `motion-reduce:` variant (`motion-reduce:animate-none`) is the project pattern. A pulsing element with no reduced-motion guard is an accessibility regression — and the connectivity surface is held to `axe`-clean (Story 8.1).

### `role="status"` not `role="alert"` for the stalled banner

The stalled banner is a *failure*, but the product's UX invariant is "never a red alarm" (`ux-design-specification.md:475`, `:72`). An `role="alert"` interrupts the screen-reader user; `role="status"` + `aria-live="polite"` announces calmly. This mirrors Story 4.2's ProgressiveToast, which uses `alert` ONLY for the hard `failed` state and `status` for everything else. Document the choice inline.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| Drain / retry the queue | `replayPendingEvents` — `@/infrastructure/sync` (Story 8.4) |
| Queue length | `countEvents(collectorId)` — `@/infrastructure/sync` (Story 8.2) |
| List queued events for the drawer | `listEvents(collectorId)` — `@/infrastructure/sync` (Story 8.2) |
| Live pending count + BroadcastChannel refresh | `useConnectivityState` (Story 8.1/8.3) — already subscribes |
| Current collector id | `useCollectorId` — `@/features/auth/api/useCollectorId` (Story 8.3) |
| `sync-failed` state derivation + priority | `deriveState` in `useConnectivityState.ts` (Story 8.1) — already done |
| Drawer `<dialog>` shell, focus, open/close | `ConnectivitySyncDrawer` (Story 8.1) — fill the body only |
| Member names | `MEMBERS_QUERY_KEY` cache via `queryClient.getQueryData` (`@/features/member`) |
| Button + spinner | `@/components/ui/button` + `lucide-react` `Loader2` (Story 4.2 ProgressiveToast precedent) |
| Amber Warning palette tokens | `tailwind.config.ts` (warning-* tokens, Story 8.1 re-skinned the pill) |

### Anti-patterns to avoid (memory + spec-fidelity)

- **DO NOT** add fields to `OfflineEvent` / mutate IndexedDB event rows — the log is immutable (predicate AC #4).
- **DO NOT** build a new "retry single event" reconciler path — re-use `replayPendingEvents` (drains the whole queue).
- **DO NOT** change `deriveState` — it already handles `sync-failed` + priority.
- **DO NOT** hard-code the amber hex — use the tokenised Warning palette (ESLint blocks SafariCash hex in `src/`, per `CLAUDE.md`).
- **DO NOT** use `role="alert"` for the stalled banner — `role="status"` (see Dev Notes).
- **DO NOT** ship the pulse without a `prefers-reduced-motion` guard.
- **DO NOT** run `npm install` on Node 24 / npm 11 — `nvm use 22` first (`feedback_npm_lockfile_node_version.md`).
- **DO NOT** trust mocked-guard unit tests for offline behavior — run the full Playwright suite locally before push (`feedback_tanstack_networkmode_offline.md`).
- **DO NOT** use a fixed `setTimeout` to wait for BroadcastChannel messages in tests — poll-with-deadline (`feedback_broadcastchannel_test_timing.md`).

### Pre-push checklist (per `feedback_push_then_ci_failure.md`)

1. `npm run typecheck` ✓
2. `npm run lint --max-warnings=0` ✓
3. `npm run test -- --coverage` — global ≥ 75 % branches; `useStalledSync` ≥ 85 % isolated
4. `npm run build` — clean; bundle ≤ AC #28
5. `npx playwright test` — full suite, locally, Node 22 (new stalled-sync flow + `flow-1-offline-replay` + Flow 1/2/3 unchanged)
6. Grep for stale assertions: `grep -rn "hasFailed = false" src/features/connectivity/` (should now match nothing — the placeholder is gone)
7. `nvm use 22` active before any `npm install` (none expected — no new deps)

### Project structure notes

**New files:**
- `src/features/connectivity/api/useStalledSync.ts`
- `src/features/connectivity/api/useStalledSync.test.ts`
- `tests/e2e/flow-8-stalled-sync.spec.ts` (or extend an existing connectivity E2E — dev's call)

**Modified files:**
- `src/features/connectivity/api/useConnectivityState.ts` — `hasFailed` becomes real (AC #5).
- `src/features/connectivity/api/useConnectivityState.test.ts` — `hasFailed`-true + offline-priority tests.
- `src/features/connectivity/ui/ConnectivitySyncDrawer.tsx` — body: list + banner + retry; `state` prop reinstated.
- `src/features/connectivity/ui/ConnectivitySyncDrawer.test.tsx` — list / banner / retry / session-expired tests.
- `src/features/connectivity/ui/ConnectivityIndicator.tsx` — pulse on `sync-failed`; pass `state` to the drawer.
- `src/features/connectivity/ui/ConnectivityIndicator.test.tsx` — pulse + drawer-prop assertions.
- `src/i18n/fr.json` — new `connectivity.drawer.*` keys.
- `src/i18n/keys.ts` — register new keys (if a typed registry exists).
- `src/features/connectivity/index.ts` — export `useStalledSync` / `STALLED_THRESHOLD_MS` if other features need them (probably internal only — check the barrel pattern).
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

### Testing standards

- Vitest + React Testing Library; `vi.useFakeTimers()` for the 15-minute threshold logic.
- `fake-indexeddb` polyfill (already in `vitest.setup.ts`) for `listEvents` / `countEvents`.
- Playwright for the E2E stalled-sync flow + `@axe-core/playwright` for the drawer.
- Coverage gate: ≥ 75 % branches globally; `useStalledSync` ≥ 85 % branches isolated.
- 100 % domain gate unaffected (no `src/domain/` changes).

### Definition-of-done checklist

- All 30 ACs satisfied + all 8 tasks ticked.
- `hasFailed` is a real value; the `Story 8.1 placeholder` comment is gone.
- The pill escalates to `sync-failed` after 15 min (test seam proven in the E2E).
- The drawer lists pending operations by member + a working "Retenter".
- Pulse respects `prefers-reduced-motion`; drawer is `axe`-clean.
- All gates green on Node 22 / npm 10; full Playwright suite run locally before push.
- Story status `review`; sprint-status updated; touched-line updated.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`react-hooks/purity` — `Date.now()` during render.** First lint run flagged `Date.now()` called synchronously in render in both `useStalledSync` (the derived predicate) and `ConnectivitySyncDrawer` (`const now = Date.now()`). Fixed: `useStalledSync` became fully `useState`-driven with all `setStalled` calls dispatched from `setTimeout` callbacks (delay 0 to sync the immediate value, delay = remaining for the threshold flip) — `Date.now()` now only runs inside the effect body (impure-allowed). The drawer captures `loadedAt` in the `listEvents` `.then()` callback (off-render) and computes relative-time labels against it.
- **`set-state-in-effect`** — avoided by the same setTimeout-callback dispatch pattern (mirrors Story 8.3's `useConnectivityState` which sets `pendingCount` inside a `.then()`).
- **Stalled marker vs transient initial `pendingCount === 0`.** `useConnectivityState` exposes `pendingCount` starting at 0 before the async `countEvents` resolves. Clearing the marker on every observed 0 would reset the 15-minute clock on every app reload (the marker would never survive). Fixed by clearing only on an observed `>0 → 0` transition (tracked via `prevPendingRef`), never on the initial 0.

### Completion Notes List

- **Stalled detection (`useStalledSync`)** — new `src/features/connectivity/api/useStalledSync.ts` (~150 LOC). Time-based: a per-collector `localStorage` marker (`safaricash:sync:stalled-since:{collectorId}`) anchors the NFR-P7 15-minute clock. The marker is written when the outbox first becomes non-empty, survives an app reload, is NOT reset by going offline, and is cleared on an observed drain (`>0 → 0`) or a collector switch / sign-out. `STALLED_THRESHOLD_MS = 15 min` exported; a documented `safaricash:e2e:stalled-threshold-ms` localStorage seam overrides it for the Playwright E2E. The IndexedDB event log stays immutable — NO field added to `OfflineEvent`.
- **`hasFailed` wired** — `useConnectivityState`'s hardcoded `const hasFailed = false` (placeholder since Story 8.1) replaced with `useStalledSync({ online, pendingCount, collectorId })`. `deriveState` untouched — it already promotes the pill to `sync-failed`; offline still wins over a would-be-stalled queue.
- **Pulse reduced-motion guard** — `ConnectivityIndicator` already pulsed the `sync-failed` icon (Story 8.1); added `motion-reduce:animate-none` to the pulse + the syncing spin (accessibility).
- **Sync drawer body** — `ConnectivitySyncDrawer` skeleton filled: the `state` prop was reinstated; the body lists pending operations (`listEvents`) by member (names resolved from the `MEMBERS_QUERY_KEY` cache, neutral fallback), shows a `role="status"` amber stalled banner in `sync-failed` (never `role="alert"` — UX "never a red alarm"), a calm `syncing_hint` in `syncing`, and a "Retenter" CTA that calls `replayPendingEvents(collectorId)` with disabled+spinner in-flight state. Session-expired (`sessionFailures > 0`) shows a re-auth hint; success shows a brief confirmation. `App.tsx` passes `connectivity.state` to the drawer.
- **i18n** — 15 new `connectivity.drawer.*` keys in `fr.json`; the stale `placeholder_pending` key removed. `keys.ts` auto-derives `TranslationKey` from `fr.json` — no manual registration.
- **Tests** — 13 `useStalledSync` cases (threshold / reload-durable marker / offline-never-stalled / drain-clear / initial-0-no-clear / boundary / sign-out / collector-switch / E2E seam / timer flip), `useConnectivityState` extended (3 Story 8.5 wiring cases — stalled→sync-failed, offline-priority, syncing-not-yet), `ConnectivitySyncDrawer` rewritten (11 cases incl. empty / syncing / sync-failed / member-name + fallback / retry-calls-replay / disabled-in-flight / session-expired / jest-axe in syncing+sync-failed), `ConnectivityIndicator` motion-reduce assertion added. Playwright `flow-8-stalled-sync.spec.ts` — offline write → blocked replay → `sync-failed` pill → drawer banner + "Retenter" → unblock → drain → server row + `connected`.
- **Gates (local, Node 22 / npm 10)**: `typecheck` ✓ · `lint --max-warnings=0` ✓ · `npm run test --coverage` **863 vitest passed** (+19 vs Story 8.4 baseline of 844; +1 skipped) · global branches **76.12%** (≥ 75% gate ✓) · `useStalledSync.ts` isolated **93.75% branches** (≥ 85% gate ✓) · `build` PWA precache 816.61 KiB · Playwright: `flow-8-stalled-sync` ✓ + `flow-1-offline-replay` ✓ + Flow 1/2/5/6 + rls-isolation ✓ (the 2 failures — `flow-3-cycle-settlement`, `receipt-url-worker` — are local-env-only: the wrangler workers are not running locally; CI starts them. Identical to the Story 8.4 local run; unrelated to this story's connectivity-only changes).
- **AC #22 (axe-clean)** — `jest-axe` covers the `syncing` + `sync-failed` drawer states at the component level (`ConnectivitySyncDrawer.test.tsx`), AND the Playwright E2E scans the live `sync-failed` drawer via `@axe-core/playwright` through the shared `tests/e2e/fixtures/axe.ts` `expectNoA11yViolations` helper (added in code review — the spec mandates `@axe-core/playwright`).
- **NO new npm dependencies. NO migration / Edge Function / `src/domain` change. NO `OfflineEvent` mutation.**

### File List

**New files:**
- `src/features/connectivity/api/useStalledSync.ts` — stalled-sync detection hook + `STALLED_THRESHOLD_MS`.
- `src/features/connectivity/api/useStalledSync.test.ts` — 13 vitest cases.
- `tests/e2e/flow-8-stalled-sync.spec.ts` — Playwright stalled-sync + manual-retry E2E.

**Modified files:**
- `src/features/connectivity/api/useConnectivityState.ts` — `hasFailed` wired to `useStalledSync` (placeholder removed).
- `src/features/connectivity/api/useConnectivityState.test.ts` — `localStorage.clear()` in beforeEach; stale placeholder test renamed; 3 Story 8.5 wiring tests added.
- `src/features/connectivity/ui/ConnectivitySyncDrawer.tsx` — body filled: `state` prop, pending list, stalled banner, "Retenter" CTA.
- `src/features/connectivity/ui/ConnectivitySyncDrawer.test.tsx` — rewritten for the Story 8.5 body (11 cases).
- `src/features/connectivity/ui/ConnectivityIndicator.tsx` — `motion-reduce:animate-none` on the pulse + spin.
- `src/features/connectivity/ui/ConnectivityIndicator.test.tsx` — reduced-motion assertion added.
- `src/App.tsx` — passes `state={connectivity.state}` to `ConnectivitySyncDrawer`.
- `src/i18n/fr.json` — 15 new `connectivity.drawer.*` keys; `placeholder_pending` removed.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip + touched line.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1238-1251 (Story 8.5 BDD), 1177-1236 (Stories 8.1-8.4 — what 8.5 consumes).
- **PRD:** `prd.md` — FR43 (system alerts when a pending transaction has not synchronized within the NFR threshold and offers a manual retry action), FR41 (persistent connectivity indicator + pending count), NFR-P7 (stalled-sync alert threshold = 15 min; "Growth for the alert UI; MVP tracks the state but does not alert" — Story 8.5 IS that Growth alert UI).
- **Architecture:** `architecture.md` lines 367-371 (`src/infrastructure/sync/` offline module), 637-643 (retry strategies — "Transaction writes: automatic on network recovery; user can manually retry via toast action after NFR-P7 threshold"), 378 (TanStack Query + React Context state split), 426 (every screen has the connectivity indicator), 1078-1091 (FR40-43 → `src/infrastructure/sync/`).
- **UX spec:** `ux-design-specification.md` line 990 (connectivity indicator `sync-failed` state: amber `#854F0B` on `#FAEEDA` + subtle pulse, label "Erreur • {n}", opens the sync-status drawer with retry CTAs), 1002 ("tap opens a drawer listing pending operations by member with retry affordances"), 475 (sync failure escalates calmly — "retenter" action, "Never a red alarm"), 72 ("offline-as-empowerment"), 505-512 (Warning palette tokens), 1401-1403 ("Every error offers a retry where possible").
- **Story 8.1 (predecessor):** `8-1-connectivity-indicator.md` — `useConnectivityState` + `deriveState` + `ConnectivityIndicator` pill + `ConnectivitySyncDrawer` skeleton + the 12 `connectivity.*` i18n keys.
- **Story 8.3 (predecessor):** `8-3-outbox-pattern-queue.md` — `useCollectorId`, the real `pendingCount` via BroadcastChannel.
- **Story 8.4 (predecessor):** `8-4-reconciler-replay.md` — `replayPendingEvents` / `stopReplay` / `ReplayResult` (`succeeded` / `skipped` / `networkFailures` / `sessionFailures`) / `classifyReplayError`; `useReconciler` (online + boot + backoff triggers).
- **Story 4.2 (toast precedent):** `ProgressiveToast` — `role="alert"` vs `role="status"` discipline; `Loader2` spinner pattern.
- **CLAUDE.md:** tokens not hex; layering `domain ← infrastructure ← features ← components`; `db:migrate` not `db:reset`; no state-management lib.
- **Memory:** `feedback_tanstack_networkmode_offline.md` (offline behavior needs a real E2E — run the full Playwright suite before push), `feedback_npm_lockfile_node_version.md` (Node 22/npm 10), `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`, `feedback_broadcastchannel_test_timing.md`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-15 | Cross-LLM code review via bmad-code-review — claude-sonnet-4-6, 3 parallel layers (Blind Hunter / Edge Case Hunter / Acceptance Auditor). Verdict: 10 patch + 1 defer + 7 dismissed. All 10 patches batch-applied: (1) `retrySucceeded` now requires `networkFailures===0 && skipped===0` (partial drain no longer claims success); (2) `retryResult`/`events`/`loadedAt` reset on drawer close (no stale hint on reopen); (3) AC #22 — `@axe-core/playwright` assertion added to the E2E via the shared `fixtures/axe.ts` helper + the false "no E2E uses axe-core/playwright" claim corrected; (4) `resolveThresholdMs` rejects a `0` override (`parsed > 0`); (5) `recordedLabel` guards `loadedAt===0` (no false "à l'instant"); (6) drawer empty-state gated on `pendingCount===0 || (loadedAt>0 && events.length===0)`; (7) the dropped Story 8.1 outline-Fermer-button test re-added; (8) new test — retry-drains-queue → drawer empty-state; (9) E6 threshold-timing fix REJECTED (post-reconnection `setItem` breaks the test — `useStalledSync` reads the threshold per effect run; the real flake — `page.unroute` non-determinism — was fixed instead via a mutable `blockReplay` route flag, E2E verified 3× green); (10) `useStalledSync` "initial pendingCount 0" test gained the `result.current` assertion. 1 defer (`handleRetry` mid-retry collector-change cancellation guard → deferred-work.md). Gates re-run: typecheck / lint / 865 vitest passed / branches 76.13% / build / full Playwright suite (flow-8 + flow-1-offline-replay green; 2 unrelated local-env worker failures). Status → done. | Reviewer (claude-sonnet-4-6 × 3) → Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Story 8.5 implemented via bmad-dev-story on `feat/8-5-stalled-sync-alert` (Node 22 / npm 10). New `useStalledSync` hook (time-based 15-min NFR-P7 detection, reload-durable per-collector `localStorage` marker, all `setStalled` dispatched from setTimeout callbacks to satisfy react-hooks purity + set-state-in-effect); `useConnectivityState.hasFailed` wired (Story 8.1 placeholder removed); `ConnectivitySyncDrawer` body filled (pending-ops list by member, `role=status` stalled banner, "Retenter" → `replayPendingEvents`); `ConnectivityIndicator` pulse reduced-motion guarded; 15 new i18n keys; Playwright `flow-8-stalled-sync` E2E with the threshold-override seam. Gates: typecheck / lint / 863 vitest passed / branches 76.12% global + 93.75% useStalledSync isolated / build / full Playwright suite (flow-8 + flow-1-offline-replay green; 2 unrelated local-env worker failures). 8 tasks complete, 30 ACs satisfied. Status → review. | Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Story 8.5 drafted via bmad-create-story — FIFTH story of Epic 8 (Offline Resilience). Makes the silent offline-write loop (Stories 8.2-8.4) visible + actionable on failure: time-based stalled detection (15 min after reconnection, NFR-P7) via a new `useStalledSync` hook backed by a single reload-durable `localStorage` marker (the IndexedDB event log stays immutable — no `OfflineEvent` field added); wires `useConnectivityState`'s `hasFailed` placeholder (hardcoded `false` since Story 8.1) to the real stalled predicate so the pill escalates to the existing `sync-failed` state; fills the `ConnectivitySyncDrawer` skeleton body with the pending-operations-by-member list + a "Retenter" CTA that re-invokes Story 8.4's `replayPendingEvents` with the current auth session; subtle amber pulse on the stalled pill (reduced-motion guarded); new `connectivity.drawer.*` i18n keys. NO new deps; NO migration / Edge Function / `src/domain` change. Threshold is test-seam-overridable via a documented `localStorage` key so the Playwright E2E need not wait 15 real minutes. Locks closure for Story 8.6 (offline read path — the last Epic 8 story). | Spec author (claude-opus-4-7[1m]) |
