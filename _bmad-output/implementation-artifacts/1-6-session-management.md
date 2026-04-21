# Story 1.6: Session management with idle timeout and refresh

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector (Ibrahim) using the SafariCash app day-long and across multiple app reloads**,
I want **my session to persist silently while I'm active, expire after 30 min of inactivity, and hard-expire 30 days after first sign-in**,
so that **I don't re-enter my phone+OTP every hour, AND if I leave my phone unattended on a table (or it gets stolen), the session dies before anyone can exfiltrate saver data (NFR-S4, FR6)**.

## Acceptance Criteria

1. **Idle-timeout policy: 30 min of no user input → automatic sign-out.** A collector signed in to the app triggers an automatic sign-out after exactly `SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000` ms (30 min) of no user interaction. "User interaction" means any of: `mousedown`, `keydown`, `touchstart`, `scroll` at the window level. When the timeout fires, the app calls `supabase.auth.signOut()` — the *existing* `AuthStateListener` in `src/app/providers.tsx` (landed by Story 1.5) catches the resulting `SIGNED_OUT` event, toasts `login.session_expired_toast` (*"Session expirée, reconnectez-vous"*, French exact wording per `architecture.md#Session / Auth` line 655 and `src/i18n/fr.json` line 49), and navigates to `/login` via React Router. Story 1.6 does NOT re-implement the toast or the navigation — it *arms the timer that triggers the sign-out*.

2. **Activity resets the idle timer without leaking per-event state.** Each qualifying activity event restamps an in-memory `lastActivityAt = Date.now()` value and recalibrates a single `setTimeout` to fire at `lastActivityAt + SESSION_IDLE_TIMEOUT_MS`. Activity events are registered on `window` with `{ capture: true, passive: true }` and are DEBOUNCED via a 1-second trailing-edge guard (`ACTIVITY_DEBOUNCE_MS = 1000`) so a scrolling user does not cause 60 timer resets per second. The debounce must be leading-stamp + trailing-recalibrate (i.e., `lastActivityAt` updates on every event so the computed expiry is always accurate; only the expensive `clearTimeout` + `setTimeout` call is debounced). Do NOT store `lastActivityAt` in localStorage — idle state is per-tab and per-mount; persisting it would survive reloads (wrong semantics) and leak across concurrent users on a shared device.

3. **Absolute 30-day lifetime: client-side guard + server-side Supabase Auth config (defense in depth).** The policy from NFR-S4 (`prd.md` line 573) is "absolute session lifetime 30 days with silent refresh if active." The story implements BOTH halves:

   (a) **Client-side guard** — on `SIGNED_IN` event (or on initial session detection if a session already exists on page load), persist `sessionStartedAt` (ISO 8601 string) to `localStorage` under key `sc_session_started_at`. On app load AND whenever the idle-timer effect runs a check, compute `Date.now() - Date.parse(sessionStartedAt)` — if `≥ SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000`, immediately call `supabase.auth.signOut()`. On `SIGNED_OUT`, delete the key. The key is a defense-in-depth guard; the server-side Supabase Auth config is the authoritative enforcement. If the two disagree, the earliest expiry wins (fail-closed).

   (b) **Server-side operator runbook** — add a new section to `README.md` (or a new `docs/session-management.md` if the runbook grows past a paragraph) documenting that the Supabase Auth project config MUST set `auth.jwt_expiry` ≤ 3600 s (1 h) AND refresh-token rotation/reuse-detection enabled. The 30-day absolute lifetime in Supabase Auth is governed by the refresh-token lifetime (`GOTRUE_JWT_EXP` for access, refresh-token max age for refresh). At MVP, confirm the cloud project's Auth settings; document exact field names + desired values. The dev does NOT need to write Supabase migrations for this — it's a dashboard setting.

4. **Silent token refresh already works — this story only adds observability.** `src/infrastructure/supabase/client.ts` already sets `autoRefreshToken: true` (Story 1.2), so Supabase Auth silently refreshes the access JWT ~60 s before expiry and emits `TOKEN_REFRESHED` via `onAuthStateChange`. Story 1.6 does NOT call `supabase.auth.refreshSession()` manually (double-refresh is an anti-pattern — wastes Supabase quota + may thrash client state). The story DOES add a `console.debug` (dev-only, gated by `import.meta.env.DEV`) + a structured event `session.token_refreshed` to the `AuthStateListener`'s `onAuthStateChange` callback so QA can verify refresh is firing on the expected cadence. No user-facing UI for refresh events — silent by design.

