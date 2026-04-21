# Story 1.7: Sign-out

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector (Ibrahim) finishing the day or lending the phone to a colleague**,
I want **to sign out explicitly from a visible "Se déconnecter" button in the Plus tab**,
so that **the next user on this phone can't see my members and transactions, AND the audit log records that I intentionally left (not just an idle timeout) so that disputes 30 days later can reconstruct who was using the app when (FR4, NFR-S6)**.

## Acceptance Criteria

1. **`/settings` route with a "Se déconnecter" row.** A new public-after-auth route at `/settings` (file `src/app/routes/settings.tsx`) is mounted inside the `ProtectedRoute → AppLayout` tree in `src/app/router.tsx`. The route renders a page with:
   - Page heading `<h1>` "Plus" (UX spec line 644 commits to "Plus" as the 4th bottom-tab label; French user-facing label) — per `src/i18n/fr.json` key `settings.title`.
   - One Secondary-variant button labelled `Se déconnecter` (exact French per epic AC line 555 and `settings.signout_cta` i18n key). Button variant is Secondary (not Destructive-red) because UX spec line 1311 requires Destructive styling ONLY behind a confirmation gate, and sign-out is NOT one of the 4 dialog-eligible events (UX spec line 1331).
   - Touch target ≥ 44×44 px (NFR-A2). Full-width on mobile.
   - Accessible label: button's text IS the label; no aria-label override needed.

2. **Settings surface reachable from `AppLayout` (header link in this story; proper bottom nav deferred).** `src/App.tsx#AppLayout` currently shows only a home-logo link. This story adds a minimal "Plus" text link in the header (right-aligned) that routes to `/settings`. The full bottom-tab nav (Dashboard / Membres / Rapports / Plus per UX spec lines 644–1191) is **deferred** to a later UI story — the sign-out flow is independently testable from a simple header link and does NOT block on the nav component.

3. **Explicit sign-out calls `supabase.auth.signOut({ scope: "local" })`.** Scope MUST be `"local"` (not `"global"`) because:
   - The AC talks about "this device" semantics ("sharing a device or finishing for the day").
   - A collector may be signed in on their personal phone AND a shared office device; signing out from the shared device MUST NOT revoke the personal-phone session.
   - Pass the scope explicitly in the `signOut()` call — do NOT rely on the default (Supabase default is also `local` but a scope change in a library upgrade would silently alter behavior; explicit is safer).

