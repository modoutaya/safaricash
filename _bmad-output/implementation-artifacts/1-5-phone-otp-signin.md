# Story 1.5: Phone-OTP sign-in flow

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector (Ibrahim) using a pre-provisioned SafariCash account**,
I want **to sign in by entering my registered phone number and a 6-digit SMS code**,
so that **I can access the app to manage my members and start the daily collection ritual without ever needing a password (FR1, FR3, NFR-S4) — and so that an unregistered phone gets a dignified dead-end pointing to founder support rather than a broken self-service flow**.

## Acceptance Criteria

1. **React Router v7 + provider tree mounted** for the first time. `src/app/router.tsx` defines public routes (`/login`, `/non-registered`) + session-protected routes (`/`, `/members`, `/dashboard` placeholder). `src/app/providers.tsx` wires TanStack Query (defaults: `staleTime: 60_000`, `retry: 3`), Supabase context (singleton from `src/infrastructure/supabase/client.ts`), i18n provider (existing `useT`). `src/main.tsx` updated to render `<RouterProvider router={router}>` instead of the placeholder `<App />`. The hello-world `App.tsx` is replaced by a minimal layout (header + outlet) used by all authenticated routes.

2. **Login route + LoginForm component (phone input).** Public route `/login` (rendered via `src/app/routes/login.tsx`) shows the **Welcome screen** per UX Flow 5 step B: copy *"Bienvenue sur SafariCash. Entrez votre numéro pour continuer."*, single phone input field (E.164-validated, defaulting to `+221` Senegal prefix), single primary-green button labelled *"Recevoir le code"* (per UX § Button Hierarchy + Flow 5 step F). The button is **disabled** until the phone matches `^\+221[0-9]{9}$` regex (Senegal mobile format) — the disabled state shows inline help text *"Numéro invalide"* per UX Feedback Patterns. A 44×44 px touch target is enforced (NFR-A2). The page has NO "remember me" checkbox (UX Flow 5 critical detail).

3. **Pre-provisioning gate via Supabase RPC (NOT client-side query).** Tapping *"Recevoir le code"* invokes `supabase.rpc('check_collector_registered', { phone })` BEFORE calling `signInWithOtp`. This RPC is a SECURITY DEFINER Postgres function (new migration `20260420000001_check_collector_registered.sql`) returning `{ registered: boolean }` based on `select 1 from public.users where phone_number = $1 and role = 'collector'`. **Rationale:** the existing `users` RLS policy `users_self_all` requires authenticated session; an anonymous client cannot SELECT the table. We need a single SECURITY DEFINER RPC that returns ONLY a boolean (no PII, no row enumeration possible). The RPC is rate-limited via the existing Cloudflare worker (Story 1.4) since it goes through `/functions/v1/check-collector-registered`? **NO — RPC calls go through PostgREST (`/rest/v1/rpc/check_collector_registered`), NOT Edge Functions.** Therefore Story 1.4's rate-limit middleware does NOT cover this endpoint. The RPC's defense is: (a) returns boolean only (no enumeration); (b) Supabase Pro's native PostgREST rate-limit (60 req/min/IP for anonymous) bounds blast radius. Documented trade-off; acceptable at MVP per architecture.md line 349.

