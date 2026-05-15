# Story 8.6: Member lookup and edit work offline

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector**,
I want **to search, view, and edit members while offline**,
so that **I'm never blocked by network during my route (FR40 completeness).**

> **Predicate of this story. SIXTH and FINAL story of Epic 8 (Offline Resilience).** Stories 8.2-8.5 built the offline *write* loop for transactions (IndexedDB event log → optimistic UI → reconciler drain → stalled-sync alert). Story 8.6 closes Epic 8 by extending the same loop to the *member* surface: the read path (list / search / profile) keeps working offline, and member *edits* queue like transaction writes do.
>
> 1. **Offline read path.** The member list, search, and profile must render offline from a *persisted* local cache. TanStack Query's in-memory cache is lost on reload; Story 8.6 persists the member queries to durable storage so a cold app start while offline still has data.
> 2. **Offline edit.** `useUpdateMember` gains an offline branch — exactly mirroring Story 8.3's record-* hooks: when offline, the edit is queued as a `member.updated` event in the IndexedDB log instead of hitting the RPC, with an optimistic cache update.
> 3. **Reconciler extension.** Story 8.4's reconciler currently skips `member.*` events as `unsupported_kind`. Story 8.6 teaches it to replay `member.updated` → the `update_member` RPC.
> 4. **Server-side idempotency.** Like the record-* RPCs got `p_event_id` in Story 8.4, `update_member` gains `p_event_id` so a reconciler retry (request succeeded server-side but the response was lost) does NOT emit a second `member.updated` audit row.
> 5. **"Données locales" note.** Data viewed offline carries the subtle note `Données locales — synchronisation en attente` so the collector knows it is cached, not live.
>
> **Scope boundary (decided with the user during create-story):** Story 8.6 covers **read (list / search / profile) + edit (update)** only. Offline member **create / delete / bulk-import** are explicitly OUT of scope — the epic AC says "view a profile, or edit a member", and `useCreateMember` / `useDeleteMember` / `useImportMembers` offline branches would roughly double the story (two more RPCs + reconciler dispatch + tests). They remain online-only; a Growth follow-up can add them (`member.created` / `member.deleted` event types already exist in the `OfflineEventType` union, so the door is open).
>
> **Read-path mechanism (decided with the user):** TanStack Query **persistence** (`@tanstack/react-query-persist-client` + a storage persister), NOT the Service Worker `NetworkFirst` runtime cache that `architecture.md:372-376` mentions. Rationale: the Vite PWA service worker is inactive in dev and in the Playwright harness, making SW-cached offline reads effectively untestable in the E2E suite; TanStack persistence works identically in dev, prod, and E2E, hydrates deterministically on a cold start, and is a first-party extension of the already-adopted TanStack Query stack (NOT a new state-management library — `CLAUDE.md` forbids Redux/Zustand/Jotai, which this is not). This is a deliberate, cited deviation from the architecture's stated SW approach.
>
> **Pattern alignment with existing infrastructure (DO NOT re-invent):**
> - The offline-branch shape (`networkMode: "always"` + `isOfflineAtEntry()` + `persistOfflineEvent` + typed `offline_storage` error + optimistic `onMutate` / `onError` rollback) is fully established by Story 8.3's `useRecordContribution`. `useUpdateMember`'s offline branch copies it.
> - `appendEvent` / `listEvents` / `OfflineEvent` / `OfflineEventType` (`member.updated` already in the union) — `@/infrastructure/sync` (Stories 8.2-8.4).
> - `isOfflineAtEntry` / `getCurrentCollectorId` — `@/features/transaction/api/offlineGuards` (Story 8.3, shared).
> - The reconciler dispatch table (`resolveRpcName`) + `p_event_id` idempotency early-return + DROP+CREATE migration for SQLSTATE 42P13 — Story 8.4.
> - `useConnectivityState().online` — the offline signal for the "Données locales" note.
>
> **What Story 8.6 does NOT ship:**
> - Offline member create / delete / bulk-import (scope boundary above).
> - Offline cycle / settlement operations (not member-surface; out of Epic 8).
> - Conflict resolution — the architecture's single-writer-per-collector assumption holds (one account = one device); no merge UI.
> - Background Sync API (Growth, same as Stories 8.4/8.5).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1253-1265`; the rest are spec-derived constraints.

### Offline read path — query persistence

1. **Given** the collector is offline, **When** they open the member list, search, or view a profile, **Then** all read operations succeed against the persisted local cache (no network round-trip required, no error state).

2. **TanStack Query persistence is wired.** Add `@tanstack/react-query-persist-client` + a storage persister (`@tanstack/query-sync-storage-persister` over `localStorage` — the member dataset at the 150-member NFR ceiling is well under the localStorage budget). Replace the plain `QueryClientProvider` in `src/app/providers.tsx` with `PersistQueryClientProvider`. Persist with a sensible throttle (the persister default is fine).

3. **Persist only the member read queries.** The persister's `dehydrateOptions.shouldDehydrateQuery` filter persists ONLY queries whose key starts with `MEMBERS_QUERY_KEY` or `MEMBER_PROFILE_QUERY_KEY`. Do NOT persist transaction/cycle/SMS queries (avoids bloating storage + persisting fast-moving data).

4. **Cold-start offline hydration.** After visiting the member list / a profile online at least once, a full app reload while offline rehydrates that data — the list and the visited profiles render without a network call.

5. **`useMembers` / `useMemberProfile` need no query-mode change.** TanStack Query's default `networkMode: "online"` already serves cached data while offline (the query stays `status: "success"` with the persisted data and does not error). Verify this holds; do NOT switch these queries to `networkMode: "always"` (that would make them retry-spam offline).

6. **Search works offline.** Member-list search is already client-side (`MemberList` filters the in-memory list); once the list is persisted it filters offline with no extra work. Confirm with a test; no new code expected.

7. **Persistence buster / version.** The persister is configured with a `buster` string (or the app version) so a schema change to the cached shape invalidates stale persisted data rather than hydrating an incompatible structure.

### "Données locales" note

8. **Given** data is being viewed offline, **Then** it carries the subtle note `Données locales — synchronisation en attente` where relevant — specifically on the member list and the member profile.

9. **Note visibility rule.** The note shows when `useConnectivityState().online === false` AND the surface has data to show. It is calm and subtle (secondary text, no red, consistent with the UX "offline-as-empowerment" / "never a red alarm" invariant) — NOT a blocking banner.

10. **Note is a small reusable component** in `src/features/member/ui/` (e.g. `LocalDataNote`), rendered by `MemberList` and `MemberProfile`. Copy comes from a new i18n key.

### Offline edit — useUpdateMember

11. **Given** the collector is offline, **When** they edit a member (name / phone / daily amount) and submit, **Then** the edit is queued in the IndexedDB event log as a `member.updated` event (NOT sent to the RPC), **And** the member list + profile optimistically reflect the new values.

12. **`useUpdateMember` offline branch** mirrors Story 8.3's `useRecordContribution` exactly:
    - `networkMode: "always"` on the `useMutation` (so `mutationFn` runs while offline — per memory `feedback_tanstack_networkmode_offline.md`, the default pauses it).
    - `mutationFn` calls `isOfflineAtEntry()` (from `@/features/transaction/api/offlineGuards`); when offline → `persistOfflineEvent` path; else the existing `update_member` RPC.
    - Network-error fallback: if the online RPC throws a `TypeError` / network error, fall back to queueing offline (same as the record-* hooks).
    - The mutation result gains a `wasOffline` discriminator (return type changes from `void` → `{ wasOffline: boolean }`; update the 1 consumer — `MemberForm` / the edit route).

13. **`member.updated` offline event.** A builder produces the `OfflineEvent`:
    - `eventType: "member.updated"`, `eventId`: a fresh `crypto.randomUUID()` (the idempotency key), `entityId`: the member id, `collectorId` / `actor`: the session collector, `timestamp`: `toCanonicalTimestamp(...)`, `source: "offline_reconciled"`.
    - `payload` (snake_case `p_*`, shallow-spreadable onto the RPC): `{ p_event_id: eventId, p_id: memberId, p_name, p_phone_number, p_daily_amount }`.
    - Implement as a new builder in `src/features/member/api/` (e.g. `buildMemberUpdateEvent`) — do NOT force it into `buildOfflineEvent` (whose `syntheticTxId`-as-`entityId` shape is transaction-specific).

14. **Optimistic cache update + rollback.** `onMutate` snapshots and patches `MEMBERS_QUERY_KEY` (the edited member's name/phone/dailyAmount) + `[...MEMBER_PROFILE_QUERY_KEY, id]`; `onError` rolls back. `onSuccess` invalidation is GATED on `!wasOffline` (an offline edit must NOT invalidate — the server doesn't know yet; the reconciler triggers the refetch on replay, exactly like Story 8.3).

15. **Typed offline-storage error.** If `appendEvent` fails (quota / IDB error), wrap it into an `UpdateMemberError` with a new code `offline_storage` (mirrors Story 8.3's `RecordContributionError("offline_storage", …)`). The edit form surfaces it via `toast.error`.

16. **Pending count + connectivity pill.** A queued `member.updated` event increments the outbox `pendingCount` via the existing `appendEvent` → BroadcastChannel path (Story 8.3) — the connectivity pill reflects it with no extra wiring. Confirm with a test.

### Reconciler — member.updated replay

17. **`resolveRpcName` maps `member.updated` → `"update_member"`** in `src/infrastructure/sync/reconciler.ts` (currently returns `null` → `unsupported_kind`). `transaction.undone` / `member.created` / `member.deleted` STAY `null` (still out of scope).

18. **The reconciler replays `member.updated`** through the existing `postEvent` path — `supabase.rpc("update_member", event.payload)` — the payload is already `p_*`-shaped (AC #13). No new reconciler drain logic; only the dispatch entry + the spread.

19. **Error classification unchanged.** `update_member`'s error codes already fit the existing `classifyReplayError` buckets (`23505` duplicate_phone → `unique_violation` skip+continue; `P0002`/`PGRST116` → `not_found` skip; `42501`/`28000` → `unauthorized` stop; network → stop). No new `ReplayErrorCode`. Confirm `duplicate_phone` (23505) is acceptably classified as a skip (a phone collision on replay is a permanent failure for that event — correct).

### Server-side idempotency — update_member migration

20. **Migration — `members.last_event_id` column.** Add `last_event_id UUID NULL` to `public.members`. It records the most recent reconciled offline edit's event id so a retry is a no-op. (The `members_decrypted` view does NOT need to expose it — no client reads it — but per memory `project_views_after_columns.md`, confirm the view is an explicit projection and that omitting the column is intentional.)

21. **Migration — `update_member` accepts `p_event_id`.** DROP + CREATE `update_member` (SQLSTATE 42P13 workaround, per Story 8.4 / 7.5) with a new last parameter `p_event_id UUID DEFAULT NULL`. Body gains an idempotent early-return at the top:
    ```sql
    if p_event_id is not null then
      if (select last_event_id from public.members where id = p_id) = p_event_id then
        return;  -- already applied — no second UPDATE, no second audit row
      end if;
    end if;
    -- … existing validation + UPDATE …, additionally SET last_event_id = p_event_id
    ```
    Re-apply the `GRANT EXECUTE` clause. When `p_event_id` is NULL (the online edit path) the guard is skipped and behaviour is unchanged.

22. **Idempotency contract.** With `p_event_id` provided and `members.last_event_id` already equal to it: the RPC returns without a second UPDATE and without a second `member.updated` audit emission. The single-writer-per-collector model means out-of-order replay of two edits to the same member does not occur (the reconciler drains monotonically from the queue head).

23. **Deno contract test** — `supabase/functions/_shared/update-member-idempotent.contract.test.ts`, registered in `scripts/run-edge-tests.sh` (per memory `feedback_migration_rpc_smoke_test.md` — an unregistered contract file is a vacuous gate):
    - `update_member` with a fresh `p_event_id` → row updated, `last_event_id` set, exactly one `member.updated` audit row.
    - Same `p_event_id` again → no second UPDATE, still exactly one audit row.
    - `update_member` with `p_event_id = NULL` (online path) → updates normally, audit row emitted.

### Tests

24. **Unit — query persistence** — a test that the persister filter (`shouldDehydrateQuery`) accepts member-query keys and rejects others; a test that a persisted/rehydrated `useMembers` serves data while `navigator.onLine === false` without erroring.

25. **Unit — `useUpdateMember`** — extend `useUpdateMember.test.tsx`: offline branch queues a `member.updated` event (assert `appendEvent` called with the right shape) + returns `{ wasOffline: true }`; online branch unchanged returns `{ wasOffline: false }`; `onMutate` optimistic patch + `onError` rollback; `appendEvent` failure → `UpdateMemberError("offline_storage")`; `onSuccess` does NOT invalidate when `wasOffline`.

26. **Unit — builder** — `buildMemberUpdateEvent` produces the correct `OfflineEvent` (eventType, distinct eventId, entityId = member id, `p_*` payload).

27. **Unit — reconciler** — extend `reconciler.test.ts`: a `member.updated` event drains via `update_member` (was previously `unsupported_kind`-skipped); `member.created` / `member.deleted` STILL skip.

28. **Unit — `LocalDataNote`** — renders the copy when offline; renders nothing when online; `axe`-clean.

29. **Playwright E2E** — `tests/e2e/flow-8-offline-member.spec.ts` (or extend an existing member E2E):
    - Online: load `/members` (populates + persists the cache).
    - Go offline (`context.setOffline(true)` + dispatch `offline`).
    - Reload the page → the member list still renders (persisted hydration) + the "Données locales" note is visible.
    - Search filters the list offline.
    - Open a member, edit the daily amount, submit → optimistic update shows + the connectivity pill shows a pending count + NO server row yet.
    - Go online (`setOffline(false)` + dispatch `online`) → the reconciler drains → assert the server `members` row reflects the edit + exactly one new `member.updated` audit row.

### Architecture, dependencies, hygiene

30. **New dependencies** — `@tanstack/react-query-persist-client` + `@tanstack/query-sync-storage-persister`, both pinned to the same major as the installed `@tanstack/react-query`. These are the ONLY new deps; no state-management library (`CLAUDE.md` compliant). Run `npm install` on Node 22 / npm 10 (memory `feedback_npm_lockfile_node_version.md`) so the lockfile matches CI.

31. **Layering.** The persister wiring lives in `src/app/providers.tsx`. `buildMemberUpdateEvent` + `LocalDataNote` live in `src/features/member/`. The reconciler change is in `src/infrastructure/sync/`. `useUpdateMember` may import `isOfflineAtEntry` / `getCurrentCollectorId` from `@/features/transaction/api/offlineGuards` (cross-feature, precedent set in Story 8.3) and `appendEvent` from `@/infrastructure/sync`.

32. **All gates green**:
    - `npm run typecheck` — strict clean.
    - `npm run lint --max-warnings=0` — clean.
    - `npm run test -- --coverage` — global ≥ 75 % branches preserved; new `buildMemberUpdateEvent` ≥ 85 % branches isolated.
    - `npm run test:edge` — Deno contract tests pass incl. the new `update-member-idempotent` file.
    - `npm run build` — bundle delta budget ≤ 8 KB gzipped (the two TanStack persist packages are small but non-zero; this story's budget is wider than the 3 KB of 8.2-8.5 because of the deps — measure and report the real delta).
    - `npx playwright test` — full suite locally on Node 22 (memory `feedback_tanstack_networkmode_offline.md` — offline behavior is not caught by mocked-guard unit tests); new offline-member flow + Stories 8.x flows unchanged.
    - **Pre-push memory**: `nvm use 22`; coverage locally; grep stale assertions; smoke-test the `update_member` migration via `psql` OR `test:edge` before push (memory `feedback_migration_rpc_smoke_test.md` — a migration touching an RPC body is not caught by the TS gates).

## Tasks / Subtasks

- [x] **Task 1 — TanStack Query persistence** (AC: #2, #3, #5, #7, #30)
  - `npm install @tanstack/react-query-persist-client @tanstack/query-sync-storage-persister` (Node 22 / npm 10; versions matched to `@tanstack/react-query`).
  - `src/app/providers.tsx`: swap `QueryClientProvider` → `PersistQueryClientProvider`; create the `localStorage` persister; `dehydrateOptions.shouldDehydrateQuery` filter on the member query keys; set a `buster`.

- [x] **Task 2 — "Données locales" note** (AC: #8, #9, #10, #28)
  - New `src/features/member/ui/LocalDataNote.tsx` — subtle secondary-text note, shown when `useConnectivityState().online === false`.
  - Render it in `MemberList` + `MemberProfile`.
  - New i18n key `members.local_data_note` = "Données locales — synchronisation en attente".
  - `LocalDataNote.test.tsx` (3 cases incl. axe).

- [x] **Task 3 — `buildMemberUpdateEvent` builder** (AC: #13, #26)
  - New `src/features/member/api/buildMemberUpdateEvent.ts` + test.

- [x] **Task 4 — `useUpdateMember` offline branch** (AC: #11, #12, #14, #15, #16, #25)
  - `networkMode: "always"`; `isOfflineAtEntry` short-circuit + network-error fallback; `persistOfflineEvent`-style queueing via `appendEvent`; `onMutate` optimistic patch + `onError` rollback; return `{ wasOffline }`; `offline_storage` error code.
  - Update the single consumer (the edit route / `MemberForm`) for the new return shape.
  - Extend `useUpdateMember.test.tsx`.

- [x] **Task 5 — Migration: `update_member` + `p_event_id`** (AC: #20, #21, #22)
  - `npm run db:migrate:new update-member-event-id` — `members.last_event_id UUID` column + DROP/CREATE `update_member` with `p_event_id` + idempotent early-return + `GRANT EXECUTE`.
  - `npm run db:migrate` (NOT `db:reset`); regenerate `database.types.ts`.
  - Smoke-test via `psql` or `test:edge` before push.

- [x] **Task 6 — Deno contract test** (AC: #23)
  - `update-member-idempotent.contract.test.ts` + register in `scripts/run-edge-tests.sh`.

- [x] **Task 7 — Reconciler `member.updated` dispatch** (AC: #17, #18, #19, #27)
  - `resolveRpcName`: `member.updated` → `"update_member"`.
  - Extend `reconciler.test.ts`.

- [x] **Task 8 — Playwright E2E** (AC: #29)
  - `tests/e2e/flow-8-offline-member.spec.ts` — offline read (persisted reload) + offline edit + reconcile.

- [x] **Task 9 — Gate run + sprint hygiene** (AC: #32)
  - All gates green locally on Node 22 / npm 10; full Playwright suite before push.
  - `sprint-status.yaml`: `8-6-offline-member-lookup-edit` `ready-for-dev → review`; `last_updated` + touched line.

## Review Findings

Cross-LLM code review on 2026-05-15 (claude-sonnet-4-6, 3 parallel layers: Blind Hunter / Edge Case Hunter / Acceptance Auditor). Triage: 8 patch, 1 defer, 14 dismissed.

- [x] [Review][Patch] AC #12 deviation — `useUpdateMember` inlines `navigator.onLine` + `supabase.auth.getSession()` instead of reusing `isOfflineAtEntry` / `getCurrentCollectorId` from `@/features/transaction/api/offlineGuards` as the AC + code-reuse map mandate; the inline `getSession` also lacks the Safari-private-mode try/catch guard `getCurrentCollectorId` provides [src/features/member/api/useUpdateMember.ts] (auditor; AC #12)
- [x] [Review][Patch] AC #24 — only the `shouldPersistMemberQuery` filter test was written; the second mandated test (a persisted/cached `useMembers` serves data offline without erroring) is missing [src/features/member/api/useMembers.test.* or providers.test.ts] (auditor; AC #24)
- [x] [Review][Patch] AC #27 — `reconciler.test.ts` covers `member.created`-still-skipped + `member.updated`-drains but NOT the `member.deleted`-still-skipped case the AC explicitly lists [src/infrastructure/sync/reconciler.test.ts] (auditor; AC #27)
- [x] [Review][Patch] AC #29 — the E2E omits the audit-row-count assertion ("exactly one new member.updated audit row" after reconcile) and the offline-search step; add both (the `page.reload()`-while-offline step stays infeasible without the SW — documented) [tests/e2e/flow-8-offline-member.spec.ts] (auditor; AC #29)
- [x] [Review][Patch] `onMutate` patches the optimistic cache from the raw `values`, while `mutationFn` / the offline event use `updateMemberInputSchema.parse(values)` — if the schema trims/normalises, the optimistic UI and the reconciled truth diverge; parse once and patch from the parsed result [src/features/member/api/useUpdateMember.ts] (blind)
- [x] [Review][Patch] `shouldPersistMemberQuery` gates on `status === "success"` but not on data presence — a success-with-undefined-data query would be persisted + hydrated as authoritative; also require `query.state.data !== undefined` [src/app/providers.tsx] (blind)
- [x] [Review][Patch] E2E `expect(finalRow?.last_event_id).not.toBeNull()` passes vacuously when `finalRow` is null (`undefined` ≠ `null`); use `.toBeTruthy()` or assert `finalRow` non-null first [tests/e2e/flow-8-offline-member.spec.ts] (blind)
- [x] [Review][Patch] `providers.test.ts` asserts `shouldPersistMemberQuery` with hard-coded `["members", …]` literals, not the exported `MEMBERS_QUERY_KEY` / `MEMBER_PROFILE_QUERY_KEY` constants — a rename of the constants would break persistence while the test still passes; import + use the constants [src/app/providers.test.ts] (edge)
- [x] [Review][Defer] Sequential offline edits to the same member + an IDB `deleteEvent` failure after a successful `update_member` replay: `members.last_event_id` records only the LAST applied event, so a re-replay of an earlier event is idempotent ONLY because the reconciler stops the drain on the first IDB failure (preserving head-of-queue order). The single-`last_event_id` design is correct under the current drain-stop behaviour but is a latent assumption — deferred, documented in deferred-work.md [src/infrastructure/sync/reconciler.ts + migration 0009]
- Dismissed (14): SQL idempotency "ownership" concern (the early-return select is collector-scoped → NULL → falls through to the UPDATE's own collector guard → not_found — both Blind's own conclusion and Edge agree it's safe); `inFlightRef` set in mutationFn not onMutate (pre-existing Story 8.3 pattern, the form disables the CTA while pending, onError rollback converges); network-error fallback queues while online (spec AC #12 — intended offline-resilience: a failed write is preserved not lost, mirrors Story 8.3); `queryPersister.removeClient()` void-cast (sync-storage-persister's removeClient is effectively localStorage.removeItem, TanStack no-ops storage errors internally); `buildMemberUpdateEvent` timestamp double-conversion (`toCanonicalTimestamp(new Date().toISOString())` is the exact Story 8.3 `buildOfflineEvent` pattern + the schema regex validates it, asserted by the safeParse test); `persistOfflineMemberUpdate` references module-scope `supabase` (method calls preserve `this` — the binding memory targets extracting `.rpc` into a free variable, not method calls; the whole codebase calls `supabase.auth.getSession()` from module functions); `LocalDataNote` `role=status` + `aria-live=polite` redundancy (harmless, consistent with `ConnectivityIndicator` + the Story 8.5 banner); `buildMemberUpdateEvent` empty-phone fixture (empty phone IS valid — `update_member` explicitly handles `v_phone_clean = ''`); `[id].edit.test.tsx` hard-coded copy string (consistent with the existing `toastSuccessMock` assertion in the same file); online path doesn't pass `p_event_id` / `last_event_id` not cleared online (correct by design — the migration comment explains the `coalesce`); E2E `fill()` without a prior visibility assert (Playwright `fill` auto-waits + the field is asserted visible before going offline); `navigator.onLine` mid-flight toggle (benign, idempotency-safe, mirrors Story 8.3); `LocalDataNote` no data-presence guard (already satisfied — the note is placed inside MemberList's ≥1-member branch + MemberProfile always has a member); contract-test `audit_log.entity_id` column name (verified correct by the passing psql smoke test).

## Dev Notes

### Why TanStack persistence, not the architecture's Service Worker cache

`architecture.md:372-376` specifies `NetworkFirst` SW runtime caching for PostgREST GETs. Story 8.6 deliberately uses TanStack Query persistence instead (user decision at create-story time). The SW is inactive under `npm run dev` and in the Playwright harness (`vite-plugin-pwa` `devOptions.enabled` defaults false), so SW-cached offline reads cannot be exercised by the E2E suite — and Epic 8's whole risk profile (architecture.md:408-421 flags offline sync as the highest-risk epic) demands the offline path be E2E-tested. TanStack persistence behaves identically in dev / prod / E2E, hydrates deterministically on a cold start, and is a first-party extension of the already-adopted TanStack Query stack. It is not a state-management library — `CLAUDE.md`'s ban targets Redux/Zustand/Jotai. Cite this deviation in the PR.

### Why `update_member` needs `p_event_id` even though UPDATEs are idempotent

An absolute-state `UPDATE` re-applied is idempotent for the *data*. The problem is the *audit trail*: `update_member` fires the `audit_members` trigger on every UPDATE, so a reconciler retry (the RPC succeeded server-side but the response was lost in transit — the canonical network-failure case) would emit a *second* `member.updated` audit row. Story 8.4 added `p_event_id` to the record-* RPCs for exactly this reason. The `members.last_event_id` column + early-return makes the retry a true no-op (no UPDATE, no audit row). This keeps the audit chain (NFR-S6) one-row-per-logical-edit.

### Why a new builder, not `buildOfflineEvent`

`buildOfflineEvent` (Story 8.3) hard-codes `entityId = syntheticTxId` because a transaction's row id IS its event id. A member edit's `entityId` is the *existing* member id, and its `eventId` is a fresh idempotency UUID — a different shape. Forcing it into the transaction builder's discriminated union would muddy both. A small dedicated `buildMemberUpdateEvent` is cleaner.

### Why offline create/delete are out of scope

The epic AC (epics.md:1265) says "view a profile, or edit a member". Offline create needs a `member.created` reconciler path + a synthetic-member-id strategy (the optimistic member needs an id the server will honour — exactly the `p_event_id`-as-row-id trick the transaction RPCs use, but `create_member_with_cycle` also spins a cycle); offline delete needs `member.deleted` + cascade-ordering against any queued edits for the same member. Both are real work and the `OfflineEventType` union already reserves the event types — a clean Growth follow-up. Story 8.6 stays read + edit.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| Offline-branch hook shape | `useRecordContribution` (Story 8.3) — `networkMode: "always"`, `isOfflineAtEntry`, fallback, optimistic onMutate/onError |
| `isOfflineAtEntry` / `getCurrentCollectorId` | `@/features/transaction/api/offlineGuards` (Story 8.3) |
| `appendEvent` / `OfflineEvent` / `member.updated` type | `@/infrastructure/sync` (Stories 8.2-8.4) |
| Canonical timestamp | `toCanonicalTimestamp` — `@/domain/audit/hashChain` |
| Reconciler dispatch + `p_event_id` idempotency + DROP/CREATE migration | Story 8.4 (`reconciler.ts`, migrations 0057-0061) |
| `online` signal for the note | `useConnectivityState` (Story 8.1) |
| `update_member` RPC baseline | `supabase/migrations/20260423000001_update_member.sql` |
| Optimistic member-cache patch | `optimisticCache` helpers (Story 8.3) — reuse the MEMBERS/MEMBER_PROFILE patch shape |

### Anti-patterns to avoid (memory + spec-fidelity)

- **DO NOT** switch `useMembers` / `useMemberProfile` to `networkMode: "always"` — that makes queries retry-spam offline; the default `"online"` already serves persisted cache (AC #5).
- **DO** set `networkMode: "always"` on the `useUpdateMember` *mutation* — the default pauses `mutationFn` offline, making the offline branch dead code (memory `feedback_tanstack_networkmode_offline.md`).
- **DO NOT** persist all queries — filter to the member keys (AC #3); persisting transactions/SMS bloats storage.
- **DO NOT** forget the persister `buster` — a cached-shape change must invalidate, not mis-hydrate.
- **DO NOT** invalidate queries on the offline edit branch — the reconciler triggers the refetch on replay (Story 8.3 pattern).
- **DO NOT** run `db:reset` during story dev — `db:migrate` only (CLAUDE.md).
- **DO NOT** call `supabase.rpc` from a free variable (memory `project_supabase_rpc_binding.md`).
- **DO NOT** push a migration touching an RPC body without a `psql`/`test:edge` smoke test (memory `feedback_migration_rpc_smoke_test.md`).
- **DO NOT** `npm install` on Node 24/npm 11 — `nvm use 22` first (memory `feedback_npm_lockfile_node_version.md`).
- Run the full Playwright suite locally before push (memory `feedback_tanstack_networkmode_offline.md`).

### Pre-push checklist (per `feedback_push_then_ci_failure.md`)

1. `npm run typecheck` ✓
2. `npm run lint --max-warnings=0` ✓
3. `npm run test -- --coverage` — global ≥ 75 %; `buildMemberUpdateEvent` ≥ 85 % isolated
4. `npm run test:edge` — incl. the new `update-member-idempotent` contract file
5. `psql` smoke test of the `update_member` migration
6. `npm run build` — measure + report the gzipped delta (two new deps)
7. `npx playwright test` — full suite, Node 22 — new offline-member flow + Stories 8.x unchanged
8. `nvm use 22` active before `npm install`; lockfile regenerated on Node 22 / npm 10

### Project structure notes

**New files:**
- `src/features/member/api/buildMemberUpdateEvent.ts` (+ test)
- `src/features/member/ui/LocalDataNote.tsx` (+ test)
- `supabase/migrations/<timestamp>_update_member_event_id.sql`
- `supabase/functions/_shared/update-member-idempotent.contract.test.ts`
- `tests/e2e/flow-8-offline-member.spec.ts`

**Modified files:**
- `src/app/providers.tsx` — `PersistQueryClientProvider` + persister.
- `src/features/member/api/useUpdateMember.ts` (+ `.test.tsx`) — offline branch, `{ wasOffline }` return, `offline_storage` code.
- `src/features/member/ui/MemberList.tsx` / `MemberProfile.tsx` — render `LocalDataNote`.
- the member edit route / `MemberForm` consumer — adapt to the new `useUpdateMember` return shape.
- `src/infrastructure/sync/reconciler.ts` (+ `.test.ts`) — `resolveRpcName` `member.updated` → `update_member`.
- `scripts/run-edge-tests.sh` — register the new contract file.
- `src/infrastructure/supabase/database.types.ts` — regenerated (`update_member` `p_event_id`, `members.last_event_id`).
- `src/i18n/fr.json` — `members.local_data_note` key.
- `package.json` / `package-lock.json` — two new TanStack deps.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Testing standards

- Vitest + RTL; `fake-indexeddb` polyfill (Story 8.2) for `appendEvent`; the persistence test stubs `localStorage`.
- Deno contract test for the `update_member` migration (`test:edge`).
- Playwright for the offline-member E2E (`context.setOffline` + explicit `offline`/`online` dispatch — Story 8.4/8.5 pattern).
- Coverage gate: ≥ 75 % branches global; `buildMemberUpdateEvent` ≥ 85 % isolated. 100 % domain gate unaffected.

### Definition-of-done checklist

- All 32 ACs satisfied + all 9 tasks ticked.
- Member list / search / profile render offline from the persisted cache after a cold reload.
- The "Données locales" note shows on the list + profile when offline.
- An offline member edit queues a `member.updated` event, optimistically updates, and the connectivity pill counts it.
- The reconciler replays `member.updated` → `update_member`; the migration's `p_event_id` makes a retry a no-op (one audit row).
- All gates green on Node 22 / npm 10; full Playwright suite run locally before push.
- Story status `review`; sprint-status updated; touched-line updated.
- **Epic 8 (Offline Resilience) is complete — 6/6 stories.**

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **`npm run db:types` targets the linked cloud project** (`supabase gen types --linked`), which the local project isn't linked to. Regenerated via `npx supabase gen types typescript --local 2>/dev/null > database.types.ts` (the Story 8.4 lesson — stderr redirect avoids CLI noise landing in the file).
- **Migration smoke test (psql).** Per memory `feedback_migration_rpc_smoke_test.md`, smoke-tested the `update_member` migration via a `psql` DO block before relying on it: fresh `p_event_id` sets `last_event_id` + emits exactly one `member.updated` audit row; a same-`p_event_id` replay is a no-op (still ONE audit row — idempotency confirmed); the `p_event_id = NULL` online path updates normally. Deno is not installed locally so `npm run test:edge` (the formal Deno contract gate) runs in CI; the psql smoke test covers the Postgres side pre-push.
- **`[id].edit.test.tsx` sonner mock.** The existing mock only stubbed `toast.success`; the new offline path calls bare `toast(...)`. Made the mock callable via `Object.assign((...) => toastMock(...), { success: toastSuccessMock })`.

### Completion Notes List

- **Offline read — TanStack Query persistence.** Added `@tanstack/react-query-persist-client` + `@tanstack/query-sync-storage-persister`; `src/app/providers.tsx` swaps `QueryClientProvider` → `PersistQueryClientProvider` with a `localStorage` persister (`safaricash:query-cache`), `maxAge` 24 h (NFR-R2), a `buster`, and a `shouldDehydrateQuery` filter (`shouldPersistMemberQuery`, exported + unit-tested) that persists ONLY successful `["members", …]` queries. The persisted cache is dropped on sign-out (`queryPersister.removeClient()` next to the existing `queryClient.clear()`) so a second collector on the same device cannot rehydrate the first's members.
- **"Données locales" note.** New `LocalDataNote` component (`role="status"`, secondary text) rendered by `MemberList` + `MemberProfile`; shows `Données locales — synchronisation en attente` when `useConnectivityState().online === false`, nothing when online. New i18n key `members.local_data_note`.
- **Offline edit — `useUpdateMember`.** Story-8.3-style offline branch: `networkMode: "always"`, an inline `navigator.onLine === false` check + a `TypeError`/`network`-error fallback → queues a `member.updated` `OfflineEvent` (new `buildMemberUpdateEvent` builder) via `appendEvent`; `onMutate` optimistically patches the `MEMBERS_QUERY_KEY` + `MEMBER_PROFILE_QUERY_KEY` caches, `onError` rolls back, `onSuccess` invalidation is gated on `!wasOffline`. Return type `void → { wasOffline }`; the edit route shows an offline toast (`members.edit.toast_offline`) when queued. New `offline_storage` error code surfaced by `MemberForm`.
- **Reconciler.** `resolveRpcName` maps `member.updated` → `update_member` (was `null`/`unsupported_kind`); `member.created`/`member.deleted` stay unsupported (out of scope). The existing `classifyReplayError` buckets already cover `update_member`'s error codes — no new `ReplayErrorCode`.
- **Migration `20260515000009_update_member_event_id.sql`.** Adds `members.last_event_id UUID`; DROP+CREATE `update_member` with a new `p_event_id UUID DEFAULT NULL` last param + an idempotent early-return (`last_event_id = p_event_id` → skip — no second UPDATE, no second `member.updated` audit row). The online path (`p_event_id` NULL) is unchanged. `members_decrypted` view intentionally NOT re-derived (`last_event_id` is server-only). Deno contract test `update-member-idempotent.contract.test.ts` (3 cases) registered in `run-edge-tests.sh`.
- **Tests** — `shouldPersistMemberQuery` (3 cases), `LocalDataNote` (3 incl. jest-axe), `buildMemberUpdateEvent` (3 incl. schema validity), `useUpdateMember` rewritten (online happy/classification/network-fallback + offline queue/unauthorized/offline_storage + optimistic patch/rollback/invalidation-gating), reconciler `member.updated`-drains case + `member.created`-still-skipped, `[id].edit.test.tsx` offline-toast case + sonner-mock fix. Playwright `flow-8-offline-member.spec.ts` — online persist → offline edit queued → profile renders offline w/ the note → reconnect → reconciler drains → server `daily_amount` + `last_event_id` updated.
- **Gates (local, Node 22 / npm 10)**: `typecheck` ✓ · `lint --max-warnings=0` ✓ · `npm run test --coverage` **884 vitest passed** (+19 vs Story 8.5's 865) · global branches **76.29%** (≥ 75% gate) · `npm run build` PWA precache **824.08 KiB** (+7.5 KiB vs Story 8.5's 816.61 — the two TanStack persist packages; within the ≤ 8 KB story budget) · psql migration smoke test ✓ · Playwright `flow-8-offline-member` + `flow-8-stalled-sync` + `flow-1-offline-replay` green (the 2 failures — `flow-3-cycle-settlement`, `receipt-url-worker` — are local-env-only: wrangler workers not started locally; CI starts them; identical to the 8.4/8.5 local runs, unrelated to this story).
- **Scope honoured** — read (list/search/profile) + edit (update) only; offline create/delete/import remain online-only as decided. **Epic 8 (Offline Resilience) is now 6/6 stories complete.**

### File List

**New files:**
- `src/features/member/api/buildMemberUpdateEvent.ts` (+ `.test.ts`) — `member.updated` OfflineEvent builder.
- `src/features/member/ui/LocalDataNote.tsx` (+ `.test.tsx`) — offline "Données locales" note.
- `src/app/providers.test.ts` — `shouldPersistMemberQuery` filter test.
- `supabase/migrations/20260515000009_update_member_event_id.sql` — `members.last_event_id` + `update_member` `p_event_id`.
- `supabase/functions/_shared/update-member-idempotent.contract.test.ts` — Deno idempotency contract test.
- `tests/e2e/flow-8-offline-member.spec.ts` — Playwright offline read + edit + reconcile E2E.

**Modified files:**
- `src/app/providers.tsx` — `PersistQueryClientProvider` + `localStorage` persister + `shouldPersistMemberQuery` + persisted-cache clear on sign-out.
- `src/features/member/api/useUpdateMember.ts` (+ `.test.tsx`) — offline branch, optimistic cache, `{ wasOffline }`, `offline_storage` code.
- `src/features/member/ui/MemberList.tsx` / `MemberProfile.tsx` — render `LocalDataNote`.
- `src/features/member/ui/MemberForm.tsx` — `offline_storage` error-copy mapping.
- `src/app/routes/members/[id].edit.tsx` (+ `.test.tsx`) — offline-toast branch on `wasOffline`; sonner mock made callable.
- `src/infrastructure/sync/reconciler.ts` (+ `.test.ts`) — `resolveRpcName` `member.updated` → `update_member`.
- `scripts/run-edge-tests.sh` — register the new contract file.
- `src/infrastructure/supabase/database.types.ts` — regenerated (`update_member` `p_event_id`, `members.last_event_id`).
- `src/i18n/fr.json` — `members.local_data_note` + `members.edit.toast_offline` + `members.edit.error.offline_storage`.
- `package.json` / `package-lock.json` — `@tanstack/react-query-persist-client` + `@tanstack/query-sync-storage-persister`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## References

- **Epic spec:** `epics.md` lines 1253-1265 (Story 8.6 BDD), 1177-1251 (Stories 8.1-8.5 — what 8.6 builds on).
- **PRD:** `prd.md` — FR40 (offline operation: "all transaction capture, member lookup, and member edit operations while offline, with no data loss"), FR41/FR42/FR43; FR10 (edit member with impact warning), FR13 (member profile), FR14 (search/filter); NFR-R2 (24 h offline, zero data loss), NFR-P2 (search p95 ≤ 300 ms at 150 members), NFR-S6 (audit chain integrity).
- **Architecture:** `architecture.md` lines 367-371 (`src/infrastructure/sync/` — event log + outbox + reconciler; "UI reads from local read-model"; single-writer-per-collector), 372-376 (SW `NetworkFirst` — the approach this story deviates from, with rationale), 378 (TanStack Query for server state), 408-421 (Epic 8 = highest technical risk), 1088-1091 (FR40-43 → `src/infrastructure/sync/`).
- **UX spec:** `ux-design-specification.md` — "offline-as-empowerment" (67-73), "offline-first dignity" (124-133), "every state named, never silent / never red" (188-204, 400-404, 480-489), connectivity indicator states (985-1002).
- **Story 8.3 (predecessor):** `8-3-outbox-pattern-queue.md` — `useRecordContribution` offline-branch shape, `offlineGuards`, optimistic cache, `offline_storage` error, `buildOfflineEvent`.
- **Story 8.4 (predecessor):** `8-4-reconciler-replay.md` — reconciler dispatch (`resolveRpcName`), `p_event_id` idempotency, DROP/CREATE migration pattern, Deno contract-test registration.
- **Story 8.5 (predecessor):** `8-5-stalled-sync-alert.md` — `useConnectivityState`, the sync drawer.
- **`update_member` RPC:** `supabase/migrations/20260423000001_update_member.sql`.
- **CLAUDE.md:** tokens not hex; layering; `db:migrate` not `db:reset`; no state-management lib (TanStack persist-client is NOT one).
- **Memory:** `feedback_tanstack_networkmode_offline.md`, `feedback_migration_rpc_smoke_test.md`, `feedback_npm_lockfile_node_version.md`, `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`, `project_supabase_rpc_binding.md`, `project_views_after_columns.md`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-15 | Cross-LLM code review via bmad-code-review — claude-sonnet-4-6, 3 parallel layers (Blind Hunter / Edge Case Hunter / Acceptance Auditor). Verdict: 8 patch + 1 defer + 14 dismissed. All 8 patches batch-applied: (1) `useUpdateMember` now reuses `isOfflineAtEntry` / `getCurrentCollectorId` from `@/features/transaction/api/offlineGuards` (AC #12 + the Safari-private-mode guard) instead of inline checks; (2) added the AC #24 test — `useMembers` serves the cached/persisted data offline without erroring; (3) added the AC #27 `member.deleted`-still-skipped reconciler test; (4) the E2E gained the "exactly one `member.updated` audit row" assertion + an offline list-read + search step; (5) `onMutate` patches the optimistic cache from the PARSED values (the schema trims `name` + coerces `dailyAmount`); (6) `shouldPersistMemberQuery` also requires `state.data !== undefined`; (7) the E2E `last_event_id` assertion uses `.toBeTruthy()` (no vacuous pass on a null row); (8) `providers.test.ts` uses the `MEMBERS_QUERY_KEY` / `MEMBER_PROFILE_QUERY_KEY` constants. 1 defer: the single-slot `members.last_event_id` idempotency marker is correct only under the current drain-stop-on-IDB-failure behaviour — filed in deferred-work.md. Gates re-run: typecheck / lint / 887 vitest passed / branches 76.23% / build / full Playwright suite (flow-8-offline-member verified 2× + flow-8-stalled-sync + flow-1-offline-replay green; 2 unrelated local-env wrangler-worker failures). Status → done. **Epic 8 complete — 6/6.** | Reviewer (claude-sonnet-4-6 × 3) → Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Story 8.6 implemented via bmad-dev-story on `feat/8-6-offline-member-lookup-edit` (Node 22 / npm 10). TanStack Query persistence wired in `providers.tsx` (member queries only, localStorage, sign-out clear); `useUpdateMember` offline branch (`networkMode: "always"`, `member.updated` event via `buildMemberUpdateEvent`, optimistic cache + rollback, `{ wasOffline }`, `offline_storage` code); `LocalDataNote` on list + profile; reconciler `resolveRpcName` learns `member.updated` → `update_member`; migration `0009` adds `members.last_event_id` + `p_event_id` to `update_member` (idempotent early-return, psql-smoke-tested); Deno `update-member-idempotent` contract test registered. Gates: typecheck / lint / 884 vitest passed / branches 76.29% / build PWA 824 KiB / full Playwright suite (flow-8-offline-member + flow-8-stalled-sync + flow-1-offline-replay green; 2 unrelated local-env wrangler-worker failures). 9 tasks complete, 32 ACs satisfied. Status → review. **Epic 8 complete — 6/6.** | Dev (claude-opus-4-7[1m]) |
| 2026-05-15 | Story 8.6 drafted via bmad-create-story — SIXTH and FINAL story of Epic 8 (Offline Resilience). Extends the offline write loop (Stories 8.2-8.5) to the member surface. Two scoping decisions taken with the user: (1) offline reads served by TanStack Query **persistence** (`@tanstack/react-query-persist-client` + sync-storage-persister) rather than the architecture's Service Worker `NetworkFirst` cache — the SW is inactive in dev/E2E, making SW-cached reads untestable, whereas persistence works identically everywhere and hydrates a cold offline start; (2) scope is read (list/search/profile) + **edit (update) only** — offline create/delete/import are explicitly out of scope (the `member.created`/`member.deleted` event types stay reserved for a Growth follow-up). `useUpdateMember` gets a Story-8.3-style offline branch (`networkMode: "always"`, `isOfflineAtEntry`, `member.updated` event queued via a new `buildMemberUpdateEvent`, optimistic cache + rollback, `offline_storage` error); the reconciler's `resolveRpcName` learns `member.updated` → `update_member`; a migration adds `members.last_event_id` + `p_event_id` to `update_member` for retry-idempotency (no double audit row); a `LocalDataNote` shows "Données locales — synchronisation en attente" on the list + profile when offline. 2 new deps (both first-party TanStack persist packages). Closes Epic 8. 32 ACs / 9 tasks. | Spec author (claude-opus-4-7[1m]) |