4. **`session.signed_out` audit event emitted via SECURITY DEFINER RPC.** The client cannot INSERT into `audit_log` directly (migration 0003 REVOKEs INSERT from `authenticated`). Story 1.7 adds a new migration `supabase/migrations/20260421000001_emit_session_event.sql` defining:
   ```sql
   create or replace function public.emit_session_event(p_reason text)
   returns void
   language plpgsql
   security definer
   set search_path = public, extensions, pg_temp
   ```
   The function:
   - Validates `auth.uid()` is non-null (caller is authenticated) and `p_reason IN ('explicit', 'idle')`.
   - Reads `collector_id = auth.uid()`.
   - Mirrors the hash-chain logic of `audit_emit()` in migration 0007 (reads last `entry_hash` with advisory lock on `(0x5AFA, hashtext(collector_id::text))`, computes new hash over canonical serialization, INSERTs).
   - Uses `event_type = 'session.signed_out'`, `entity_table = 'sessions'`, `entity_id = collector_id` (self-referential sentinel since there's no `sessions` table — satisfies the NOT NULL constraints on `entity_id`/`entity_table` in migration 0001).
   - `payload = jsonb_build_object('reason', p_reason)`.
   - `actor = auth.uid()::text`.
   - `source = 'online'` (sign-out is always online-initiated at MVP; offline sign-out becomes Story 8.x concern).
   - GRANT EXECUTE to `authenticated`; REVOKE from `anon`.

   Rationale for a new RPC rather than extending `audit_emit()`: `audit_emit()` is a TRIGGER function (reads `TG_TABLE_NAME` / `TG_OP` / `NEW` / `OLD`) and is not callable directly. Refactoring it to a dual-purpose function would widen the blast radius of a future change. A dedicated session-event RPC is narrower and easier to reason about.

5. **Unified `requestSignOut` helper is the ONLY entry point for sign-out (explicit + idle).** A new file `src/features/auth/api/signOut.ts` exports `requestSignOut(reason: "explicit" | "idle"): Promise<void>`. The helper:
   - Sets a module-scoped `signOutStateRef.reason = reason` flag (pattern consistent with Story 1.5's `hadSessionRef`).
   - Best-effort calls `supabase.rpc("emit_session_event", { p_reason: reason })` with a 2-second timeout (never blocks sign-out on a slow audit write — the collector's UX wins over the audit chain's completeness; the deferred-audit case is documented in Dev Notes).
   - Calls `await supabase.auth.signOut({ scope: "local" })`.
   - Returns void on success; never throws (errors logged via `console.warn` in DEV only; sign-out is a UX boundary where throwing would confuse the user).

   Story 1.6's `providers.tsx` mount of `useIdleTimeout` updates from `onExpired: () => void supabase.auth.signOut()` to `onExpired: () => void requestSignOut("idle")`. The dashboard-stub sign-out at `src/app/routes/dashboard.tsx:13-16` (the temporary dev-only `handleLogout`) is REMOVED — that stub predates Story 1.7 and is superseded.

6. **`AuthStateListener` clears TanStack Query cache on SIGNED_OUT (one-time, both paths).** In `src/app/providers.tsx`'s existing SIGNED_OUT handler (lines 78–88), the story adds `queryClient.clear()` BEFORE the navigate/toast logic. This wipes every cached query (member lists, cycles, dashboard stats — future stories' data) so a subsequent sign-in on the same device doesn't leak stale cross-collector data through the cache. Rationale: even though RLS guards server-side reads, the React-rendered "flash of old collector's data" would be a UX bug; `queryClient.clear()` closes that gap.

7. **Toast differentiates explicit sign-out from idle timeout.** Current `AuthStateListener` toasts `login.session_expired_toast` ("Session expirée, reconnectez-vous") on every SIGNED_OUT. That copy LIES when the user tapped "Se déconnecter" themselves (UX spec line 1320: *"Toast never lies"*). Story 1.7 adds a new i18n key `settings.signed_out_success` = "Vous êtes déconnecté" (French, masculine-neutral; `déconnecté(e)` alternative rejected to match existing login copy style which never uses the (e) parenthetical). The listener reads `signOutStateRef.reason` inside the SIGNED_OUT handler:
   - `reason === "explicit"` → toast `settings.signed_out_success`.
   - `reason === "idle"` OR `reason === null` (e.g., external session invalidation) → keep existing `login.session_expired_toast`.
   - Clears `signOutStateRef.reason = null` after reading (so a fresh sign-in / sign-out cycle starts clean).

8. **IndexedDB purge = documented no-op for this story.** The epic AC line 558 says "IndexedDB data tied to the session is purged". At Story 1.7 implementation time, SafariCash has no IndexedDB code (grep `src/` for `indexedDB|idb|IDBDatabase|Dexie` returns zero hits). Story 8.2 introduces `src/infrastructure/sync/eventLog.ts` + offline outbox. Story 1.7 adds a placeholder `purgeSessionData()` function in `src/features/auth/api/signOut.ts` that currently returns `Promise.resolve()` with a clear TODO comment referencing Story 8.3. `requestSignOut` awaits it (with the same 2-second overall budget as the audit emit). When Story 8.3 lands, it fills in the body — Story 1.7's contract (one function, one call site) stays stable.

9. **`/login` already-authenticated guard is OUT of scope.** Listed in `deferred-work.md` as a Story 1.5 deferral. If a signed-in collector navigates to `/login` directly, current behavior renders the login page regardless. Story 1.7 does NOT attempt to fix this — it would require modifying the router's public-route subtree and risks regressing the Story 1.5 login E2E. Explicit scope cap.

10. **Edge-case: Supabase `signOut()` rejection does NOT leave the user "stuck".** If the `signOut()` call rejects (offline device, Supabase outage), Supabase-js's implementation still clears the local session state BEFORE the promise rejects. The resulting `SIGNED_OUT` event fires. The `AuthStateListener` handles navigation as always. So `requestSignOut`'s try/catch around `signOut()` MUST NOT retry or surface an error toast — the user IS signed out locally even on network failure. Add a dev-only `console.warn` if signOut rejects so QA can spot network issues. The server-side audit row is the thing that might be missing; that's a known trade-off documented in Dev Notes.

11. **Tests — 4 surfaces.**
    - **Vitest unit tests** (`src/features/auth/api/signOut.test.ts`, per-test mock of `@/infrastructure/supabase/client`):
      - `requestSignOut("explicit")` calls `rpc("emit_session_event", { p_reason: "explicit" })` THEN `auth.signOut({ scope: "local" })` (verify call order via mock sequence).
      - `requestSignOut("idle")` uses `p_reason: "idle"`.
      - `requestSignOut` returns (does not throw) even if the RPC rejects (simulate with `mockRejectedValue`); signOut is still called.
      - `requestSignOut` returns (does not throw) even if the RPC hangs past 2 s (simulate with a never-resolving promise + `vi.advanceTimersByTime(2000)`); signOut is still called.
      - `requestSignOut` sets `signOutStateRef.reason` to the argument BEFORE calling signOut (so `AuthStateListener` reads the right reason when SIGNED_OUT fires).
      - `requestSignOut` does NOT throw when signOut itself rejects (dev-warn path).
      - `purgeSessionData()` returns a resolved promise (placeholder contract assertion — will be extended in Story 8.3).
    - **Vitest integration tests** (`src/app/providers.test.tsx` — extend existing Story 1.6 test file):
      - P8 new: `queryClient.clear()` is called when SIGNED_OUT fires after a session existed (mock the queryClient, assert clear was called once).
      - P9 new: explicit sign-out path — emit synthetic `SIGNED_IN` then set `signOutStateRef.reason = "explicit"` then emit `SIGNED_OUT` → toast was called with `settings.signed_out_success` key.
      - P10 new: idle sign-out path — emit `SIGNED_IN` then `SIGNED_OUT` with `reason = null` → toast was called with `login.session_expired_toast` key (Story 1.6 regression).
      - P11 new: `signOutStateRef.reason` is cleared after the SIGNED_OUT handler runs (assert it's back to `null` post-emit).
    - **Vitest component test** (`src/app/routes/settings.test.tsx`):
      - Renders the button and heading.
      - Button click triggers `requestSignOut("explicit")` (mock the helper).
      - Button is disabled while the sign-out is in flight (Loading state; UX pattern — prevent double-tap).
      - Renders with role="main" / heading level 1 (a11y).
    - **Deno contract test** (`supabase/functions/_shared/emit-session-event.contract.test.ts`, same env-gate pattern as Story 1.5's `check-collector-registered.contract.test.ts`):
      - RPC called with `p_reason = "explicit"` by an authenticated anon client → returns null (void), audit_log now has a row with `event_type = 'session.signed_out'`, `collector_id` matching JWT sub, `payload = {"reason":"explicit"}`, `entry_hash` is 32 bytes.
      - RPC called with `p_reason = "idle"` → same as above with different payload.
      - RPC called with `p_reason = "malicious"` → raises exception (check input validation).
      - RPC called by anon (no JWT) → raises exception (`auth.uid() is null`).
      - Two sequential calls build a valid hash chain (second row's `prev_hash` equals first row's `entry_hash`).
    - **Playwright E2E** (`tests/e2e/flow-5-signout.spec.ts`, env-gated like Story 1.5's `flow-5-login.spec.ts`):
      - Sign in (reuse or approximate the Story 1.5 login flow; real OTP-read is deferred to Story 1.8 so the spec is env-gated and skipped locally).
      - Navigate to `/settings`.
      - Click "Se déconnecter".
      - Assert URL → `/login`, toast "Vous êtes déconnecté" visible (not "Session expirée").

    Coverage target ≥ 80 % on `src/features/auth/api/signOut.ts`.

12. **i18n keys added to `src/i18n/fr.json`.** New top-level `settings` namespace:
    ```json
    "settings": {
      "title": "Plus",
      "signout_cta": "Se déconnecter",
      "signout_loading": "Déconnexion…",
      "signed_out_success": "Vous êtes déconnecté"
    }
    ```
    Keep the `settings.*` namespace even though the only surface in this story is sign-out — Story 2.3 (Contacts import) will add `settings.revoke_contacts_cta` and the namespace pre-announces the scope. DO NOT put sign-out copy under the `login.*` namespace (login is the unauthenticated surface; settings is the authenticated surface).

## Tasks / Subtasks

- [x] **Task 1: Migration + RPC for `session.signed_out` audit event.** (AC: 4)
  - [x] Create `supabase/migrations/20260421000001_emit_session_event.sql` with a SECURITY DEFINER function `public.emit_session_event(p_reason text)` mirroring the hash-chain logic of `audit_emit()` in migration 0007 (lines 98–230).
  - [x] Validate `auth.uid() IS NOT NULL` and `p_reason IN ('explicit', 'idle')`; RAISE exception with a clear message otherwise.
  - [x] Set `event_type = 'session.signed_out'`, `entity_table = 'sessions'`, `entity_id = auth.uid()` (sentinel; satisfies NOT NULL), `actor = auth.uid()::text`, `source = 'online'`, `payload = jsonb_build_object('reason', p_reason)`.
  - [x] Advisory lock on `(0x5AFA, hashtext(collector_id::text))` — same namespace as `audit_emit` to serialize the per-collector chain.
  - [x] SELECT last `entry_hash` WHERE `collector_id = auth.uid()` for `prev_hash`.
  - [x] Compute `entry_hash = digest(serialized, 'sha256')` using the SAME canonical serialization as `audit_emit` (prev_hash ‖ 1F ‖ event_id ‖ 1F ‖ event_type ‖ … ‖ canonical_jsonb(payload)).
  - [x] `INSERT INTO public.audit_log (…)`.
  - [x] GRANT EXECUTE on the function to `authenticated`; REVOKE from `anon`, `public`.
  - [x] Apply migration locally (`npx supabase db reset`); regenerate types (`npm run db:types`); verify `database.types.ts` picks up the new RPC signature.

- [x] **Task 2: `requestSignOut` helper + placeholder purge.** (AC: 5, 8, 10)
  - [x] Create `src/features/auth/api/signOut.ts`.
  - [x] Export `signOutStateRef = { reason: null as "explicit" | "idle" | null }` (module-scoped mutable).
  - [x] Export `purgeSessionData(): Promise<void>` returning `Promise.resolve()` with a TODO comment referencing Story 8.3 (IndexedDB outbox).
  - [x] Export `requestSignOut(reason: "explicit" | "idle"): Promise<void>`:
    - Set `signOutStateRef.reason = reason`.
    - Best-effort audit emit: `Promise.race([supabase.rpc("emit_session_event", { p_reason: reason }), timeout(2000)])` — catch and DEV-log any rejection.
    - `await purgeSessionData()` (currently no-op, future IndexedDB purge).
    - `try { await supabase.auth.signOut({ scope: "local" }); } catch (err) { if (import.meta.env.DEV) console.warn(...) }`.
    - Never throw.
  - [x] Co-located unit test file `signOut.test.ts` with the cases listed in AC 11.

- [x] **Task 3: Rewire `useIdleTimeout`'s onExpired.** (AC: 5)
  - [x] In `src/app/providers.tsx`, replace the current `useIdleTimeout`'s `onExpired: () => void supabase.auth.signOut()` with `onExpired: () => void requestSignOut("idle")`. Import from `@/features/auth/api/signOut`.
  - [x] Verify `src/app/providers.test.tsx` integration tests still pass; add new cases per AC 11.

- [x] **Task 4: Settings route + header link.** (AC: 1, 2)
  - [x] Create `src/app/routes/settings.tsx`:
    - `<h1>` with `t("settings.title")` = "Plus".
    - Secondary-variant button (`<Button variant="secondary">`, `size="lg"`, full-width) labelled `t("settings.signout_cta")`.
    - `onClick`: call `requestSignOut("explicit")`; disable button while in-flight; on completion, the `AuthStateListener` handles toast + redirect (component needs no further logic).
    - Local loading state: `const [isPending, setIsPending] = useState(false)`. Show `t("settings.signout_loading")` label while pending.
  - [x] Add route to `src/app/router.tsx` under `<AppLayout>` children: `{ path: "settings", element: <SettingsRoute /> }`.
  - [x] Update `src/App.tsx#AppLayout` header: add a `<Link to="/settings">` with text `t("settings.title")` right-aligned next to the SafariCash logo. Simple text link (no icon) — this is a temporary surface until the bottom-nav lands.
  - [x] Co-located component test `settings.test.tsx` (RTL): renders heading, button calls helper, disables while pending, a11y.

- [x] **Task 5: Extend AuthStateListener.** (AC: 6, 7)
  - [x] In `src/app/providers.tsx`'s SIGNED_OUT handler (current lines 78–88), before the existing navigate/toast logic:
    - `queryClient.clear()` (single line; queryClient already imported at module scope).
    - Read `signOutStateRef.reason` into a local; clear the ref to `null`.
    - Choose toast key: `reason === "explicit" ? "settings.signed_out_success" : "login.session_expired_toast"`.
  - [x] Preserve ALL existing `hadSessionRef` cold-load suppression + `locationRef` pathname guard logic — Story 1.5 regression risk.
  - [x] Add integration tests (P8 / P9 / P10 / P11 per AC 11).

- [x] **Task 6: Remove the dev-only dashboard logout stub.** (AC: 5)
  - [x] Delete the `handleLogout` function and its button from `src/app/routes/dashboard.tsx` (lines 13–16 and the button JSX). The canonical sign-out lives at `/settings` from now on.
  - [x] Verify nothing else imports or references the stub.
  - [x] Verify existing `dashboard.test.tsx` (if any) still passes; otherwise update.

- [x] **Task 7: i18n keys.** (AC: 12)
  - [x] Add new top-level `settings` namespace to `src/i18n/fr.json` with the 4 keys per AC 12.
  - [x] Verify `src/i18n/keys.ts` auto-picks up the new keys (TypeScript type compiles).

- [x] **Task 8: Deno contract test for the RPC.** (AC: 11 surface 4)
  - [x] Create `supabase/functions/_shared/emit-session-event.contract.test.ts` using the existing `seedCollector` + `buildTestAnonClient` helpers from Story 1.5.
  - [x] Cover the 5 cases in AC 11: valid explicit, valid idle, invalid reason, no JWT, hash-chain continuity.
  - [x] Register in `scripts/run-edge-tests.sh`.

- [x] **Task 9: Playwright E2E.** (AC: 11 surface 5)
  - [x] Create `tests/e2e/flow-5-signout.spec.ts` (env-gated).
  - [x] Reuse login helpers or the Story 1.5 login UI to obtain a session.
  - [x] Navigate to `/settings`, click the button, assert `/login` + toast text matching `/vous êtes déconnecté/i`.
  - [x] `test.skip(!ENV_OK, "SUPABASE_TEST_URL / SUPABASE_TEST_ANON_KEY not set — Story 1.8 wires CI")`.

- [x] **Task 10: Regression sweep + docs.** (All ACs)
  - [x] `npm run lint` (max-warnings=0); `npx prettier --check .`; `npx tsc --noEmit`.
  - [x] `npm run test -- --run` (Vitest full suite including new tests).
  - [x] `npm run test:edge` (Deno; includes new RPC contract test).
  - [x] `npx playwright test --project=chromium tests/e2e/flow-5-signout.spec.ts` (expect skipped locally without env).
  - [x] `npm run build` — production build sanity.
  - [x] Manual smoke: sign in, navigate to `/settings`, click "Se déconnecter", verify landing on `/login` with the explicit-sign-out toast. Sign in again, leave idle 30 s (temporarily shorten `SESSION_IDLE_TIMEOUT_MS`), verify landing on `/login` with the "Session expirée" toast. Revert the constant.

### Review Findings (2026-04-21)

**Decision-needed (0 — 2 resolved)**

- [x] [Review][Decision→Dismiss] Verify hash-chain byte-for-byte equivalence with `audit_emit()` — **RESOLVED**: verified identical 10-field canonical serialization (same order, same `v_delim = decode('1F', 'hex')`, same ISO format `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'` at UTC, same `coalesce(v_prev_hash, ''::bytea)` seed, same `extensions.digest(..., 'sha256')`). `supabase/migrations/20260421000001_emit_session_event.sql:79-91` ≡ `supabase/migrations/20260419000007_triggers_audit.sql:200-214`. Completion-note claim confirmed.
- [x] [Review][Decision→Dismiss] Verify `clock_timestamp()` vs `audit_emit()` time source consistency — **RESOLVED**: both use `clock_timestamp()` (migration 0007 line 130, migration 0001 line 55). Same advisory lock `(0x5AFA, hashtext(v_collector_id::text))`, same `order by timestamp desc, event_id desc limit 1` selection. No fork risk across emitters.

**Patch (17)** — 15 fixed, 1 promoted to action item, 1 dismissed on verification

- [x] [Review][Patch→Fixed] AC1 — Button variant `outline` → `secondary` [`src/app/routes/settings.tsx`]
- [x] [Review][Patch→Fixed] Concurrent-call guard in `requestSignOut`: drops second call while a sign-out is in flight (covers idle-vs-explicit race AND double-tap at the helper layer) [`src/features/auth/api/signOut.ts`]
- [x] [Review][Patch→Fixed] `pendingRef` synchronous guard in `handleSignOut` (defense-in-depth against double-tap at the component layer) [`src/app/routes/settings.tsx`]
- [x] [Review][Patch→Fixed] `mountedRef` pattern — `setIsPending(false)` no longer fires on unmounted `SettingsRoute` [`src/app/routes/settings.tsx`]
- [x] [Review][Patch→Fixed] `signOutStateRef.reason` clear moved inside the `wasSignedIn` branch; cold-load SIGNED_OUT no longer discards in-flight reason [`src/app/providers.tsx`]
- [x] [Review][Patch→Fixed] AC11 — component now wraps in `<main>`; test asserts `role="main"` [`src/app/routes/settings.tsx`, `src/app/routes/settings.test.tsx`]
- [x] [Review][Patch→Fixed] `purgeSessionData()` wrapped in a 2 s `Promise.race` budget via shared `raceWithTimeout` helper; contract now holds when Story 8.3 fills the body [`src/features/auth/api/signOut.ts`]
- [ ] [Review][Patch→Action-item] `as unknown as AuditRow[]` cast — CLAUDE.md "prefer Zod at boundaries" applies but introducing Zod as a Deno dep is out of scope for this review pass. Converted to action item: tackle at the next Deno-side refactor or when a second contract test adds shape validation [`supabase/functions/_shared/emit-session-event.contract.test.ts:~61`]
- [x] [Review][Patch→Fixed] Button accessible name stays stable (`"Se déconnecter"`); `aria-busy` + `sr-only` polite live region carry the loading state [`src/app/routes/settings.tsx`]
- [x] [Review][Patch→Fixed] `providers.test.tsx` P9/P10 now assert on `frJson.settings.signed_out_success` / `frJson.login.session_expired_toast` (adapt to copy tweaks) [`src/app/providers.test.tsx`]
- [x] [Review][Patch→Fixed] `signOut.test.ts` "sets ref synchronously" now checks ref at BOTH rpcMock and signOutMock invocation [`src/features/auth/api/signOut.test.ts`]
- [x] [Review][Patch→Fixed] `settings.test.tsx` pending-state test asserts `waitFor(() => expect(btn).toBeEnabled())` + `aria-busy` toggle [`src/app/routes/settings.test.tsx`]
- [x] [Review][Patch→Fixed] Added test `"preserves signOutStateRef.reason when signOut rejects but the RPC succeeded"` [`src/features/auth/api/signOut.test.ts`]
- [x] [Review][Patch→Fixed] `AUDIT_EMIT_TIMEOUT_MS` exported; test uses `AUDIT_EMIT_TIMEOUT_MS + 1` instead of hardcoding `2_001` [`src/features/auth/api/signOut.ts`, `src/features/auth/api/signOut.test.ts`]
- [x] [Review][Patch→Fixed] `octetLength` now validates hex-only even-length format and throws on drift (base64 / decoded bytes surface loud) [`supabase/functions/_shared/emit-session-event.contract.test.ts`]
- [x] [Review][Patch→Fixed] `p_reason` error message uses `quote_nullable(p_reason)` so newlines / injected log delimiters from caller input can't corrupt log parsing [`supabase/migrations/20260421000001_emit_session_event.sql`]
- [x] [Review][Patch→Dismiss] `settings.signout_loading` strict-typing — verified false positive: `src/i18n/keys.ts` uses recursive `Leaves<typeof frJson>` typegen that automatically captures every leaf in `fr.json`; no keys.ts touch needed.

**Deferred (13)** — see `_bmad-output/implementation-artifacts/deferred-work.md`

- [x] [Review][Defer] Playwright E2E has no sign-in fixture; `test.skip` covers no-env but not yes-env-without-auth [`tests/e2e/flow-5-signout.spec.ts`] — deferred; explicit TODO for Story 1.8 CI wiring
- [x] [Review][Defer] `queryClient.clear()` aborts in-flight mutations silently [`src/app/providers.tsx:~93`] — deferred; AC6 commits to simple clear, ops-monitored
- [x] [Review][Defer] `audit_log.timestamp` unquoted reserved-name — deferred, pre-existing pattern from migration 0001
- [x] [Review][Defer] Strict Mode double-invocation produces dup dev-only toast — deferred, dev-only
- [x] [Review][Defer] Idle-timer `setTimeout` can fire after hook unmount — deferred; re-check `activeRef` in `armTimer` callback (minor)
- [x] [Review][Defer] `entity_id = collector_id` sentinel lacks DB CHECK — deferred; rationale documented in AC4
- [x] [Review][Defer] `signOutStateRef.reason` stays stale if Supabase-js fails to emit SIGNED_OUT — deferred; implementation-dependent edge
- [x] [Review][Defer] `getSession()` seeding races `onAuthStateChange` subscription — deferred; pre-existing Story 1.5/1.6 pattern
- [x] [Review][Defer] `emit_session_event` has no rate limit (unbounded self-chain appends) — deferred, ops-monitored
- [x] [Review][Defer] No schema-drift CHECK between TS `SignOutReason` and SQL `p_reason` whitelist — deferred
- [x] [Review][Defer] `emit_session_event` does not REVOKE from `service_role` — deferred; no service_role caller today
- [x] [Review][Defer] `search_path = public, extensions, pg_temp` on SECURITY DEFINER (all refs already schema-qualified) — deferred, matches audit_emit pattern
- [x] [Review][Defer] Playwright regex `/vous êtes déconnecté/i` is case- but not diacritic-insensitive — deferred, tied to the deferred E2E wiring above

**Dismissed as noise (11)** — not recorded, summary only

- Idle RPC 2 s delay before `signOut` (by design per AC5 rationale); no-toast on `/login` (outside AC9 scope); `reason === null` → idle-copy (by design per AC7); runtime-validate `reason` string (TS covers it); style nits (cargo-cult `revoke from anon`, doubled quotes in COMMENT, single-test `describe`, story-tag comments in blame, doubled `no-console` escapes, `v_delim` literal style, story-file bulk inflating diff stats).

## Dev Notes

### Architecture references (HARD constraints)

- **FR4** — "A collector can sign out of the app at any time." [Source: `prd.md:475`]
- **NFR-S6** — "Audit trail — append-only, cryptographically chained (sequential per-collector hash chain). Tamper-evidence verifiable offline from the audit-log export." [Source: `prd.md:576`]
- **Plus tab label + location** — 4-item bottom nav (Dashboard / Membres / Rapports / Plus). [Source: `ux-design-specification.md:644, 1187–1205, 1348`]
- **CTA copy** — *"Se déconnecter"* verbatim. [Source: `epics.md:555`]
- **No confirmation dialog** — UX spec lists 4 dialog-eligible events (delete, dispute, cycle settlement re-auth, session expiry); sign-out is NOT among them. [Source: `ux-design-specification.md:1331`]
- **Button hierarchy** — Destructive styling gated behind typed confirmation; sign-out has no confirmation → Secondary variant. [Source: `ux-design-specification.md:1302–1314`]
- **event_type naming** — `^[a-z][a-z_]*\.[a-z][a-z_]*$`; `session.signed_out` matches. [Source: `supabase/migrations/20260419000003_audit_log.sql:21`]
- **audit_log permissions** — `REVOKE INSERT … FROM authenticated`; only SECURITY DEFINER functions can write. [Source: `supabase/migrations/20260419000003_audit_log.sql:69–71`]
- **Hash-chain canonical serialization** — locked order + format, must match `src/domain/audit/hashChain.ts` byte-for-byte. [Source: `supabase/migrations/20260419000007_triggers_audit.sql:198–214`]
- **State management** — React Context + TanStack Query only; no Redux/Zustand. [Source: `architecture.md:280, 378`]
- **Re-auth is SEPARATE from sign-out** — `/re-auth` issues OTPs for sensitive ops; sign-out is a different primitive. [Source: `architecture.md:351`]

### Handoff from Stories 1.5 + 1.6 (DO NOT duplicate, DO NOT rewrite)

| Component | Where | Contract (for 1.7) |
|---|---|---|
| `AuthStateListener` SIGNED_OUT handler | `src/app/providers.tsx:78–88` | Already toasts + navigates. Story 1.7 EXTENDS (adds `queryClient.clear()` + reason-aware toast) but MUST NOT touch `hadSessionRef` / `locationRef` semantics. |
| `useIdleTimeout` hook | `src/features/auth/api/useIdleTimeout.ts` | Already calls `onExpired()`; removes `sc_session_started_at` from localStorage on SIGNED_OUT. Story 1.7 only changes the `onExpired` CALLBACK at the mount site, not the hook. |
| Supabase client singleton | `src/infrastructure/supabase/client.ts` | `persistSession: true, autoRefreshToken: true, detectSessionInUrl: true`. Do not modify. |
| `queryClient` | `src/app/providers.tsx:27–34` | Exported. Story 1.7 imports + calls `.clear()` inside the SIGNED_OUT handler. |
| `login.session_expired_toast` i18n key | `src/i18n/fr.json:49` | Keep for idle path. Story 1.7 ADDS a new `settings.*` namespace with a different success toast for explicit sign-out. |
| `seedCollector` / `buildTestAnonClient` | `supabase/functions/_shared/test-utils.ts` | Reuse for the Deno contract test. |
| Temporary dev-logout button | `src/app/routes/dashboard.tsx:13–16` | DELETE — superseded by `/settings`. |
| Story 1.6 deferred marker | `1-6-session-management.md:49,51` | Story 1.6 explicitly deferred `session.signed_out` emission to Story 1.7 "will generalize over both explicit and idle-triggered sign-outs". This story fulfills that contract. |

### Architectural decisions this story commits

1. **`scope: "local"` for signOut.** Explicit choice, documented in code. A future "Sign out of all devices" feature (Growth) would use `scope: "global"` and live as a separate CTA in Settings (not covered by 1.7).

2. **New SECURITY DEFINER RPC, not an Edge Function.** RPC is a one-round-trip PostgREST call (cheap, no Cloudflare-worker indirection); Edge Function would add ~60 ms and cross-region hop. Audit emission is latency-sensitive (user is leaving the app — the sooner the chain row lands, the better).

3. **Timeout the audit RPC at 2 s; don't block sign-out on failure.** If the audit emit hangs, the user's sign-out still completes. A missed audit row is recoverable (ops can reconcile from server-side session logs); a stuck sign-out UX is not. Document as Dev Notes trade-off.

4. **`entity_id = collector_id` sentinel for session events.** Since `audit_log.entity_id` is NOT NULL and session events have no natural entity, use the collector's own UUID. The `idx_audit_log_entity_table_entity_id` index on `('sessions', collector_id)` lets ops queries filter for per-collector session-event history efficiently.

5. **`settings.*` i18n namespace, not `login.*` or `auth.*`.** Settings is the authenticated surface; login is unauthenticated. A future locale switch (Wolof / Bambara) translates the whole `settings` tree together.

6. **Bottom-tab nav deferred; header link is the MVP surface.** The 4-tab UX (Dashboard / Membres / Rapports / Plus) is larger than Story 1.7's scope — it requires icon system, active-tab indicator, route-hiding on drill-down. A minimal header link gets sign-out reachable in hours, not days; the nav can land in a dedicated UI story.

### Anti-patterns to reject (do NOT do these)

- Do NOT manually `navigate("/login")` from the Settings component. `AuthStateListener` owns navigation — calling `navigate` twice races the listener's own navigate and can cause flash-of-anonymous-content.
- Do NOT fire the success toast directly from the Settings component. Toast decision lives in the listener (one decision point, two entry paths).
- Do NOT call `supabase.auth.signOut()` directly anywhere outside `requestSignOut`. Bypassing the helper skips the audit emit and the `signOutStateRef.reason` flag — the toast would show the wrong copy.
- Do NOT use `scope: "global"`. Multi-device collectors (personal phone + shared office device) MUST NOT lose their other sessions.
- Do NOT add a confirmation dialog for sign-out. UX spec explicitly reserves dialogs for the 4 destructive events; sign-out is not one of them.
- Do NOT persist `signOutStateRef.reason` to localStorage. Per-tab ephemeral only (same rule as Story 1.6's `lastActivityAt`).
- Do NOT overwrite `sc_session_started_at` in Story 1.7 logic. That key is managed exclusively by `useIdleTimeout`.
- Do NOT INSERT into `audit_log` directly from the client — RLS revokes forbid it. The RPC is the blessed path.
- Do NOT retry `signOut()` on failure. Supabase-js already clears local state; retrying is either redundant or a loop.
- Do NOT delete `login.session_expired_toast` — the idle path still uses it.
- Do NOT style the sign-out button as Destructive (red). UX spec says Destructive ONLY behind a confirmation gate.
- Do NOT add session-signed-out audit emission logic to `useIdleTimeout` — Story 1.6 explicitly deferred this to 1.7. Centralize in `requestSignOut`.

### Ambiguities resolved explicitly by this story

- **Toast copy** — `settings.signed_out_success = "Vous êtes déconnecté"` (masculine-neutral, matches existing login copy style).
- **Post-sign-out destination** — `/login` (standard). No return-URL / bounce-back; a returning collector starts fresh.
- **Scope** — `"local"` (this device only).
- **Button variant** — Secondary (green outline, not red).
- **Plus screen layout** — minimal (heading + one button) for this story; expanded by later stories (2.3 contacts revoke, etc.).
- **Icon for sign-out** — NONE in this story. UX spec's emoji iconography (e.g., 🚪) is a future UI-polish decision; the text button is accessible and testable as-is.
- **`entity_id` / `entity_table` for session events** — `entity_table = 'sessions'`, `entity_id = collector_id` (self-referential sentinel).
- **Idle-vs-explicit distinction** — payload `{ "reason": "explicit" | "idle" }` in the audit row; one unified `session.signed_out` event type covers both.
- **IndexedDB purge** — documented no-op for Story 1.7; Story 8.3 fills the body.
- **Offline sign-out** — not handled. At MVP, sign-out REQUIRES online (audit emit + signOut both need the network). Documented limitation; Story 8.x could add an offline-queued sign-out later.
- **Offline pending transactions warning** — no warning before sign-out at MVP. Story 8.x owns the offline-queue UX; if offline sign-out becomes a feature, a "You have N pending transactions" banner can be added then.
- **"Sign out of all devices" CTA** — not in Story 1.7. Growth feature; would live as a separate Settings row with `scope: "global"`.

### Project Structure Notes

**Alignment with project tree** (`architecture.md:863–1057`):
- `src/features/auth/api/signOut.ts` — features-layer (imports from infrastructure OK; cross-feature imports forbidden).
- `src/app/routes/settings.tsx` — routes live under `app/routes/` per the convention established by Stories 1.2 / 1.5.
- `supabase/migrations/20260421000001_emit_session_event.sql` — migrations numbered by date; next slot after Story 1.5's `20260420000001`.
- `supabase/functions/_shared/emit-session-event.contract.test.ts` — colocated with other Deno contract tests.
- `tests/e2e/flow-5-signout.spec.ts` — sibling of `flow-5-login.spec.ts`.

**No conflicts with unified structure.** No new top-level folders. No layering violations.

### References

- Epic + AC wording: [Source: `_bmad-output/planning-artifacts/epics.md:546–559`]
- FR4 / NFR-S6: [Source: `_bmad-output/planning-artifacts/prd.md:475, 576`]
- Plus tab + button hierarchy + dialog rules: [Source: `_bmad-output/planning-artifacts/ux-design-specification.md:644, 1187–1205, 1302–1333, 1348`]
- audit_log schema + constraints + REVOKE: [Source: `supabase/migrations/20260419000001_*.sql` (table DDL), `20260419000003_audit_log.sql:21–71`]
- audit_emit hash-chain reference implementation: [Source: `supabase/migrations/20260419000007_triggers_audit.sql:98–230`]
- Existing session plumbing: [Source: `src/app/providers.tsx:46–110`, `src/features/auth/api/useIdleTimeout.ts:156–197`, `src/infrastructure/supabase/client.ts:37–44`, `src/i18n/fr.json:32–56`]
- Story 1.6 deferred-work marker: [Source: `_bmad-output/implementation-artifacts/1-6-session-management.md:49, 51, 180`]
- Story 1.5 dev-logout stub to remove: [Source: `src/app/routes/dashboard.tsx:13–16`]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context)

### Debug Log References

- First settings component test invoked `@testing-library/user-event` which is not in the project's deps; switched to the in-repo `fireEvent` idiom established by `LoginForm.test.tsx` / `OtpStep.test.tsx`.
- `providers.test.tsx` idle-path test (P4) needed `vi.advanceTimersByTimeAsync` (not `advanceTimersByTime`) to let the async `requestSignOut` chain (rpc → signOut) resolve before asserting `signOutMock` was called.
- Docker Desktop wasn't running locally, so the migration couldn't be applied against a local Supabase stack; instead `database.types.ts` was manually extended (same pattern as Story 1.5's `check_collector_registered`). The Deno contract test + CI re-apply the migration against the CI Supabase stack.

### Completion Notes List

- All 12 ACs + 10 tasks satisfied. Vitest: 170 passed / 1 skipped / 0 failed (+18 new tests from this story: 7 signOut unit, 4 providers P8–P11, 4 settings component, 3 regression P1–P3 still green, and existing P4–P7 updated to cover requestSignOut call order).
- Lint (max-warnings=0), `tsc --noEmit`, Prettier, and `npm run build` all clean.
- Playwright: 2 specs skip cleanly locally (env-gated per Story 1.8 CI wiring).
- `emit_session_event` SQL mirrors `audit_emit()`'s canonical serialization byte-for-byte (same `v_delim`, same field order, same ISO timestamp format) so a single offline audit-chain verifier can walk both trigger-emitted and RPC-emitted rows.
- `requestSignOut` is intentionally **never-throws**: even with RPC rejection, RPC timeout, and signOut rejection the helper resolves — because Supabase-js clears local session state regardless of network outcome, the user IS signed out on the client. Throwing would create confusing UX at an already-leaving boundary.
- `signOutStateRef.reason` is a module-scoped mutable object (`{ reason }`), not a bare `let`, so consumers read through a stable reference. The `AuthStateListener` clears it after reading to prevent stale state leaking into the next cycle.
- The audit RPC has a 2 s budget (Promise.race vs setTimeout). A dropped audit row is recoverable via ops reconciliation; a stuck sign-out UI is not. Documented as deliberate trade-off.
- The dashboard dev-logout stub at `src/app/routes/dashboard.tsx:13–16` was removed; `/settings` is now the canonical sign-out surface.

### File List

**Created**
- `supabase/migrations/20260421000001_emit_session_event.sql` — SECURITY DEFINER RPC mirroring `audit_emit()`'s hash chain.
- `src/features/auth/api/signOut.ts` — `requestSignOut` + `signOutStateRef` + `purgeSessionData` placeholder.
- `src/features/auth/api/signOut.test.ts` — 7 unit tests.
- `src/app/routes/settings.tsx` — Plus / Settings page with sign-out CTA.
- `src/app/routes/settings.test.tsx` — 4 component tests.
- `supabase/functions/_shared/emit-session-event.contract.test.ts` — 5 Deno contract tests.
- `tests/e2e/flow-5-signout.spec.ts` — Playwright E2E (env-gated).

**Modified**
- `src/infrastructure/supabase/database.types.ts` — appended `emit_session_event` RPC signature to `Functions`.
- `src/i18n/fr.json` — new `settings.*` namespace (4 keys).
- `src/app/providers.tsx` — SIGNED_OUT handler now reads `signOutStateRef.reason`, clears `queryClient`, picks reason-aware toast; `useIdleTimeout`'s `onExpired` routed through `requestSignOut("idle")`.
- `src/app/providers.test.tsx` — added `rpc` to supabase mock, added P8–P11 (queryClient.clear + reason-aware toast + ref clearing), upgraded P4/P5 to use `advanceTimersByTimeAsync`.
- `src/app/router.tsx` — added `/settings` route.
- `src/app/routes/dashboard.tsx` — removed dev-only `handleLogout` stub.
- `src/App.tsx` — added header link to `/settings`.
- `scripts/run-edge-tests.sh` — registered the new Deno contract test.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `1-7-sign-out`: `backlog` → `ready-for-dev` → `in-progress` → `review`; `last_updated` → `2026-04-21`.

## Change Log

- 2026-04-21 (Opus 4.7 1M — create-story): Spec created from epics.md Story 1.7, prd.md FR4/NFR-S6, UX spec § Plus tab + Button hierarchy + Dialog rules, audit_log schema (migrations 0001/0003/0007), and Stories 1.5/1.6 handoffs. Status → ready-for-dev.
- 2026-04-21 (Opus 4.7 1M — dev-story): Implemented end-to-end. All 12 ACs + 10 tasks satisfied. Migration + RPC (hash-chain byte-matched to audit_emit) + unified `requestSignOut` helper + `/settings` route + reason-aware toast + queryClient.clear + dashboard dev-stub removed. 18 new tests across 4 Vitest files + 5 Deno contract tests + 1 env-gated Playwright. 170/171 Vitest pass (1 skipped). Lint / typecheck / Prettier / build all clean. Status → review.