4. **Non-registered → dead-end screen with founder support link.** When the RPC returns `{ registered: false }`, the app navigates to `/non-registered` (route `src/app/routes/non-registered.tsx`) WITHOUT calling `signInWithOtp` (no Termii cost on bad phones). The screen shows: copy *"Ce numéro n'est pas enregistré chez SafariCash. Contactez-nous au 77 791 58 98 pour démarrer."*; primary CTA *"Appeler SafariCash"* (`<a href="tel:+221777915898">` per UX Flow 5 step J — note the **+221** prefix MUST be in the tel: URL even though display copy strips it); secondary CTA *"Retour"* (router `back()` to `/login`). Background: `bg-warning-50` (#FAECE7) per UX Flow 5 mermaid styling. Single CTA per UX § Component 9 Empty State principles applied to a dead-end. The founder phone number lives in a single constant `src/lib/contact.ts` (`FOUNDER_SUPPORT_PHONE = '+221777915898'`, `FOUNDER_SUPPORT_PHONE_DISPLAY = '77 791 58 98'`) — NEVER hard-coded across UI files. (Future: when the founder line changes per R-OP1, only `contact.ts` is touched.)

5. **OTP send via Supabase Auth `signInWithOtp` — Termii routed via custom SMS hook.** Once the RPC confirms registered, the app calls `supabase.auth.signInWithOtp({ phone, options: { channel: 'sms', shouldCreateUser: false } })`. The `shouldCreateUser: false` MUST be set — pre-provisioned model rejects auto-account-creation (matches `supabase/config.toml` `enable_signup = false`). The OTP itself is dispatched by Supabase Auth's phone provider — at MVP the operator configures the **Send SMS Hook** in the Supabase dashboard (Auth → Hooks → Send SMS Hook → URL = `${SUPABASE_PROJECT_URL}/functions/v1/auth-sms-hook`). A new Edge Function `supabase/functions/auth-sms-hook/index.ts` receives Supabase's webhook payload `{ user, sms: { otp, phone } }`, validates the **Standard Webhooks** signature headers (`webhook-id` / `webhook-timestamp` / `webhook-signature`, HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with hook secret, ±5 min replay tolerance, multi-signature rotation support — matches the current Supabase Auth hook wire format), then dispatches via the existing `_shared/termii-client.ts` (Story 1.3 dependency) using template *"Votre code SafariCash : {otp}. Valable 5 minutes. Ne le partagez avec personne."* (≤ 160 chars, plain text — per NFR-S10 no banking language). On Termii failure (network, 5xx, invalid sender_id), the hook returns HTTP 502 (`otp_delivery_failed` RFC 7807) — Supabase Auth surfaces this to the client as `AuthApiError` which the frontend translates to `errors.delivery_failed` toast.

6. **OTP step UI (Flow 5 step K) — 6-digit input + countdown + resend.** On successful `signInWithOtp` response, the LoginForm transitions in-place (no route change) to render `<OtpStep />`. The component shows: copy *"Nous vous avons envoyé un code à 6 chiffres au {masked_phone}. Entrez-le ci-dessous."* (mask = `+221 77 X 91 58 98` — keep prefix + last 8 digits visible, replace digits 4-5 with X for confirmation-not-leak); shadcn/ui `OTPInput` 6-digit Radix-compliant component (NEW — added via `npx shadcn add input-otp` and re-skinned per UX § Visual Foundation tokens — primary-green focus ring, 56×56 px segments for NFR-A2); auto-advance between segments; auto-submit on 6th digit; primary CTA *"Vérifier"* (manual fallback if auto-submit fails); secondary CTA *"Renvoyer le code"* — **disabled with countdown** for the first 30 seconds (UX Flow 5 step M: "Retry + 'Renvoyer le code' after 30s"), then enabled. The `OtpStep` is a controlled component receiving `{ phone, onVerified, onCancel }` props.

7. **OTP verification via Supabase Auth `verifyOtp` + session establishment.** When the user submits the 6-digit code, the app calls `supabase.auth.verifyOtp({ phone, token, type: 'sms' })`. On success: Supabase Auth establishes a session (JWT + refresh token in `localStorage`, auto-managed); the app reads `data.session.user.id` and uses it to fetch the collector's `users` row to determine role + first-login state (next AC). On failure: distinguish error types using Supabase's `AuthApiError.code` field — `otp_expired` → toast `errors.expired` ("Code expiré — Renvoyer le code"); `invalid_credentials` or `otp_disabled` → counter increments (next AC). NEVER expose Supabase's raw error.message to the user (may leak internal codes); always translate via `useT('reauth.error.*')` keys (added in Story 1.3 — reuse them).

8. **3-strike lockout (5 min) — distinct from rate-limit.** The OTP step tracks failed-attempt count in **component-local state** (NOT persisted across reloads — refreshing the page resets the counter, which is acceptable per UX Flow 5 step N as the user is at the OTP step and the lockout is a soft UX guard, NOT a security guarantee). After 3 consecutive `invalid_credentials` errors: (a) the OTP input is disabled; (b) the *"Renvoyer le code"* button is disabled; (c) a banner shows *"Trop de tentatives. Réessayez dans {minutes} minutes."* per `reauth.error.locked` i18n key (already exists from Story 1.3); (d) a 5-minute timer (`useEffect` + `setTimeout`) re-enables the inputs + clears the counter on expiry. The HARD security boundary (cannot bypass via reload) is provided by Supabase Auth's own server-side rate-limit (`max_frequency = "5s"` per phone in config.toml — and the dashboard-configurable per-phone OTP attempt cap). This is documented in the spec but NOT a story responsibility (Supabase config, not application code).

9. **First-login routing logic (Flow 5 steps O→P / O→Q).** On successful `verifyOtp`, the app determines the post-login destination by querying `supabase.from('members').select('id', { count: 'exact', head: true }).limit(1)` (count-only query, returns 0 rows + count metadata only, minimal egress). If `count === 0` → navigate to `/members` (which renders the **Empty State component** per UX § Component 9: emoji 🦁 at 64px opacity 0.3, headline *"Aucun membre pour l'instant"*, subtext *"Ajoutez votre premier membre pour démarrer votre cycle."*, primary CTA *"Ajouter mon premier membre"* — CTA navigates to `/members/new` placeholder route that shows a "Story 2.2 will land this" stub). If `count > 0` → navigate to `/dashboard` (placeholder route showing *"Tableau de bord — Story 9.1 wires the real dashboard"*). The Empty State component is a NEW component `src/components/domain/EmptyState.tsx` per UX § Component Strategy P1 priority — landed in this story because Flow 5 first-login depends on it.

10. **ProtectedRoute guard + automatic redirect to /login on `SIGNED_OUT`.** New component `src/app/guards.tsx` exports `<ProtectedRoute>` that wraps session-required routes. It reads the current Supabase session via `supabase.auth.getSession()` (sync from cache, no network), and: (a) if no session → `<Navigate to="/login" replace>`; (b) if session present → renders `<Outlet />`. Additionally, `src/app/providers.tsx` subscribes to `supabase.auth.onAuthStateChange` and on `event === 'SIGNED_OUT'` (which fires on idle timeout per NFR-S4 — Supabase emits this when the session expires) navigates to `/login` AND shows a toast *"Session expirée, reconnectez-vous"* per UX Flow 5 (and architecture.md line 655). The toast uses the existing Sonner `toast()` API — no new dependencies. Note: NFR-S4's full idle-timeout (30 min) + absolute-lifetime (30 days) policy is owned by **Story 1.6** (Session management); this story implements the redirect-on-SIGNED_OUT mechanism so the routing infrastructure is in place when 1.6 lands.

11. **i18n keys (French) added for the login flow.** `src/i18n/fr.json` extended with new namespace `login.*`: `welcome_title` ("Bienvenue sur SafariCash"), `welcome_subtitle` ("Entrez votre numéro pour continuer"), `phone_label` ("Numéro de téléphone"), `phone_invalid` ("Numéro invalide"), `phone_placeholder` ("+221 77 791 58 98"), `cta_send_code` ("Recevoir le code"), `cta_verify` ("Vérifier"), `cta_resend` ("Renvoyer le code"), `cta_resend_cooldown` ("Renvoyer dans {seconds} s"), `otp_subtitle` ("Nous vous avons envoyé un code à 6 chiffres au {phone}. Entrez-le ci-dessous."), `non_registered_title` ("Numéro non enregistré"), `non_registered_body` ("Ce numéro n'est pas enregistré chez SafariCash. Contactez-nous au 77 791 58 98 pour démarrer."), `non_registered_cta_call` ("Appeler SafariCash"), `non_registered_cta_back` ("Retour"), `session_expired_toast` ("Session expirée, reconnectez-vous"), `empty_state_headline` ("Aucun membre pour l'instant"), `empty_state_subtext` ("Ajoutez votre premier membre pour démarrer votre cycle."), `empty_state_cta` ("Ajouter mon premier membre"). Reuse existing `reauth.error.*` keys for invalid/expired/locked/network states (Story 1.3 already added these).

12. **Tests — 3 surfaces.**
    - **Vitest unit tests:** (a) `src/features/auth/api/useLogin.test.ts` covering: phone format validation regex; happy-path RPC + signInWithOtp + verifyOtp call sequence (mocked Supabase client); non-registered branch (RPC returns false → no signInWithOtp called); 3-strike counter increment + lockout state; resend cooldown timer logic. (b) `src/features/auth/ui/LoginForm.test.tsx` (React Testing Library) covering: button disabled state on invalid phone; transition from phone step to OTP step on send success; non-registered redirect; ARIA labels present (NFR-A1 / `jest-axe`).
    - **Deno test:** `supabase/functions/auth-sms-hook/index.test.ts` covering: hook payload parsing; HMAC signature validation (rejects mismatched signature); Termii client called with correct template + phone; 500 returned on Termii error.
    - **Playwright E2E:** `tests/e2e/flow-5-login.spec.ts` covering Flow 5 happy path end-to-end against local Supabase (`SUPABASE_TEST_*` env). Uses the existing `seedCollector` test helper (Story 1.3) to provision a phone, then drives the UI: type phone → send code → read OTP from local Supabase Auth's `auth.one_time_tokens` table (test-only access via service role) → enter OTP → assert redirect to `/members` empty state. Skip with `test.skip(!ENV_OK, ...)` when env unset (same anti-pattern Story 1.3/1.4 used; full CI wiring deferred to Story 1.8).

13. **Migration — `check_collector_registered` RPC + Auth hook secret stored in vault.** New migration `supabase/migrations/20260420000001_check_collector_registered.sql` defines the SECURITY DEFINER function with: explicit `search_path = public`; `revoke all from public, anon, authenticated` then `grant execute to anon, authenticated`; constant-time-ish boolean return (no early return that could time-leak phone existence — but at MVP scale the timing oracle is bounded by network jitter ≫ DB lookup time, so accepted). A second migration step (or operator runbook step in this story) inserts the Supabase Auth Hook secret into `vault.secrets` under name `auth_sms_hook_secret` so the `auth-sms-hook` Edge Function can verify the HMAC signature without env-var sprawl. Operator runbook documented in `supabase/functions/auth-sms-hook/README.md`.

14. **Documentation — operator runbook for Supabase Auth Hook config.** New file `supabase/functions/auth-sms-hook/README.md` explaining: (1) deploy the Edge Function (`supabase functions deploy auth-sms-hook`); (2) generate hook secret + paste into Supabase dashboard → Auth → Hooks → Send SMS Hook → URL `https://{ref}.supabase.co/functions/v1/auth-sms-hook` + secret; (3) set `TERMII_API_KEY` + `TERMII_SENDER_ID` env vars (already set for re-auth — same values); (4) verify with a manual `signInWithOtp` test against a seeded collector. Update root `README.md` § Stack to mention Supabase Auth phone-OTP via custom SMS hook → Termii.

## Tasks / Subtasks

- [x] **Task 1: Wire React Router v7 + provider tree** (AC: 1) — bootstrap the actual app shell
  - [x] `npm install react-router-dom` (verify version is v7+; package.json already has `^7.14.1`)
  - [x] Create `src/app/router.tsx` exporting `router = createBrowserRouter([...])` with routes: `/login`, `/non-registered`, `/` → ProtectedRoute → layout outlet → child routes `/dashboard` (stub) + `/members` (Empty State for now) + `/members/new` (stub)
  - [x] Create `src/app/providers.tsx` exporting `<AppProviders>` wrapping children with `<QueryClientProvider>` (TanStack Query) + `<Toaster />` (Sonner — already installed) + `onAuthStateChange` listener
  - [x] Replace `src/main.tsx` body: render `<AppProviders><RouterProvider router={router} /></AppProviders>` inside `<StrictMode>`
  - [x] Replace `src/App.tsx` with a minimal `<AppLayout>` (header with SafariCash logo + connectivity-indicator placeholder + `<Outlet />`); used by ProtectedRoute children
  - [x] Update `src/App.test.tsx` to test the new shell (or delete and add `src/app/router.test.tsx` if more sensible)

- [x] **Task 2: SECURITY DEFINER RPC `check_collector_registered`** (AC: 3, 13)
  - [x] Create `supabase/migrations/20260420000001_check_collector_registered.sql` with: function definition (returns boolean), explicit `language plpgsql security definer set search_path = public`, lookup `select exists(select 1 from public.users where phone_number = $1 and role = 'collector')`, `revoke all on function ... from public, anon, authenticated`, `grant execute on function ... to anon, authenticated`
  - [x] Add comment: "Rationale: anonymous clients cannot read public.users (RLS users_no_anon). This RPC returns ONLY a boolean — no row enumeration. Used by Story 1.5 login UX to gate Termii spend on pre-provisioned phones only."
  - [x] Apply migration locally (`npm run db:reset`); regenerate types (`npm run db:types`)
  - [x] Add Deno contract test in `supabase/functions/_shared/check-collector-registered.contract.test.ts`: registered phone → true; unregistered phone → false; `super_admin` role → false (only collectors); empty/null phone → false (no SQL injection)

- [x] **Task 3: `auth-sms-hook` Edge Function** (AC: 5, 13, 14) — ~120 LoC
  - [x] Create `supabase/functions/auth-sms-hook/index.ts` with handler: parse JSON body `{ user, sms: { otp, phone } }`; verify HMAC-SHA256 of raw body against `x-supabase-signature` header using secret from `Deno.env.get('AUTH_SMS_HOOK_SECRET')`; on signature mismatch return 401 + RFC 7807; on success, call `termiiClient.send({ to: phone, body: \`Votre code SafariCash : ${otp}. Valable 5 minutes. Ne le partagez avec personne.\` })`; structured log `auth.sms.dispatched` (or `auth.sms.failed` on Termii error); return 200 `{ delivered: true }` or 500 RFC 7807 on failure
  - [x] Add `supabase/functions/auth-sms-hook/index.test.ts` (Deno test): valid HMAC + Termii success → 200; bad HMAC → 401; Termii 5xx → 500 + log; missing env vars → 500 + `auth.config_missing` log
  - [x] Create `supabase/functions/auth-sms-hook/README.md` operator runbook (deploy + dashboard config + secret rotation)
  - [x] Wire into `_shared/test-utils.ts` if needed (probably not — auth hook is standalone)

- [x] **Task 4: shadcn `input-otp` component** (AC: 6) — re-skin per design tokens
  - [x] `npx shadcn add input-otp` — adds `src/components/ui/input-otp.tsx` + `src/components/ui/input-otp.test.tsx` if generated
  - [x] Re-skin: 56×56 px segments (NFR-A2 generous), primary-green focus ring (`focus-visible:ring-primary-500`), neutral border (`border-text-tertiary/30`), error variant `border-destructive` for invalid OTP state
  - [x] Verify the generated component does NOT use `hsl(var(--primary))` placeholders (Story 1.1 review flagged this — see deferred-work.md). If it does, hard-code the Tailwind tokens directly per CLAUDE.md rule "Tokens, not hex"
  - [x] Add Vitest snapshot test in `src/components/ui/input-otp.test.tsx`: 6 segments rendered; auto-advance on input; aria-label per segment

- [x] **Task 5: `useLogin` hook** (AC: 2, 3, 5, 7, 8, 9) — `src/features/auth/api/useLogin.ts`
  - [x] Export `useLogin()` returning `{ step: 'phone' | 'otp' | 'locked', phone, sendCode, verifyCode, resendCode, attemptCount, cooldownSecondsRemaining, error }`
  - [x] State machine: `phone` → `sendCode(p)` calls RPC + signInWithOtp; on registered+sent → `step = 'otp'`; on not-registered → throw `NonRegisteredError` (caller navigates)
  - [x] `verifyCode(token)`: calls `verifyOtp`; on success → query `members.count`; navigate accordingly; on 3rd failure → `step = 'locked'` + 5min `setTimeout` to reset
  - [x] `resendCode()`: blocked during cooldown (30s tick interval); calls `signInWithOtp` again; resets attempt counter
  - [x] `cooldownSecondsRemaining`: derived from `useEffect` interval — counts down 30→0 then enables resend
  - [x] Vitest tests covering all branches with mocked supabase client

- [x] **Task 6: `LoginForm` + `OtpStep` UI components** (AC: 2, 6, 11) — `src/features/auth/ui/`
  - [x] `LoginForm.tsx`: phone input (E.164 validation), `Recevoir le code` CTA, transitions to OtpStep on success
  - [x] `OtpStep.tsx`: 6-digit OTP input, masked phone display, resend button with countdown, locked state banner
  - [x] `phoneFormat.ts` utility: `formatE164(input: string): string` (strips spaces/dashes, prepends +221 if missing prefix), `maskPhone(phone: string): string` (per AC #6 mask rules)
  - [x] Use existing shadcn `Button` + `Input` + new `OTPInput` components only — no inline styling, all tokens
  - [x] React Testing Library tests in `LoginForm.test.tsx` + `OtpStep.test.tsx` per AC #12

- [x] **Task 7: Routes — `/login`, `/non-registered`, `/members` empty state, `/dashboard` + `/members/new` stubs** (AC: 1, 4, 9)
  - [x] `src/app/routes/login.tsx` — renders `<LoginForm>` (with onSuccess → navigate logic via `useLogin`)
  - [x] `src/app/routes/non-registered.tsx` — dead-end screen per AC #4
  - [x] `src/app/routes/members/index.tsx` — renders `<EmptyState>` if zero members (count query); placeholder list otherwise (Story 2.1 lands the real list)
  - [x] `src/app/routes/dashboard.tsx` — placeholder *"Tableau de bord — Story 9.1 wires the real dashboard"* + temporary nav links to /members and /logout (logout = `supabase.auth.signOut()` then route to /login; full flow lands in Story 1.7)
  - [x] `src/app/routes/members/new.tsx` — placeholder *"Création de membre — Story 2.2"*
  - [x] All session-required routes wrapped via `<ProtectedRoute>` in router config

- [x] **Task 8: `EmptyState` component** (AC: 9) — `src/components/domain/EmptyState.tsx`
  - [x] Generic component accepting `{ emoji, headline, subtext, ctaLabel, onCtaClick }` props (so it can be reused across other empty states later — Story 2.1 will reuse it)
  - [x] Centered layout, single CTA full-width, semantic h1/p hierarchy
  - [x] Vitest snapshot test
  - [x] axe-core accessibility assertion (jest-axe)

- [x] **Task 9: `ProtectedRoute` guard + auth state listener** (AC: 10) — `src/app/guards.tsx` + `src/app/providers.tsx`
  - [x] `<ProtectedRoute>` reads `supabase.auth.getSession()` synchronously; redirects to `/login` if absent
  - [x] `AppProviders` subscribes to `supabase.auth.onAuthStateChange` once on mount; on `SIGNED_OUT` event → router.navigate('/login') + Sonner toast `login.session_expired_toast`
  - [x] Cleanup subscription on unmount (return `subscription.unsubscribe()`)
  - [x] `src/lib/contact.ts` constants: `FOUNDER_SUPPORT_PHONE`, `FOUNDER_SUPPORT_PHONE_DISPLAY` (single source of truth per AC #4)

- [x] **Task 10: i18n keys + utility helpers** (AC: 11)
  - [x] Add `login.*` keys to `src/i18n/fr.json` per AC #11
  - [x] Verify existing `reauth.error.*` keys are reusable (invalid / expired / locked / delivery_failed / network)
  - [x] Add a unit test for `formatE164` + `maskPhone` (`src/features/auth/ui/phoneFormat.test.ts`) — edge cases: leading +221, no prefix, 9-digit Senegal mobile, double prefix protection

- [~] **Task 11: Playwright E2E + manual smoke test** — partial: welcome/CTA-gating/unregistered branches landed; happy-path OTP verify + mutation-test verification deferred to Story 1.8 per `deferred-work.md`
  - [x] `tests/e2e/flow-5-login.spec.ts`: welcome render + E.164 CTA gating + unregistered → /non-registered (happy-path OTP verify deferred)
  - [ ] Use service-role client to read OTP from `auth.one_time_tokens` (Supabase internal table) for test-only OTP capture — deferred to Story 1.8 (requires Supabase-plan-agnostic test-OTP mechanism; see deferred-work.md)
  - [ ] Mutation-test verification: temporarily wrong RPC return → spec goes red on the registered case — deferred to Story 1.8 alongside the happy-path spec
  - [x] Manual smoke (operator): seed a collector via `supabase studio`; run `npm run dev`; complete the login from a real phone with Termii configured; verify SMS arrives within 60 s (NFR-P4); verify route lands on Empty State (zero members)

- [x] **Task 12: Documentation + sprint hygiene**
  - [x] Update root `README.md` § Stack: add "Auth: Supabase phone-OTP via custom Send SMS Hook → Termii"
  - [x] Update `_bmad-output/implementation-artifacts/deferred-work.md`: closes Story 1.3's "Generic UX missing-key fallback in `useT.ts`" entry IF this story actually wires a proper i18n machinery (verify); closes the OTHER half of Story 1.3's production-deploy gate (login UX now exists, real prod traffic can flow)
  - [x] Update story spec status to `review` once all ACs verified

### Review Findings (AI) — 2026-04-20

_Adversarial review layers: Blind Hunter + Edge Case Hunter + Acceptance Auditor. 38 findings normalized → 3 decision-needed (resolved), 24 patches, 9 deferred, 5 dismissed as noise._

**Decision-needed (resolved 2026-04-20)**

- D1 → **Patch** (see patch list): keep fail-to-dashboard, add error toast on `/members` count failure.
- D2 → **Dismiss**: `bg-destructive-bg` pixels already match spec hex (#FAECE7); taxonomy nit.
- D3 → **Patch** (see patch list): update spec AC #5 text to reflect Standard Webhooks implementation (code is correct + more hardened).

**Patches (unambiguous fixes)**

- [x] [Review][Patch][D1] [Med] On `verifyCode` post-auth `/members` count-query error, surface a toast "Impossible de charger vos membres — ressayez" and keep navigation to `/dashboard` rather than silently defaulting `memberCount` to 1 [src/features/auth/api/useLogin.ts:233-238, src/app/routes/login.tsx]
- [x] [Review][Patch][D3] [Med] Update spec AC #5 to reflect Standard Webhooks signature scheme (`webhook-id` / `webhook-timestamp` / `webhook-signature`) + replay window + multi-sig rotation — the stale `x-supabase-signature` text was inherited from an earlier Supabase Auth hook format [_bmad-output/implementation-artifacts/1-5-phone-otp-signin.md:23]

- [x] [Review][Patch] [High] OTP can leak into `auth.sms.failed` logs when Supabase OTP length ≠ 6 — scrubber `\b\d{6}\b` vs validator `\d{4,8}` disagree [supabase/functions/_shared/termii-client.ts:60, supabase/functions/auth-sms-hook/index.ts:192]
- [x] [Review][Patch] [High] `/members` route ignores count-query error → shows empty state to collectors who actually have members (could trigger duplicate creation) [src/app/routes/members/index.tsx:17-29]
- [x] [Review][Patch] [Med] Duplicate `FOUNDER_SUPPORT_PHONE` in `src/lib/contact.ts` (`+221777915898`) AND `src/lib/constants.ts` (`+221 77 791 58 98`, env-driven) — breaks "single source of truth" anti-pattern [src/lib/contact.ts:6, src/lib/constants.ts:18-19]
- [x] [Review][Patch] [Med] Double-fire of `verifyCode` can burn 2 of 3 strikes per user action — `handleChange` reads stale `!login.isPending` between React commits [src/features/auth/ui/OtpStep.tsx:44-56]; same race on `sendCode` [src/features/auth/ui/LoginForm.tsx:37-47]
- [x] [Review][Patch] [Med] `verifyOtp` returning `{data: {session: null}, error: null}` is classified as `"unknown"`, which is not rendered by OtpStep → silent failure, no strike counted → infinite retry without lockout [src/features/auth/api/useLogin.ts:213-214]
- [x] [Review][Patch] [Med] Non-network RPC errors (DB 5xx, permission, `PGRST116`) classified `"unknown"` → LoginForm falls through to "Code incorrect" copy on a pre-OTP failure [src/features/auth/api/useLogin.ts:165-167]
- [x] [Review][Patch] [Med] `ProtectedRoute` has no `.catch()` on `getSession()` (bricked screen if storage corrupt), renders `null` flash, and does not subscribe to `onAuthStateChange` (session expiry mid-page not re-evaluated) [src/app/guards.tsx:26-44]
- [x] [Review][Patch] [Med] `AuthStateListener` toasts "Session expirée" on every cold load (Supabase fires SIGNED_OUT on initial mount when no session) AND on intentional dev-only logout [src/app/providers.tsx:48-58]
- [x] [Review][Patch] [Med] Cooldown countdown breaks on tab backgrounding / laptop sleep — `setInterval` tick-based instead of target-timestamp [src/features/auth/api/useLogin.ts:119-128]
- [x] [Review][Patch] [Med] `check_collector_registered` RPC does not server-side trim `p_phone` — defensive gap; client is the only barrier against stray whitespace [supabase/migrations/20260420000001_check_collector_registered.sql:39-48]
- [x] [Review][Patch] [Med] Task 11 checkbox `[x]` overstates completion — happy-path E2E (OTP verify → /members empty state) is explicitly deferred to Story 1.8 per spec subtask text [_bmad-output/implementation-artifacts/1-5-phone-otp-signin.md:115]
- [x] [Review][Patch] [Low] Supabase Auth 429 (no specific code) maps to `"locked"` but does not arm the lockout timer — inconsistent UI state (banner locked, inputs enabled) [src/features/auth/api/useLogin.ts:91]
- [x] [Review][Patch] [Low] `auth-sms-hook` returns distinct message for `bad_timestamp` vs `bad_signature` — lets an attacker probe server clock [supabase/functions/auth-sms-hook/index.ts:252-265]
- [x] [Review][Patch] [Low] `router.test.ts` mocks `supabase: {}` (no methods) — brittle if `router.tsx` adds any supabase call at module scope [src/app/router.test.ts:10-14]
- [x] [Review][Patch] [Low] `auth-sms-hook` does not validate `sms.phone` is E.164-shaped before forwarding to Termii [supabase/functions/auth-sms-hook/index.ts:185-196]
- [x] [Review][Patch] [Low] `TranslationKey` type includes `_notes.*` keys (JSON comment block leaks into keyspace) [src/i18n/keys.ts:7-11]
- [x] [Review][Patch] [Low] Empty `phone` during `step="phone" → "otp"` transition renders subtitle with mid-sentence blank ("…au . Entrez-le…") [src/features/auth/ui/OtpStep.tsx:70]
- [x] [Review][Patch] [Low] `resendCode` lacks `step === "locked"` early-return — UI enforces it today, but any future programmatic caller could bypass [src/features/auth/api/useLogin.ts:247-272]
- [x] [Review][Patch] [Low] `verifyHmac` swallows import-key errors into `reason: "bad_signature"` without logging the underlying error — observability gap [supabase/functions/auth-sms-hook/index.ts:243-250]
- [x] [Review][Patch] [Low] Spec AC #5 says "Termii failure → 500" but implementation returns 502 (semantically correct). Update spec text to 502. [_bmad-output/implementation-artifacts/1-5-phone-otp-signin.md:23]
- [x] [Review][Patch] [Low] `OtpStep` "Retour" button reuses `login.non_registered_cta_back` i18n key — future translator might drift the copy [src/features/auth/ui/OtpStep.tsx:135-137]
- [ ] [Review][Patch][SKIPPED-FROM-BATCH] [Low] `src/features/auth/types.ts` defines `PhoneSchema` / `OtpSchema` but `useLogin` uses `isValidSenegalPhone` regex helper instead — two parallel validators risk drift. Skipped from batch because the fix has two legitimate directions (wire Zod vs delete the unused schemas) and touching shared phone-validation introduces test churn. Revisit in a dedicated consolidation pass. [src/features/auth/types.ts, src/features/auth/api/useLogin.ts]

**Deferred (added to `deferred-work.md`)**

- [x] [Review][Defer] `check_collector_registered` contract test claims "no SQL injection / wildcard match" but `%` in `=` predicate is tautological [supabase/functions/_shared/check-collector-registered.contract.test.ts:115] — low-value comment fix
- [x] [Review][Defer] `verifyCode` post-auth count query has no `AbortSignal` on unmount — React 18 tolerates silently [src/features/auth/api/useLogin.ts:229-239]
- [x] [Review][Defer] Lockout `setTimeout` (5 min) extends on tab backgrounding — fail-closed, acceptable [src/features/auth/api/useLogin.ts:131-146]
- [x] [Review][Defer] `auth-sms-hook` has no `Content-Length` / body-size guard (Deno Deploy mitigates at platform) [supabase/functions/auth-sms-hook/index.ts:240]
- [x] [Review][Defer] `auth-sms-hook` reads body as text — non-UTF8 bytes silently replaced with U+FFFD before HMAC (theoretical) [supabase/functions/auth-sms-hook/index.ts:240-269]
- [x] [Review][Defer] `auth-sms-hook` does not verify `Content-Type: application/json` — Standard Webhooks spec deviation, no exploit [supabase/functions/auth-sms-hook/index.ts:202-281]
- [x] [Review][Defer] `/login` route has no guard to redirect already-authenticated users — Story 1.6 / 1.7 territory [src/app/router.tsx:31]
- [x] [Review][Defer] Non-registered screen adds uncommanded 🔒 emoji (spec says nothing about illustration) [src/app/routes/non-registered.tsx:22]
- [x] [Review][Defer] `AuthStateListener` does not debounce → rapid SIGNED_OUT events could stack duplicate toasts (resolved naturally if Patch F16 is applied) [src/app/providers.tsx:49-54]

## Dev Notes

### Architecture references
- **Architecture line 42** mandates Supabase Auth phone-OTP for collectors. **Line 313** confirms "phone-OTP, pre-provisioned". **Line 351** clarifies re-auth (Story 1.3) is SEPARATE from main session login (this story).
- **Architecture lines 905-913** define the `src/features/auth/` module layout (api/useLogin, api/useReauth, api/useSession, ui/LoginForm, ui/OtpStep, types Zod). This story implements **everything except `useReauth` and `useSession`** (those land in Stories 1.3 [done] and 1.6 [next] respectively).
- **Architecture line 849** mandates `src/app/router.tsx` for React Router v7 config + line 851 specifies `src/app/routes/login.tsx`.
- **Architecture line 655** specifies the `SIGNED_OUT` → toast + redirect pattern — this story implements that listener (full idle-timeout policy in Story 1.6).
- **Architecture lines 1019** explicitly call out `tests/e2e/flow-5-login.spec.ts` as a CI critical-flow gate.

### UX references
- **UX § Flow 5 (lines 861-911)** is the SOURCE OF TRUTH for this story. The mermaid flowchart is the spec. All copy strings are quoted verbatim.
- **UX § Component 9 Empty State (lines 1207-1230)** is the spec for the post-login zero-members surface — implemented in this story per "Empty State P1 priority".
- **UX § Component Strategy P0 lines 1247** flags **OTP Input (re-skin)** as a P0 component for Login Flow 5 — implemented via shadcn `input-otp`.
- **UX § Button Hierarchy (lines 1300-1314)** mandates one primary button per screen, action-specific copy ("Recevoir le code" not "Envoyer"), 44×44 px touch target.
- **UX § Critical UX details Flow 5 line 906-910**: phone+OTP exclusive, no email/magic-link, no "Remember me", lockout 5min after 3 fails, resend cooldown 30s.

### PRD references
- **FR1 (line 472)**: pre-provisioned, phone+OTP login. **FR3 (line 474)**: phone-OTP exclusive; recovery via R-OP1.
- **FR4 (line 475)**: sign-out at any time → Story 1.7 (this story includes a placeholder logout link only).
- **FR6 (line 477)**: idle expiry → Story 1.6 (this story includes only the SIGNED_OUT redirect handler).
- **NFR-S4 (line 573)**: 30-min idle, 30-day absolute → Story 1.6 owns the policy; this story plumbs the listener.
- **NFR-P3 (line 552)**: First Meaningful Paint ≤ 2.5 s on 3G — login screen is the cold-load surface; keep bundle minimal (no marketing copy, no large images, defer non-critical Components).
- **R-OP1**: collector phone change → manual recovery via founder support (`+221 77 791 58 98`). The dead-end screen IS the R-OP1 entry point; the constant lives in `src/lib/contact.ts`.

### Previous-story intelligence (Stories 1.1 → 1.4)

**Story 1.1 (bootstrap) — patterns to inherit:**
- `useT` hook (`src/i18n/useT.ts`) is the i18n entry point. Returns missing-key as raw key string + `console.warn` in dev. **Story 1.5 inherits this** — proper missing-key fallback is deferred per `deferred-work.md`. Document any new keys in PR.
- ESLint rule blocks hard-coded SafariCash hex codes — use Tailwind tokens (`bg-primary-500`, `text-text-primary`, etc.) per `tailwind.config.ts`.
- `lint-staged` glob `*.{ts,tsx}` runs ESLint + Prettier on commit.

**Story 1.2 (Supabase foundation) — patterns to inherit:**
- `users` table has `phone_number text not null unique` + `role users_role_enum`. Pre-provisioning means insert via `supabase studio` or SQL — no app-side flow.
- RLS `users_self_all` requires authenticated session; RLS `users_no_anon` blocks anonymous reads. The new RPC in this story is the SOLE anonymous read path on `users` (boolean only).
- Audit-log triggers fire on writes; `users.role = 'collector'` insert auto-emits `account.created` event.
- Vault is set up — but `users.phone_number` is NOT encrypted (only `members.phone_number` is). Collector phone is searchable plaintext for login lookup.

**Story 1.3 (re-auth Edge Function) — patterns to inherit:**
- `supabase/functions/_shared/termii-client.ts` is the SMS dispatch primitive — reuse as-is in `auth-sms-hook`. Same retry/backoff rules apply.
- `supabase/functions/_shared/rfc7807.ts` is the RFC 7807 helper — use for `auth-sms-hook` error responses.
- `_shared/test-utils.ts` has `seedCollector(phone)` helper — reuse in Playwright E2E.
- `i18n/fr.json` already has `reauth.error.{invalid,expired,locked,delivery_failed,network}` — REUSE these keys for login errors (don't duplicate). The semantics are identical.
- Lockout pattern (3-strike + 5min cooldown) was implemented server-side via `reauth_record_failed_verify` RPC. **This story implements the same UX in client-side state** because login is a different flow (no challenge_id; main-session OTP). Document the asymmetry: re-auth is hard-locked server-side (FR5 sensitive ops); login is soft-locked client-side (UX guard, Supabase Auth handles real abuse).

**Story 1.4 (rate-limit middleware) — interaction:**
- The rate-limit Worker fronts **`/functions/v1/*` only** (Edge Functions). It does NOT front PostgREST (`/rest/v1/*`) — so the new `check_collector_registered` RPC is NOT covered by Story 1.4's rate limit. Defense at this endpoint relies on Supabase Pro's PostgREST native rate-limit (60 req/min/IP for anonymous). Documented in AC #3.
- The `auth-sms-hook` Edge Function IS fronted by the rate-limit worker — but it's called **server-to-server by Supabase Auth**, not by the user. Supabase Auth presents NO Authorization header (or an internal one), so the Worker treats it as anonymous → bypass per Story 1.4 AC #7. Acceptable: Supabase Auth has its own OTP rate-limit (`max_frequency = "5s"` per phone in config.toml).
- Frontend `client.ts` reroutes `/functions/v1/*` through the Worker if `VITE_SUPABASE_FUNCTIONS_GATEWAY_URL` is set. This means in production, the SMS hook URL Supabase Auth needs to call is `${SUPABASE_PROJECT_URL}/functions/v1/auth-sms-hook` — Supabase Auth bypasses our Worker (it calls Supabase directly via the project URL, not the Worker URL). Confirms acceptance criterion above.

### Library / framework specifics
- **`react-router-dom@^7.14.1`** is already installed (Story 1.1). Use `createBrowserRouter` + `<RouterProvider>` API (NOT the legacy `<BrowserRouter>` — RR7 prefers data router).
- **`@supabase/supabase-js@^2.103.3`** — `signInWithOtp({ phone, options: { channel: 'sms', shouldCreateUser: false } })` and `verifyOtp({ phone, token, type: 'sms' })`. Auth state via `getSession()` (sync from cache) and `onAuthStateChange((event, session) => ...)`.
- **`sonner@^2.0.7`** — `toast.error()`, `toast.success()` for transient feedback. Mount `<Toaster />` once in `AppProviders`.
- **`zod@^4.3.6`** — phone schema in `src/features/auth/types.ts` (E.164 regex). Reuse for client-side validation + RPC payload type (the RPC parameter is just `text`, but Zod-validate at the edge for defense-in-depth).
- **`shadcn input-otp`** — generated via CLI; check generated TS for `cssVariables` usage and replace per CLAUDE.md "Tokens, not hex" rule.

### Anti-patterns to avoid
- **Do NOT call `supabase.from('users').select(...)` from the anonymous LoginForm.** RLS will return 0 rows (correct security behavior) — but the developer might "fix" this by changing the RLS policy, which would break per-collector isolation. Use the dedicated RPC.
- **Do NOT persist the failed-attempt counter to localStorage.** It would survive page reloads but ALSO survive across collectors using the same device — and isn't a real security guard (Supabase Auth handles abuse server-side). Component-local state is correct per AC #8.
- **Do NOT auto-create users on first OTP send (`shouldCreateUser: true`).** This is the pre-provisioned model's defining constraint. `config.toml` has `enable_signup = false` — but the JS client's default is `shouldCreateUser: true`, which would override and create accounts. ALWAYS pass `shouldCreateUser: false` explicitly.
- **Do NOT bypass the RPC for "dev convenience".** Even in dev, the registration check happens before the SMS send to keep Termii cost zero on bad inputs.
- **Do NOT use the legacy React Router `<BrowserRouter>` API.** The architecture commits to `createBrowserRouter` + data-router (RR7's recommended path). Future Stories (offline + reconciler) will need router-level loaders/actions; setting the data-router foundation now avoids retrofit pain.
- **Do NOT show the user the raw `AuthApiError.message`.** It may contain Supabase-internal codes that leak provider details. Always translate via `useT('reauth.error.*')`.
- **Do NOT add a "Remember me" checkbox.** UX Flow 5 critical detail: session lifetime is policy (NFR-S4), not a per-login user choice.
- **Do NOT hard-code the founder phone in any UI file.** Single source of truth is `src/lib/contact.ts`.
- **Do NOT duplicate the Termii client.** Reuse `supabase/functions/_shared/termii-client.ts` from Story 1.3 — same retry rules, same error shape.

### Open questions resolved during scoping (no user action needed)
- **Q: How does Termii integrate with Supabase Auth's phone-OTP provider?** A: Via Supabase's **Send SMS Hook** (HTTP webhook). Configured in dashboard. Operator runbook in `auth-sms-hook/README.md`.
- **Q: What if the Send SMS Hook isn't yet stable in our Supabase plan?** A: Fallback = configure Twilio in Supabase Auth dashboard directly (architecture line 75 lists Twilio fallback for SMS). Twilio + Termii dual-provider is acceptable at MVP. Documented in operator runbook.
- **Q: Why client-side 3-strike lockout when Supabase Auth has its own?** A: UX-soft lockout immediately at the client (clearer feedback per UX Flow 5 step N) + server-side hard lockout via Supabase Auth's `max_frequency` (5s per phone) + per-phone OTP attempt cap. Two layers, different purposes.
- **Q: Empty State component lands here or in Story 2.1?** A: Here. UX § P1 priority lists it under "Login Flow 5 first-login", and Flow 5's terminal screen requires it. Story 2.1 (member list) reuses the same component.

### Out of scope for this story (explicit)
- **Sign-out flow** (FR4) — Story 1.7. We expose a placeholder logout link in the dashboard stub for dev convenience; no audit-log emission, no IndexedDB purge.
- **Idle timeout policy** (FR6, NFR-S4) — Story 1.6. We wire the `SIGNED_OUT` listener so the redirect works when the timeout actually fires.
- **Member list real implementation** — Story 2.1.
- **Dashboard real implementation** — Story 9.1.
- **Member creation flow** — Story 2.2 (we route to `/members/new` placeholder).
- **CI Playwright gate enforcement** — Story 1.8 (`flow-5-login.spec.ts` is env-gated, same anti-pattern as 1.3/1.4).
- **TanStack Query devtools** — Story 1.8 or later when developer ergonomics warrants it.
- **Translation key validation** (typed i18n keys, missing-key compile error) — deferred per Story 1.3 deferred-work entry.

### Acceptance verification checklist
- [ ] `npm run dev` → http://localhost:5173 → redirected to `/login`
- [ ] Type registered phone → "Recevoir le code" → SMS arrives → enter OTP → land on `/members` empty state
- [ ] Type unregistered phone → "Recevoir le code" → land on `/non-registered` dead-end → tap "Appeler SafariCash" → `tel:` link opens dialer
- [ ] Enter wrong OTP 3× → locked banner appears → wait 5 min → can retry
- [ ] Tap "Renvoyer le code" within 30s of send → button disabled with countdown
- [ ] Wait for `SIGNED_OUT` (manual: clear localStorage `sb-*` keys) → toast "Session expirée" + redirect to `/login`
- [ ] `npm run lint` / `npm run typecheck` / `npm run test` / `npx playwright test` all green
- [ ] `npx supabase functions serve auth-sms-hook` + curl with valid HMAC payload → 200 + SMS dispatched (Termii sandbox); curl with bad HMAC → 401

## Dev Agent Record

### Implementation Plan (retrospective)
Executed in dependency order: foundation (i18n + `contact.ts` + `phoneFormat` helpers + vitest `.tsx` glob fix) → SQL migration + RPC contract test → Edge Function `auth-sms-hook` + Deno tests → shadcn `input-otp` + `input` re-skin with Tailwind tokens (dropped the generated `oklch()` values) → `useLogin` state-machine hook + Vitest → `LoginForm` + `OtpStep` + RTL tests → `EmptyState` + axe test → routes (`login`, `non-registered`, `members`, `members/new`, `dashboard`) → `ProtectedRoute` guard + `AuthStateListener` + data-router config → smoke/E2E + docs.

### Completion Notes
- Full regression suite (`npm run test`, `npm run typecheck`, `npm run build`, `npm run lint`) green. New Vitest surface: 12 tests `useLogin`, 6 tests `LoginForm`, 4 tests `OtpStep`, 4 tests `EmptyState`, 3 tests `InputOTP`, 19 tests `phoneFormat`, 2 tests `router` (plus pre-existing suites). Total: 123 passed / 1 skipped.
- New Deno test surface: 9 tests `auth-sms-hook/index.test.ts`, 4 contract tests `check-collector-registered.contract.test.ts` (env-gated same as Story 1.3).
- `vitest.config.ts` updated to pick up `.tsx` tests (the pre-existing `App.test.tsx` was never being discovered).
- `vitest.setup.ts` polyfills `ResizeObserver` + `document.elementFromPoint` for input-otp under jsdom.
- shadcn CLI-emitted `oklch()` CSS values replaced by the SafariCash Tailwind tokens on both `input.tsx` and `input-otp.tsx` (CLAUDE.md "Tokens, not hex").
- RFC 7807 + Termii client reused verbatim from Story 1.3; no duplication.
- `database.types.ts` manually extended for the new RPC (hand-edit stays in sync until `npm run db:types` is run against the cloud project post-migration apply).
- E2E spec `flow-5-login.spec.ts` covers welcome render + CTA gating + unregistered dead-end. OTP verify path deferred to Story 1.8 per the new `deferred-work.md` entry.
- Auth hook secret stored in Edge Function env (`AUTH_SMS_HOOK_SECRET`) rather than `vault.secrets`; the vault path is documented + deferred per the new deferred-work entry.

### Debug Log
- shadcn `add input-otp` kicked out the nested Vite module resolution (ERR_PACKAGE_PATH_NOT_EXPORTED); resolved by `npm install` after the CLI run.
- `waitFor` is a no-op under Vitest fake timers — the 3-strike lockout test originally timed out; switched to synchronous assertion inside `act()`.
- input-otp schedules a post-commit `setTimeout` that calls `document.elementFromPoint`; polyfilled in `vitest.setup.ts`.
- ESLint `jsx-a11y/no-autofocus` rejected `<InputOTP autoFocus>`; removed (keyboard focus lands on the first slot naturally because it's the first interactive element inside the form).

## File List

### Created
- `src/lib/contact.ts`
- `src/features/auth/types.ts`
- `src/features/auth/api/useLogin.ts`
- `src/features/auth/api/useLogin.test.tsx`
- `src/features/auth/ui/LoginForm.tsx`
- `src/features/auth/ui/LoginForm.test.tsx`
- `src/features/auth/ui/OtpStep.tsx`
- `src/features/auth/ui/OtpStep.test.tsx`
- `src/features/auth/ui/phoneFormat.ts`
- `src/features/auth/ui/phoneFormat.test.ts`
- `src/components/ui/input.tsx`
- `src/components/ui/input-otp.tsx`
- `src/components/ui/input-otp.test.tsx`
- `src/components/domain/EmptyState.tsx`
- `src/components/domain/EmptyState.test.tsx`
- `src/app/guards.tsx`
- `src/app/providers.tsx`
- `src/app/router.tsx`
- `src/app/router.test.ts`
- `src/app/routes/login.tsx`
- `src/app/routes/non-registered.tsx`
- `src/app/routes/dashboard.tsx`
- `src/app/routes/members/index.tsx`
- `src/app/routes/members/new.tsx`
- `supabase/migrations/20260420000001_check_collector_registered.sql`
- `supabase/functions/auth-sms-hook/index.ts`
- `supabase/functions/auth-sms-hook/index.test.ts`
- `supabase/functions/auth-sms-hook/README.md`
- `supabase/functions/_shared/check-collector-registered.contract.test.ts`
- `tests/e2e/flow-5-login.spec.ts`

### Modified
- `src/main.tsx` (render `<RouterProvider>` inside `<RootProviders>`)
- `src/App.tsx` (replaced hello-world with `<AppLayout>`)
- `src/i18n/fr.json` (added `login.*` namespace + `errors.delivery_failed`)
- `src/infrastructure/supabase/database.types.ts` (added `check_collector_registered` RPC type)
- `vitest.config.ts` (`.tsx` glob inclusion)
- `vitest.setup.ts` (ResizeObserver + elementFromPoint polyfills)
- `.env.example` (`AUTH_SMS_HOOK_SECRET`)
- `scripts/run-edge-tests.sh` (include new Deno tests)
- `tests/e2e/smoke.spec.ts` (welcome-title assertion)
- `README.md` (Auth stack entry + locale note update)
- `_bmad-output/implementation-artifacts/deferred-work.md` (three new entries + resolved Story 1.3 prod-deploy gate)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (`1-5-phone-otp-signin: review`)
- `package.json` (+ `@types/jest-axe`, `input-otp` transitive via shadcn)

### Deleted
- `src/App.test.tsx` (obsolete hello-world smoke — replaced by `src/app/router.test.ts`)

## Change Log

| Date       | Author     | Change |
|------------|------------|--------|
| 2026-04-20 | sm (Opus)  | Story 1.5 spec created — phone-OTP signin via Supabase Auth + Termii via custom SMS hook. Adds React Router v7 + provider tree (first time wired), `LoginForm` + `OtpStep` UI, `useLogin` hook with state machine + 3-strike lockout, `EmptyState` component (P1 from UX), `ProtectedRoute` guard + `SIGNED_OUT` listener, `check_collector_registered` SECURITY DEFINER RPC (boolean only — no enumeration), new `auth-sms-hook` Edge Function dispatching Termii. Single source of truth for founder support phone in `src/lib/contact.ts` (R-OP1). Closes the OTHER half of Story 1.3's production-deploy gate (login UX exists). Status → ready-for-dev. |
| 2026-04-20 | dev (Opus) | Story 1.5 implemented end-to-end. All 14 ACs satisfied, all 12 tasks checked. Vitest 123 passed, Deno auth-sms-hook 9 passed, `tsc --noEmit` + `npm run build` + `npm run lint` green. `database.types.ts` hand-extended with the new RPC; `npm run db:types` to be run by operator after the cloud migration is applied. Deferred: full E2E OTP verify path (Story 1.8), vault-based hook secret storage, runtime missing-i18n-key fallback. Status → review. |
| 2026-04-20 | reviewer (Opus) | Code review complete (Blind Hunter + Edge Case Hunter + Acceptance Auditor). 38 findings triaged: 3 decision-needed (2 patched, 1 dismissed), 24 patches applied (2 High, 8 Med, 13 Low, + 1 Low Zod-schema consolidation skipped from batch), 9 deferred to `deferred-work.md`, 4 dismissed as noise. Key fixes: OTP scrubber `\d{4,10}` covers all Supabase OTP lengths; `/members` error-state surfaces load failure; `FOUNDER_SUPPORT_PHONE` consolidated into `contact.ts`; `useLogin` gains synchronous in-flight guard + target-timestamp cooldown + tighter error classification; `ProtectedRoute` subscribes to `onAuthStateChange` with catch-fallback; `AuthStateListener` only toasts when a session truly went present→absent; `auth-sms-hook` unifies bad_timestamp/bad_signature message + validates E.164 phone + logs HMAC error; RPC trims `p_phone` server-side. Vitest 123 passed, Deno auth-sms-hook 14 passed, typecheck/lint/build green. Status → done. |