5. **All timer + activity logic lives in a new `useIdleTimeout` hook.** New file `src/features/auth/api/useIdleTimeout.ts` exports `useIdleTimeout({ idleMs, absoluteLifetimeMs, onExpired })` returning void. The hook:
   - On mount: reads the current Supabase session (sync from `supabase.auth.getSession()`); if present, seeds `lastActivityAt = Date.now()` and arms the timer.
   - Subscribes to `onAuthStateChange`: on `SIGNED_IN`, persists `sessionStartedAt` to localStorage and re-arms; on `SIGNED_OUT`, cancels the timer and clears `sessionStartedAt`; on `TOKEN_REFRESHED`, emits the dev-debug log (AC #4).
   - Registers window-level event listeners (`mousedown`, `keydown`, `touchstart`, `scroll`) during active-session state; UN-registers them while anonymous (small perf win + cleaner event flow).
   - On timer fire, calls `onExpired()` (which the caller sets to `() => supabase.auth.signOut()`).
   - Absolute-lifetime check runs on mount AND on every idle-timer fire (cheap read of localStorage — no need for a separate interval).
   - Cleanup on unmount: cancel timer, remove listeners, unsubscribe from `onAuthStateChange`.

   The hook is mounted ONCE, in the body of `AuthStateListener` in `src/app/providers.tsx` (which is itself mounted inside the router via `<RouterRoot>`). Do NOT mount it in every route component — a single global subscription is the correct architecture.

6. **Integration into `AuthStateListener` preserves Story 1.5's cold-load suppression.** The existing `AuthStateListener` effect uses `hadSessionRef` to suppress the "Session expirée" toast on initial page load when Supabase emits a spurious `SIGNED_OUT` for a never-present session (`src/app/providers.tsx` lines 48–55). Story 1.6's idle-timeout, by calling `supabase.auth.signOut()` *only when a session is active* (guarded by `supabase.auth.getSession()` returning non-null), produces a `SIGNED_OUT` event where `hadSessionRef.current === true` — so the toast+redirect fire correctly. The dev MUST NOT modify `hadSessionRef` semantics. If the new `useIdleTimeout` hook is added to the same component body as the existing effect, the ORDER must be: existing effect (auth-state listener) first, `useIdleTimeout` second — so the auth-state subscription is active when the idle-timeout's `signOut()` fires.

7. **Constants added to `src/lib/constants.ts`.** Append:
   ```ts
   // NFR-S4 — collector session policy.
   export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
   export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
   export const SESSION_ACTIVITY_DEBOUNCE_MS = 1000; // debounce activity events
   export const SESSION_STARTED_AT_STORAGE_KEY = "sc_session_started_at";
   ```
   DO NOT hard-code these numbers anywhere else. Tests that need to drive faster timer scenarios import the constants and override via function arg (the `useIdleTimeout` hook accepts `idleMs` + `absoluteLifetimeMs` as overridable options for testability).

8. **Behavior while offline: idle timer continues running (no pause).** The PRD does NOT explicitly address idle-timer behavior during offline periods. This story commits to the simpler semantics: "idle" means "no user input events have fired," independent of connectivity. A collector offline but actively tapping the screen resets the timer; a collector offline and inactive for 30 min is signed out. Rationale: (a) matches the plain-English reading of NFR-S4 ("no activity" = no user input); (b) pausing the timer offline would let a stolen phone keep a session alive indefinitely in airplane mode (attack surface); (c) avoids coupling the idle logic to the connectivity module (Story 8.1 owns `<ConnectivityIndicator>`). The local event-log / outbox (Story 8.3) is NOT purged on idle sign-out — only Story 1.7 (explicit sign-out) owns IndexedDB purge. Document this explicitly in a Dev Notes entry so a future maintainer sees the trade-off.

9. **No audit-log emission in this story.** The architecture (`architecture.md#Enforcement Guidelines` line 690) requires audit-log events for "state-mutating operations." A session expiry is a state TRANSITION but not a data mutation — no row in `users`/`members`/`transactions`/`cycles` changes. Story 1.7 (explicit sign-out) is the designated owner of the `session.signed_out` audit event per `epics.md#Story 1.7` — it will generalize over both explicit and idle-triggered sign-outs. Story 1.6 deliberately does NOT insert into `audit_log` to avoid schema churn before 1.7 lands. Dev MUST NOT add audit emission in this story even if it seems "consistent" — premature coupling.

10. **Tests — 3 surfaces.**
    - **Vitest unit tests** (`src/features/auth/api/useIdleTimeout.test.tsx`, React Testing Library + `vi.useFakeTimers()`):
      - Timer fires `onExpired` after `idleMs` elapses with no activity (advance timers, assert callback called once).
      - Activity events (`mousedown`, `keydown`, `touchstart`, `scroll`) reset the timer (advance timers to `idleMs - 1`, dispatch event on window, advance another `idleMs - 1`, assert `onExpired` NOT called; advance one more ms, assert called).
      - Debounce: 100 activity events within 100 ms produce only ONE `clearTimeout + setTimeout` pair (spy on `setTimeout`, assert call count ≤ 2: initial arm + post-debounce recalibration).
      - Absolute lifetime: mount with `localStorage.sessionStartedAt` dated 31 days ago → `onExpired` called synchronously on mount.
      - `SIGNED_IN` event → persists `sessionStartedAt`; `SIGNED_OUT` event → clears it.
      - `TOKEN_REFRESHED` event → does NOT reset idle timer (token refresh is not user activity).
      - Cleanup on unmount: window listeners removed (add listener → unmount → dispatch event → assert no state change).
    - **Vitest integration test** (`src/app/providers.test.tsx`) — lifts from or extends the Story 1.5 provider tests:
      - Mount `AuthStateListener` with a mocked Supabase client; simulate `SIGNED_IN`, wait for idle timer to fire (fake timers), assert `supabase.auth.signOut()` was called; then simulate `SIGNED_OUT`, assert the existing toast+navigate fires (regression check on Story 1.5's hadSessionRef + pathname guard).
    - **Playwright E2E** (`tests/e2e/session-idle-timeout.spec.ts`, env-gated like Story 1.5's `flow-5-login.spec.ts`):
      - Seed a collector (reuse the existing `seedCollector` helper pattern from `supabase/functions/_shared/test-utils.ts` adapted for Playwright's context, OR use the Story 1.5 login flow to obtain a session).
      - Use Playwright's clock API (`page.clock.install()` / `page.clock.fastForward()`) to advance time past 30 min without actually waiting.
      - Assert the URL becomes `/login` and the toast `Session expirée, reconnectez-vous` is visible.
      - Test skipped (`test.skip(!ENV_OK, ...)`) if `SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY` are unset — same env-gate pattern as Stories 1.3, 1.4, 1.5. CI wiring follows Story 1.8.

    **Coverage gate:** ≥ 80 % on `src/features/auth/api/useIdleTimeout.ts` (architecture.md line 684 — 100 % is domain-only, not features). No coverage gate on the Playwright spec.

11. **Operator documentation — Supabase Auth config.** Update root `README.md` § Operator Runbook (or create `docs/session-management.md` if the README gets bulky) with a short section:
    > ### Session policy (NFR-S4)
    > SafariCash enforces a 30-minute idle timeout (client-side, via `useIdleTimeout`) and a 30-day absolute lifetime (dual-enforced: client-side via `localStorage.sc_session_started_at`, server-side via Supabase Auth).
    >
    > **To configure the server side:**
    > 1. Supabase Dashboard → Auth → Providers → Phone → (enabled, per Story 1.5).
    > 2. Supabase Dashboard → Auth → Settings → `JWT expiry time`: set to 3600 s (1 h) — this is the access-token lifetime; Supabase auto-refreshes within this window.
    > 3. Supabase Dashboard → Auth → Settings → `Refresh token reuse interval` / `Refresh token rotation`: enable rotation; set absolute refresh-token lifetime to 2 592 000 s (30 days).
    > 4. Verify with `supabase projects config get --ref <project>` after applying.
    >
    > **Why both client + server enforcement:**
    > A misconfigured Supabase dashboard (e.g., 90-day refresh token) would silently extend the session past NFR-S4's 30-day policy. The client-side `sc_session_started_at` guard fails closed — it signs the user out at 30 days even if the server would allow more.

    The exact Supabase dashboard field names MUST be verified against the current Supabase UI at implementation time (they change between Supabase versions); if the names differ, document the actual names in the runbook.

## Tasks / Subtasks

- [x] **Task 1: Constants + types.** (AC: 7)
  - [x] Append `SESSION_IDLE_TIMEOUT_MS`, `SESSION_ABSOLUTE_LIFETIME_MS`, `SESSION_ACTIVITY_DEBOUNCE_MS`, `SESSION_STARTED_AT_STORAGE_KEY` to `src/lib/constants.ts` with the exact values in AC #7.
  - [x] If a session-related types file doesn't already carry it, add `IdleTimeoutConfig = { idleMs: number; absoluteLifetimeMs: number; onExpired: () => void | Promise<void> }` to `src/features/auth/types.ts`.

- [x] **Task 2: `useIdleTimeout` hook — pure logic + listeners.** (AC: 1, 2, 5, 8)
  - [x] Create `src/features/auth/api/useIdleTimeout.ts` exporting `useIdleTimeout(config: IdleTimeoutConfig)`.
  - [x] Implement wall-clock idle detection: track `lastActivityAtRef`, single `timerRef`; `armTimer()` computes `remaining = lastActivityAt + idleMs - Date.now()` and `setTimeout(onExpired, max(0, remaining))`.
  - [x] Implement debounced activity handler: on each event update `lastActivityAtRef.current = Date.now()`; trailing-edge-debounced `armTimer()` at `SESSION_ACTIVITY_DEBOUNCE_MS`.
  - [x] Register/unregister `window` listeners (`mousedown`, `keydown`, `touchstart`, `scroll`) with `{ capture: true, passive: true }`. Register only while session is active; unregister on SIGNED_OUT and on unmount.
  - [x] Subscribe to `supabase.auth.onAuthStateChange` inside the hook; handle `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED` per AC #5 + #4.
  - [x] Cleanup in the returned effect teardown: clear timer, remove listeners, unsubscribe.

- [x] **Task 3: Absolute 30-day lifetime guard.** (AC: 3)
  - [x] On `SIGNED_IN`, write `localStorage.setItem(SESSION_STARTED_AT_STORAGE_KEY, new Date().toISOString())`.
  - [x] On mount: read the key; if present AND `Date.now() - Date.parse(value) >= absoluteLifetimeMs` → call `onExpired()` synchronously (before arming the idle timer).
  - [x] On `SIGNED_OUT`: `localStorage.removeItem(SESSION_STARTED_AT_STORAGE_KEY)`.
  - [x] Handle corrupt values defensively: `Date.parse` returning `NaN` → treat as "absent" (do not sign out, do not throw; log `console.warn` in dev).

- [x] **Task 4: Wire into `AuthStateListener`.** (AC: 6)
  - [x] In `src/app/providers.tsx`, add `useIdleTimeout({ idleMs: SESSION_IDLE_TIMEOUT_MS, absoluteLifetimeMs: SESSION_ABSOLUTE_LIFETIME_MS, onExpired: () => supabase.auth.signOut() })` inside the `AuthStateListener` function body (after the existing effect).
  - [x] Do NOT modify the existing `hadSessionRef` / `locationRef` logic — regression risk to the Story 1.5 cold-load suppression.
  - [x] Import constants from `@/lib/constants`.

- [x] **Task 5: Observability for TOKEN_REFRESHED.** (AC: 4)
  - [x] In `useIdleTimeout`'s `onAuthStateChange` callback, on `event === 'TOKEN_REFRESHED'`:
    - Dev-only `console.debug('[session] token refreshed', { at: new Date().toISOString() })` gated by `import.meta.env.DEV`.
    - Emit a structured placeholder `console.info({ event: 'session.token_refreshed', ts: new Date().toISOString() })` — production-safe, picked up by whatever log pipeline the observability story wires later.
  - [x] Do NOT call `refreshSession()` manually — Supabase's `autoRefreshToken: true` already does it.
  - [x] Do NOT reset the idle timer on `TOKEN_REFRESHED` — token refresh is not user activity.

- [x] **Task 6: Unit tests — `useIdleTimeout.test.tsx`.** (AC: 10 item 1)
  - [x] Co-located with the hook: `src/features/auth/api/useIdleTimeout.test.tsx`.
  - [x] Use `vi.useFakeTimers()` + `vi.advanceTimersByTime()`; mock `supabase.auth` (same pattern as `useLogin.test.tsx` from Story 1.5).
  - [x] Cover: timer fires on idle, activity resets, debounce, absolute-lifetime mount check, SIGNED_IN persists timestamp, SIGNED_OUT clears it, TOKEN_REFRESHED is no-op for timer, cleanup on unmount.
  - [x] Coverage ≥ 80 % on the hook file.

- [x] **Task 7: Integration test — `providers.test.tsx` regression + idle path.** (AC: 10 item 2)
  - [x] Add (or extend existing) `src/app/providers.test.tsx`. If none exists, create it alongside `providers.tsx`.
  - [x] Test 1 (regression): Story 1.5's cold-load suppression still works — mount without a prior session, emit `SIGNED_OUT`, assert NO toast + NO navigate.
  - [x] Test 2 (idle path): mount with a seeded session → advance fake timers past 30 min → assert `supabase.auth.signOut()` was called → simulate the resulting `SIGNED_OUT` event → assert toast `login.session_expired_toast` fired and navigate was called with `/login`.

- [x] **Task 8: Playwright E2E — `tests/e2e/session-idle-timeout.spec.ts`.** (AC: 10 item 3)
  - [x] Env-gated: `test.skip(!process.env.SUPABASE_TEST_URL || !process.env.SUPABASE_TEST_ANON_KEY, "CI wiring in Story 1.8")`.
  - [x] Sign in (either via Story 1.5 flow driven by test-mode OTP read from `auth.one_time_tokens` via service role, OR via Supabase Admin API to mint a session directly — pick the simpler path and document it inline).
  - [x] `await page.clock.install()`; navigate to an authenticated route; `await page.clock.fastForward('30:00')` (or `30 * 60_000` ms).
  - [x] Assert `await expect(page).toHaveURL(/\/login$/)` and `await expect(page.getByText(/session expirée/i)).toBeVisible()`.
  - [x] Use path-based assertions — do NOT match on exact toast duration (Sonner auto-dismisses at 4 s; the assertion races with dismissal).

- [x] **Task 9: Operator documentation — Supabase Auth config.** (AC: 11)
  - [x] Add `### Session policy (NFR-S4)` section to root `README.md` with the runbook from AC #11.
  - [x] Verify the exact Supabase dashboard field names at implementation time; update the runbook if they differ.
  - [x] Cross-link from `README.md` to `_bmad-output/planning-artifacts/prd.md#NFR-S4` for traceability.

- [x] **Task 10: Regression sweep.** (All ACs)
  - [x] Run full test suite: `npm run test -- --run` (Vitest), `npm run test:edge` (Deno), `npx playwright test` (Playwright — expect the new spec skipped locally without SUPABASE_TEST_* env).
  - [x] Run `npm run lint` and `npx prettier --check .` — 0 warnings gate.
  - [x] Run `npx tsc --noEmit` — clean type-check.
  - [x] Manual smoke: start dev server, sign in, leave the tab focused-but-idle for 30 min (or patch `SESSION_IDLE_TIMEOUT_MS` to 30 s locally for the smoke), verify toast + redirect; then sign in again, stamp `localStorage.sc_session_started_at` to 31 days ago, reload, verify immediate sign-out.

## Dev Notes

### Architecture references (HARD constraints)

- **NFR-S4 policy** — 30-min idle / 30-day absolute / silent refresh while active. [Source: `prd.md` line 573]
- **FR6** — session expires after idle duration and requires re-auth to resume. [Source: `prd.md` line 477]
- **Toast wording** — exact French copy *"Session expirée, reconnectez-vous"* MUST be reused from the existing i18n key `login.session_expired_toast` (Story 1.5 added it at `src/i18n/fr.json` line 49). Architecture is explicit: idle → `SIGNED_OUT` → toast (not dialog). [Source: `architecture.md` line 655]
- **Single Supabase client, auto-refresh on** — `src/infrastructure/supabase/client.ts` lines 37–44 already sets `persistSession: true, autoRefreshToken: true`. Story 1.6 builds on top; does NOT reconfigure. [Source: `architecture.md` line 654]
- **Re-auth is SEPARATE from main session** — `/re-auth` Edge Function (Story 1.3) does NOT extend the main session TTL; idle timeout keeps running during a re-auth challenge. [Source: `architecture.md` line 351]
- **State management** — React Context + TanStack Query ONLY. No Redux/Zustand/Jotai. The idle-timer state is INSIDE the `useIdleTimeout` hook's refs — not global state. [Source: `architecture.md` line 280, 378]
- **Testing** — Vitest + React Testing Library for unit, Playwright for E2E, co-located unit tests (`useIdleTimeout.ts` ↔ `useIdleTimeout.test.tsx`). Fake timers via `vi.useFakeTimers()`. [Source: `architecture.md` lines 241–244, 524–526]
- **Coverage gate** — ≥ 80 % on `src/features/*`; 100 % is `src/domain/*` only. [Source: `architecture.md` line 684]

### Handoff from Story 1.5 (DO NOT duplicate, DO NOT rewrite)

| Component | Where | Contract (for 1.6) |
|---|---|---|
| `AuthStateListener` | `src/app/providers.tsx` lines 44–97 | Already catches `SIGNED_OUT`, toasts, navigates. 1.6 adds the `useIdleTimeout` hook inside its body. **DO NOT modify the existing effect.** |
| `hadSessionRef` cold-load guard | `src/app/providers.tsx` lines 48–55 | Prevents spurious toast on initial page load. 1.6 MUST NOT touch this — idle-triggered `signOut()` produces a legitimate `SIGNED_OUT` (session was present → absent), which the guard handles correctly. |
| `ProtectedRoute` | `src/app/guards.tsx` | Reactive guard, already subscribes to `onAuthStateChange`. 1.6 does NOT add a third subscription. |
| Supabase client singleton | `src/infrastructure/supabase/client.ts` | `autoRefreshToken: true` already on. Do NOT call `refreshSession()` manually. |
| `login.session_expired_toast` i18n key | `src/i18n/fr.json` line 49 | Reuse. Do NOT add a new key. |
| `useLogin` hook | `src/features/auth/api/useLogin.ts` | Independent of session mgmt — do not extend. |

### Architectural decisions this story commits

1. **Wall-clock-based idle detection, not interval-ticking.** The hook uses `lastActivityAt = Date.now()` + a single recalibrated `setTimeout` — not a `setInterval` that ticks every N seconds. This is robust to tab backgrounding (mobile Safari suspends timers), battery-efficient, and collapses N debounced events into one `setTimeout` call. Spec calls this out because the naive implementation (ticking interval) is the tempting but wrong choice.

2. **Idle timer does NOT pause offline.** AC #8 documents the rationale. This is a deliberate deviation from "smart" behavior that would pause offline — we choose simplicity + attack-surface minimization over ergonomics. Revisit if usage data shows collectors getting signed out mid-offline-transaction; for MVP we ship the stricter policy.

3. **Absolute-lifetime guard is dual-enforced.** Client-side `localStorage.sc_session_started_at` is defense-in-depth; Supabase Auth config is authoritative. The earliest expiry wins. Rationale: a dashboard misconfiguration (90-day refresh token) would silently violate NFR-S4; the client guard fails closed at 30 days regardless.

4. **No audit-log emission.** Story 1.7 (explicit sign-out) owns the `session.signed_out` audit event per the epic. Story 1.6 does NOT add session-expiry audit rows — avoids schema churn and keeps the boundary crisp.

5. **TOKEN_REFRESHED is a no-op for the idle timer.** Token refresh is driven by Supabase's internal scheduler (approaching JWT expiry), not by user activity. Resetting the idle timer on TOKEN_REFRESHED would erroneously extend the session for a dormant user whose token just auto-refreshed.

6. **Hook is mounted exactly once, globally, inside `AuthStateListener`.** Mounting in multiple components would create multiple timers and multiple activity-listener registrations; the spec is firm on the single-mount location.

### Anti-patterns to reject (do NOT do these)

- Do NOT use Redux / Zustand / Jotai for session state. (Architecture line 280.)
- Do NOT use `window.location.href = '/login'`; use React Router's `navigate`. The existing listener already handles this — 1.6 doesn't navigate directly.
- Do NOT persist `lastActivityAt` to localStorage. Per-tab ephemeral only.
- Do NOT manually call `supabase.auth.refreshSession()` — `autoRefreshToken: true` already does it.
- Do NOT re-subscribe to `onAuthStateChange` outside the `useIdleTimeout` hook and the existing `AuthStateListener` / `ProtectedRoute`. Three subscriptions is the max (matches Story 1.5's decision); the hook's subscription is the fourth ONLY IF the existing listener doesn't already pipe the event to the hook. The simpler design: `useIdleTimeout` owns its own subscription (one more), which is fine — Supabase allows N subscribers.
- Do NOT show a dialog for session expiry. The UX spec (`ux-design-specification.md` line 1331) lists session expiry among dialog-eligible events, but architecture.md line 655 + epic AC explicitly commit to a toast. Architecture wins because the wording is verbatim and matches the deployed i18n key. Flag this to UX if the design evolves post-MVP.
- Do NOT emit audit-log rows for session expiry in this story.
- Do NOT store the founder phone or any "call support" CTA in the session-expiry toast — this is the silent-refresh unhappy path, not a customer-support flow. A re-login click is the single action.

### Ambiguities resolved explicitly by this story

- **"Activity" surface** — `mousedown`, `keydown`, `touchstart`, `scroll` at `window`. NOT `mousemove` (too chatty; would defeat the spirit of "inactivity" if a user's touchpad jitters). NOT `focus`/`blur` (tab switching is not user intent).
- **Debounce choice** — 1 s trailing-edge for the `setTimeout` recalibration. `lastActivityAt` stamp updates on every event (cheap) so the computed expiry is exact.
- **Cross-tab behavior** — NOT handled in MVP. If a user has two tabs open and is active in one, the idle timer in the other still fires at 30 min. The second tab's `SIGNED_OUT` propagates via Supabase's `BroadcastChannel` (built into supabase-js 2.x when `persistSession: true`), which tears down the first tab too. If this is user-hostile in practice, revisit; for MVP the semantics are "idle per-tab, sign-out is device-wide."
- **Toast duration on session-expired** — Sonner's default (`~4 s`). No custom duration. User lands on `/login` either way.
- **Bounce-back after re-login** — NOT in MVP. Redirect post-login is still "empty-state vs dashboard" per Story 1.5 AC #9. A returning collector who was mid-way through creating a member loses their form state. The PRD does not require a return-URL feature; add in a future story if Ibrahim complains.

### Project Structure Notes

**Alignment with project tree** (`architecture.md#Project Structure` lines 863–1057):
- New hook → `src/features/auth/api/useIdleTimeout.ts` (feature-layer; imports from infrastructure is fine).
- Test → co-located `useIdleTimeout.test.tsx`.
- Constants → extend `src/lib/constants.ts` (no new file).
- Integration → `src/app/providers.tsx` body only (no new component).
- E2E test → `tests/e2e/session-idle-timeout.spec.ts` (sibling of `flow-5-login.spec.ts`).
- Operator docs → root `README.md` (or `docs/session-management.md` if the section grows past a screen).

**No conflicts with unified structure.** No new top-level folders. No layering violations (hook is features-layer and imports only from `lib`, `infrastructure`, `i18n`).

### References

- Epic + AC wording: [Source: `_bmad-output/planning-artifacts/epics.md` lines 527–544 (Story 1.6 definition)]
- FR6 / NFR-S4: [Source: `_bmad-output/planning-artifacts/prd.md` lines 477, 573]
- Toast wording + SIGNED_OUT handling: [Source: `_bmad-output/planning-artifacts/architecture.md` lines 654–656, 111, 351]
- State-management commitment (no Redux/Zustand/Jotai): [Source: `architecture.md` lines 280, 378]
- Coverage gate: [Source: `architecture.md` line 684]
- Project tree + layering: [Source: `architecture.md` lines 863–1057]
- Existing session plumbing (Story 1.5): [Source: `src/app/providers.tsx` lines 44–97, `src/app/guards.tsx` lines 25–75, `src/infrastructure/supabase/client.ts` lines 37–44, `src/i18n/fr.json` line 49]
- Constants file: [Source: `src/lib/constants.ts`]
- Story 1.5 handoff notes: [Source: `_bmad-output/implementation-artifacts/1-5-phone-otp-signin.md` AC #10, Dev Notes "Story 1.6 owns X" markers]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context)

### Debug Log References

- Initial test run hit a vitest / vite version mismatch caused by a leftover `node_modules/.deno/` tree from the previous Story 1.5 CI fix (`--node-modules-dir=auto` for Deno edge tests); recovered with `npm ci`.
- Activity-reset tests initially failed because the first cut of `handleActivity` deferred `clearTimeout` to the end of the 1 s debounce window — the old idle timer could fire before the debounced re-arm. Fix: `clearIdleTimer()` runs synchronously on every event; only the `setTimeout` re-arm is debounced. Unit test U2–U5 pin this semantic.

### Completion Notes List

- Feature implemented per AC #1–#11. 22 unit tests + 7 integration tests added (29 new, all green). Full Vitest suite: 152 passed, 1 skipped, 0 regressions.
- Lint clean (ESLint max-warnings=0), TypeScript strict clean (`tsc --noEmit`), Prettier clean.
- Playwright E2E spec env-gated (skips without `SUPABASE_TEST_URL` / `SUPABASE_TEST_ANON_KEY`) — CI wiring deferred to Story 1.8 per the same pattern as Stories 1.3/1.4/1.5.
- Hook avoids re-importing `@/features/auth/types` because the ESLint `import/no-internal-modules` rule forbids depth-2 imports into a feature from outside its `index`; the colocated hook uses a relative `../types` import.
- `useIdleTimeout` does NOT call `supabase.auth.signOut` directly — the caller passes `onExpired` — so tests and alternative callers (e.g., a future re-login confirmation flow) can swap the expiry action without forking the hook.
- TOKEN_REFRESHED emits both a DEV `console.debug` (stripped in prod by Vite's `import.meta.env.DEV` replacement) and a production-safe `console.info({ event: "session.token_refreshed" })` that downstream observability can consume.
- Absolute-lifetime guard only fires when a session is present AND the localStorage stamp has exceeded `SESSION_ABSOLUTE_LIFETIME_MS`; a stale key without a session is a no-op (test U11 pins this).
- SIGNED_IN only STAMPS `sc_session_started_at` if the key is absent — supabase-js can emit SIGNED_IN on persisted-session rehydration; overwriting would silently extend the 30-day window. Test U13 (SIGNED_OUT removes) + U12 (SIGNED_IN persists) + a complementary "does not overwrite" test pin the behavior.

### File List

**Created**
- `src/features/auth/api/useIdleTimeout.ts` — the core hook (198 lines)
- `src/features/auth/api/useIdleTimeout.test.tsx` — 22 unit tests (co-located)
- `src/app/providers.test.tsx` — 7 integration tests covering Story 1.5 regression + Story 1.6 idle + absolute-lifetime paths
- `tests/e2e/session-idle-timeout.spec.ts` — Playwright E2E using `page.clock.install()` / `fastForward`, env-gated

**Modified**
- `src/lib/constants.ts` — appended 4 `SESSION_*` constants (+storage key)
- `src/features/auth/types.ts` — appended `IdleTimeoutConfig` type
- `src/app/providers.tsx` — mounted `useIdleTimeout` inside `AuthStateListener` (no changes to the existing effect / `hadSessionRef` / `locationRef`)
- `README.md` — appended `## Session policy (NFR-S4)` + operator runbook for Supabase Auth configuration
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `1-6-session-management`: `backlog` → `ready-for-dev` → `in-progress` → `review`; `last_updated` → `2026-04-21`

## Change Log

- 2026-04-21 (Opus 4.7 1M — create-story): Spec created from epics.md Story 1.6, architecture.md § Session / Auth, PRD NFR-S4 / FR6, UX spec § Modal Patterns, and Story 1.5 handoffs. Status → ready-for-dev.
- 2026-04-21 (Opus 4.7 1M — dev-story): Implemented end-to-end. All 10 ACs + 10 tasks satisfied. 29 new tests (22 unit + 7 integration) all green; 152 / 153 Vitest tests pass (1 skipped). Lint / type-check / Prettier all clean. Status → review.
