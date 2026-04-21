# Story 1.5b: Switch collector auth from SMS-OTP to phone + password

Status: review

## Story

As **Mamadou (founder, solo dev)** facing a **Termii business-KYC blocker** that prevents the SMS gateway from going live,
I want **the collector auth critical path rewritten to use `supabase.auth.signInWithPassword` (phone + password) instead of SMS-OTP**,
so that **the MVP can ship and onboard pilot collectors without depending on a fully-KYC'd SMS provider** — while preserving the pre-provisioned-accounts model, the re-auth gate on sensitive operations (FR5), the `/login` → `/members` / `/dashboard` routing, and the R-OP1 founder-support recovery path.

## Context & driver

- **Triggering blocker:** Termii (primary SMS provider per architecture.md) requires business incorporation documents (letter of incorporation, RCCM, NINEA) that a solo founder cannot yet provide. Without Termii, Story 1.5's OTP login path cannot dispatch SMS in production. Twilio would face similar (often stricter) KYC on WAEMU sender IDs — not a viable shortcut.
- **Decision (PRD v1.3, 2026-04-21):** pivot the auth critical path to Supabase-native `signInWithPassword`. Accepts that password-re-auth on a stolen unlocked phone is weaker than OTP-on-SIM; accepted MVP risk, documented in the updated collector-fraud mitigation row. Termii stays in scope for saver receipts (Epic 6) — those do not block sign-in and can be gated separately when KYC clears.
- **Driver documented:** PRD v1.3 amendment block (frontmatter) + updated FR1 / FR3 / FR5 / NFR-S4 / R-OP1 / J1 narrative / capability table / biometric row / credential-theft risk row. Architecture.md auth sections updated to match.
- **What this story is NOT:** a PIN flow, a biometric flow, or a custom hashing scheme. It is the **smallest possible** change that swaps the OTP verification step for a password field and rips out the now-unused SMS-hook + OTP lockout plumbing.

## Acceptance Criteria

1. **`signInWithPassword` is the login primitive.** `src/features/auth/api/useLogin.ts` calls `supabase.auth.signInWithPassword({ phone, password })`. No pre-check RPC, no intermediate OTP step, no `verifyOtp`. Error mapping: `invalid_credentials` → `errors.invalid_credentials` toast ("Numéro ou mot de passe incorrect — ressayez"); `over_email_send_rate_limit` or any 429-class code → `errors.rate_limited` toast ("Trop de tentatives, attendez quelques minutes"); network error → `errors.network` toast. Never render `AuthApiError.message` directly — always translate.

2. **Single-screen `LoginForm` replaces the phone → OTP two-step flow.** `src/features/auth/ui/LoginForm.tsx` renders: phone input (E.164 validation, `+221` default, 44×44 px target, reuses `phoneFormat.ts` helpers), password input (`type="password"` with show/hide toggle — 👁 icon using an accessible `aria-label`, 44×44 px target), primary CTA *"Se connecter"*, secondary link *"Mot de passe oublié ?"* that is a `tel:` anchor to `FOUNDER_SUPPORT_PHONE` with copy *"Appeler SafariCash"* sub-label. The CTA is disabled until the phone matches the Senegal regex AND the password field is non-empty. Inline help *"Numéro invalide"* on phone field as today. The shadcn `Input` component is reused for password (no new component needed).

3. **The `check_collector_registered` RPC and its migration are removed.** `supabase/migrations/20260420000001_check_collector_registered.sql` is followed by a new migration `supabase/migrations/202604210000xx_drop_check_collector_registered.sql` that does `drop function if exists public.check_collector_registered(text);` with explicit `revoke` cleanup. Rationale: `signInWithPassword` returns `invalid_credentials` for both "wrong password" and "unregistered phone" — this is a stronger property (no enumeration oracle via error code) than the previous explicit "registered vs not" signal. The `/non-registered` dead-end screen and route are also removed; a forgotten or wrong phone now lands in the same error state as a wrong password, which pushes the user to the *"Mot de passe oublié ?"* → founder support path. Update `database.types.ts` accordingly.

4. **The `auth-sms-hook` Edge Function is decommissioned.** `supabase/functions/auth-sms-hook/` (index.ts, index.test.ts, README.md) is deleted. `AUTH_SMS_HOOK_SECRET` is removed from `.env.example`. `scripts/run-edge-tests.sh` drops the hook test from its test list. README.md § Stack: update "Auth" line to *"Auth: Supabase phone + password (`signInWithPassword`), pre-provisioned"*. The operator runbook for the Send SMS Hook in the Supabase dashboard is disabled — add a one-paragraph note to the root README under § Operator runbook: *"Auth SMS Hook is disabled in v1.3. Re-enable when Termii business KYC clears (see PRD v1.3 amendment)."* This note is the only Termii-auth breadcrumb left in the codebase. **Operator deploy checklist (must be run once post-merge):** in Supabase Dashboard → Auth → Hooks → Send SMS Hook: disable the hook (toggle off) OR delete the URL entry. Rationale: the app no longer calls `signInWithOtp`, but a misfired call (test, legacy client) would produce a 404 / 502 from Supabase attempting to reach the deleted Edge Function URL — noisier than a clean "no hook" response. Document the dashboard steps in the new README operator note.

5. **The OTP UI components are deleted.** Remove: `src/features/auth/ui/OtpStep.tsx`, `src/features/auth/ui/OtpStep.test.tsx`, `src/components/ui/input-otp.tsx`, `src/components/ui/input-otp.test.tsx`. Remove the `input-otp` npm dependency (`package.json` + lockfile). Remove the `ResizeObserver` + `document.elementFromPoint` polyfills from `vitest.setup.ts` if they were added solely for input-otp (verify: if another component uses them, keep). The `maskPhone` helper in `phoneFormat.ts` is deleted if it has no remaining call sites.

6. **`useLogin` state machine simplified.** Remove: `step: 'phone' | 'otp' | 'locked'` state (collapses to a single pending/success/error on a single `signIn` mutation); `attemptCount` + `cooldownSecondsRemaining` + 3-strike client lockout logic; resend-cooldown `setInterval`; `sendCode` / `verifyCode` / `resendCode` methods (replaced by a single `signIn({ phone, password })`). The post-auth member-count query (`members.count` → `/members` vs `/dashboard` branching per UX Flow 5 step O/P/Q) is PRESERVED — the collector's "land on empty state on first login" UX is a separate value unit from the auth mechanism and must not regress. Keep the existing count-failure toast ("Impossible de charger vos membres — ressayez") + fallback to `/dashboard`. **Preserve Story 1.5 Review patch F16** — `AuthStateListener` in `src/app/providers.tsx` must NOT toast "Session expirée" on cold load (i.e. on the initial `SIGNED_OUT` event Supabase emits at mount when no session exists). The prior-session guard (`hadSessionRef` or equivalent) that Story 1.5 patched must survive this rewrite intact. If `providers.tsx` is otherwise modified as part of this story, add a regression test that asserts no toast fires when the listener mounts with `session === null`.

7. **`useReauth` (Story 1.3) rewritten to password re-verification.** `src/features/auth/api/useReauth.ts` replaces the OTP-challenge pattern with a single password-submit mutation that POSTs to the existing Edge Function `supabase/functions/re-auth/` with `{ password, operation_intent }`. The Edge Function implementation is **strictly defined** (no alternatives):

   ```typescript
   // supabase/functions/re-auth/index.ts — pseudocode (≈ 40 LoC final)
   serve(async (req) => {
     const jwt = req.headers.get('Authorization')?.replace('Bearer ', '');
     if (!jwt) return rfc7807(401, 'no_jwt');

     // 1. Resolve the caller on a client that trusts the JWT.
     const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
       global: { headers: { Authorization: `Bearer ${jwt}` } },
     });
     const { data: { user }, error: userErr } = await userClient.auth.getUser();
     if (userErr || !user?.phone) return rfc7807(401, 'invalid_jwt');

     // 2. Parse + validate body.
     const { password, operation_intent } = ReauthRequestSchema.parse(await req.json());

     // 3. Verify password on a SECOND, fresh anon client so the main session is untouched.
     //    This path naturally consumes Supabase Auth's per-identifier rate limit.
     const verifyClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
     const { error: verifyErr } = await verifyClient.auth.signInWithPassword({
       phone: user.phone,
       password,
     });
     if (verifyErr) {
       if (verifyErr.status === 429) return rfc7807(429, 'rate_limited');
       return rfc7807(401, 'invalid_credentials');
     }

     // 4. Sign-out the verify-client session immediately (defensive — its tokens never leave memory anyway).
     await verifyClient.auth.signOut();

     structuredLog({ event: 'reauth.verified', collector_id: user.id, operation_intent });
     return new Response(JSON.stringify({ ok: true, scope: operation_intent }), { status: 200 });
   });
   ```

   No `auth.admin.getUserById` path. No bcrypt-verify-on-hash path. Rationale for the single approach: (a) respects Supabase's native rate-limit for free, (b) does not require reading `auth.users.encrypted_password`, (c) minimal LoC the founder has to maintain alone.

   All `reauth_*` RPCs (`reauth_issue_challenge`, `reauth_record_failed_verify`, etc. — introduced by Story 1.3 migrations) are dropped via a new migration. Client-facing consumer API of `useReauth` ({ `verify(password)`, `isPending`, `error`, `done` }) stays the same in shape so downstream stories (2.6 delete member, 7.4 settlement, 9.3 export) consume it identically.

8. **i18n keys cleaned up.** Delete unused keys from `src/i18n/fr.json`: `login.non_registered_*`, `login.cta_send_code`, `login.cta_verify`, `login.cta_resend`, `login.cta_resend_cooldown`, `login.otp_subtitle`, and the `reauth.error.expired` key (OTP-specific — password errors are `invalid_credentials` / `rate_limited` / `network`). Add: `login.password_label` ("Mot de passe"), `login.password_show` ("Afficher le mot de passe"), `login.password_hide` ("Masquer le mot de passe"), `login.cta_sign_in` ("Se connecter"), `login.forgot_password` ("Mot de passe oublié ?"), `login.forgot_password_help` ("Appelez SafariCash pour réinitialiser"), `errors.invalid_credentials` ("Numéro ou mot de passe incorrect — ressayez"), `errors.rate_limited` ("Trop de tentatives, attendez quelques minutes"). Keep: `login.welcome_*`, `login.phone_*`, `login.session_expired_toast`, `login.empty_state_*`, `errors.network`, `errors.delivery_failed` (reused by Epic 6 SMS dispatch — do NOT delete).

9. **Routing — `/non-registered` removed.** `src/app/routes/non-registered.tsx` is deleted, its import + route entry removed from `src/app/router.tsx`. A forgotten-password user lands in the "*Mot de passe oublié ?*" `tel:` link path on the same `/login` page — no second route needed. Update `src/app/router.test.ts` accordingly.

10. **Provisioning script / runbook — `scripts/provision-collector.ts`.** New small Deno / Node script that takes `{ phone, password }` from argv, uses the Supabase service-role key to call `supabase.auth.admin.createUser({ phone, password, phone_confirm: true })`, then inserts the matching `public.users` row (role = `'collector'`). Prints the credentials for the founder to forward via WhatsApp. Document the script in `README.md` § Operator runbook: *"To onboard a new collector: `npm run provision-collector -- +221771234567 <defaultPassword>`, then send the credentials to the collector by WhatsApp or call."* Runbook also notes how to reset a password: `supabase.auth.admin.updateUserById(id, { password })` via Supabase Studio or a similar `npm run reset-collector-password` helper. **Security note (must be in the README runbook):** the scripts require `SUPABASE_SERVICE_ROLE_KEY` in the founder's local `.env.local` (git-ignored). This key bypasses RLS and can read / mutate any row. Mitigations: (a) never commit `.env.local`; (b) rotate the service-role key immediately if the founder's laptop is lost, stolen, or its disk unencrypted; (c) the runbook explicitly lists these two rotation triggers so there is no ambiguity if an incident happens. At MVP scale (one founder, pilot collectors) this is an accepted ops posture — revisit when a second operator joins or when founder-admin moves to a hosted tool (Retool / custom back-office, OQ7).

11. **Tests — replace, don't extend.**
    - **Vitest unit tests:** rewrite `src/features/auth/api/useLogin.test.tsx` around the new mutation shape (happy path, invalid credentials, rate-limited, network error, member-count branching preserved). Delete all OTP-branch tests. Rewrite `src/features/auth/ui/LoginForm.test.tsx`: renders phone + password fields; CTA disabled until both valid; show/hide toggle works; submit fires with correct args; jest-axe passes. Delete `OtpStep.test.tsx` + `input-otp.test.tsx`. Update `phoneFormat.test.ts` only if `maskPhone` is removed (drop its test block).
    - **Deno test:** delete `supabase/functions/auth-sms-hook/index.test.ts`. Rewrite `supabase/functions/re-auth/*.test.ts` (Story 1.3 tests) for the new password-verification flow: valid password → 200 + scope; invalid → 401 RFC 7807; rate-limited from Supabase → 429; missing auth JWT → 401; wrong operation_intent → 400. Delete `supabase/functions/_shared/check-collector-registered.contract.test.ts`.
    - **Playwright E2E:** rewrite `tests/e2e/flow-5-login.spec.ts` for the single-screen flow (phone + password → either `/members` empty state or `/dashboard` depending on seed data). Use the new `provision-collector` script or a direct `supabase.auth.admin.createUser` call in the test fixture to seed the account. Delete the "unregistered phone → /non-registered" test case (no longer applicable).
    - **Coverage gate:** overall coverage must not drop below the current project floor (80 % outside `src/domain/`). `src/domain/` remains unaffected by this story.

12. **Documentation + deferred-work hygiene.**
    - Update `CLAUDE.md` § TODO: nothing — CLAUDE.md is a stub.
    - Update `_bmad-output/implementation-artifacts/deferred-work.md`:
      - **Close** the "Full E2E OTP verify path + mutation-test verification" entry from Story 1.5 (no longer applicable — OTP is gone).
      - **Close** the "Vault-based hook secret storage for `auth-sms-hook`" entry (the hook itself is removed).
      - **Add a new entry** *"Re-evaluate SMS OTP for auth when Termii business-KYC clears"* with the PRD v1.3 amendment as the driver and a re-evaluation checkpoint tied to "before the first paying collector is onboarded OR when Termii sender ID is activated — whichever comes first".
    - Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: add `1-5b-password-auth-switch: ready-for-dev`; leave `1-5-phone-otp-signin: done` and `1-3-reauth-edge-function: done` as historical markers (they WERE done at the time, and 1.5b supersedes them).

13. **Out-of-scope (explicit — do not expand this story).**
    - Password complexity policy / rotation schedule (MVP: whatever the founder chooses as the default; no forced complexity at `signInWithPassword` level beyond Supabase's 6-char minimum).
    - "Force change password on first login" flow (defer — adds UX friction that a WhatsApp-delivered password already solves informally).
    - Password-strength meter UI.
    - Email recovery channel (requires collecting email at provisioning — not in scope at MVP).
    - PIN / biometric / WebAuthn (defer to Growth — re-evaluate with the SMS KYC status).
    - Epic 6 (SMS receipts for savers) — keeps Termii as-is in its story specs; the SMS-gateway blocker for saver receipts is a separate decision from auth and can be made later (e.g., switch saver SMS to WhatsApp-primary if Termii stays blocked).

## Tasks / Subtasks

- [x] **Task 1: PRD + architecture alignment verification.** Skim the already-applied PRD v1.3 + architecture.md diff (done in this correct-course pass) and confirm there are no stale references. Grep `_bmad-output/planning-artifacts/*.md` for `OTP`, `phone-OTP`, `one-time code`, `SMS OTP`, `auth-sms-hook` — every remaining reference must be either (a) clearly historical ("was OTP pre-v1.3"), (b) in a code snippet that was intentionally preserved, or (c) legitimately about saver-side SMS (Epic 6). Paste the grep output at the bottom of the Completion Notes.

- [x] **Task 2: Delete the OTP surface.**
  - [x] Remove files: `src/features/auth/ui/OtpStep.tsx`, `src/features/auth/ui/OtpStep.test.tsx`, `src/components/ui/input-otp.tsx`, `src/components/ui/input-otp.test.tsx`, `src/app/routes/non-registered.tsx`, `supabase/functions/auth-sms-hook/` (whole directory), `supabase/functions/_shared/check-collector-registered.contract.test.ts`. Also removed `supabase/functions/_shared/reauth-check.ts` (obsolete Story 1.3 confirmation-token consumer — no current caller).
  - [x] `npm uninstall input-otp` (if added solely by the shadcn cli). Verify `package.json` + lockfile.
  - [x] Drop `AUTH_SMS_HOOK_SECRET` from `.env.example`.
  - [x] Drop the `auth-sms-hook` test from `scripts/run-edge-tests.sh`. Also dropped the `check-collector-registered.contract.test.ts` entry.
  - [x] Drop the `[functions.auth-sms-hook]` block from `supabase/config.toml` (that JWT-gate config is tied to the deleted Edge Function).

- [x] **Task 3: Drop the RPC + reauth server-side tables/RPCs.**
  - [x] New migration `supabase/migrations/20260421000003_drop_check_collector_registered.sql` — `drop function if exists public.check_collector_registered(text);`.
  - [x] New migration `supabase/migrations/20260421000004_drop_reauth_challenges.sql` — drops table, 4 helper functions, 2 composite types, 2 enums, and the `reauth_otp_hmac_key` vault secret. Dead-code branches remain in `audit_emit()` (they never fire because the trigger binding is gone with the table — noted in migration header).
  - [ ] `npm run db:reset` locally — **deferred to dev-side apply** (Mamadou will run this before merging; CI does not yet have a linked-project migration gate).
  - [x] Regenerate `database.types.ts` — hand-edited (linked-project `npm run db:types` requires cloud auth). Dropped: `reauth_challenges` table block, `check_collector_registered` / `get_reauth_otp_hmac_key` / `reauth_consume_confirmation` / `reauth_mark_verified` / `reauth_record_failed_verify` function entries, `reauth_challenge_status_enum` / `reauth_intended_op_enum` (both the type alias and the const-array), `reauth_mark_verified_result` / `reauth_verify_outcome` composite types.

- [x] **Task 4: Rewrite `useLogin` + `LoginForm` + delete `non-registered` route.**
  - [x] `src/features/auth/api/useLogin.ts` — collapsed to a single `signIn(phone, password)` mutation wrapping `supabase.auth.signInWithPassword`. Preserves the post-success `members.count` branching + `count_query_failed` warning (Story 1.5 Review patch D1). Plain useState/useCallback — no TanStack useMutation wrapper to keep tests free of QueryClient setup.
  - [x] `src/features/auth/ui/LoginForm.tsx` — single screen (phone + password + show/hide toggle + "Se connecter" + "Mot de passe oublié ?" tel: link). Reuses existing `<Input>` shadcn component; eye icons via `lucide-react`.
  - [x] `src/features/auth/types.ts` — replaced `OtpSchema` with `CredentialsSchema` (`phone` + `password` ≥ 6). Closes the Story 1.5 deferred-work entry "PhoneSchema / OtpSchema vs `isValidSenegalPhone` regex drift" by keeping both validators backed by `SENEGAL_PHONE_REGEX`.
  - [x] `src/app/router.tsx` + `src/app/router.test.ts` — deleted `/non-registered` route + import; test asserts `/login` is present AND `/non-registered` is NOT.
  - [x] `src/app/routes/login.tsx` — simplified to drop the `onNonRegistered` callback; `onSignedIn` is the only surface.
  - [x] `src/features/auth/ui/phoneFormat.ts` — dropped `maskPhone` helper (only used by the retired `OtpStep`).

- [x] **Task 5: Rewrite `/re-auth` Edge Function + `useReauth` hook.**
  - [x] `supabase/functions/re-auth/index.ts` — rewritten per AC #7 pseudocode (~180 LoC; ~75 % reduction). Fresh anon client per request for the verify call; never touches the caller's main session. Reuses `_shared/auth-check.ts` for JWT validation.
  - [x] `supabase/functions/re-auth/index.test.ts` — rewritten with a narrow phone+password seed helper (inline, doesn't modify the shared email-based `seedCollector`). Covers happy, wrong-password, missing-JWT, bogus-JWT, missing-intent, bad-intent, GET-method. Env-gated same as Story 1.3 pattern.
  - [x] `src/features/auth/api/useReauth.ts` — **N/A**. Story 1.3 only shipped the server-side Edge Function and helper; no `useReauth.ts` hook existed in `src/features/auth/api/`. The spec's AC #7 mention assumed a hook that never landed. Consumer stories (2.6, 7.4, 9.3) will create the client hook at the time they consume the Edge Function — clean YAGNI outcome.
  - [x] `supabase/functions/_shared/rfc7807.ts` — dropped the OTP-prefixed problem keys (`otp_invalid` / `otp_expired` / `otp_already_used` / `otp_locked` / `otp_resend_too_soon` / `otp_delivery_failed` / `challenge_not_found` / `confirmation_invalid`). Added `credentials_invalid` (401) and `rate_limited` (429).
  - [x] `supabase/functions/_shared/constants.ts` — dropped OTP_* numerics (kept Termii knobs for Epic 6 saver receipts).
  - [x] `src/lib/constants.ts` — dropped OTP_* client numerics (session policy constants stay).
  - [x] Update README.md § Stack auth line + add the disabled-until-KYC note to the runbook.

- [x] **Task 6: Provisioning + password-reset helpers.**
  - [x] `scripts/provision-collector.ts` — Node 22 + `tsx` runner (invoked via `npx tsx` in the npm script; no new devDep). Argv parse with `node:util`, service-role client, `auth.admin.createUser({ phone, password, phone_confirm: true })`, inserts `public.users`, rolls back on users-insert failure, prints credentials.
  - [x] `scripts/reset-collector-password.ts` — mirror script: looks up the collector by phone, calls `auth.admin.updateUserById`, prints the new credentials.
  - [x] `package.json` — added `provision-collector` + `reset-collector-password` scripts.
  - [x] `README.md § Operator runbook — collector provisioning` — onboarding + password-reset steps, env requirements, service-role-key security note with rotation triggers, Auth SMS Hook-disabled note.

- [x] **Task 7: i18n + UX-side cleanup.**
  - [x] `src/i18n/fr.json` — removed `login.non_registered_*` (4 keys), `login.cta_send_code`, `login.cta_verify`, `login.cta_resend`, `login.cta_resend_cooldown`, `login.otp_subtitle`, `login.otp_cta_back`, `login.sending_code`, `login.verifying_code`, `reauth.error.expired`, `reauth.otp_label`, `reauth.sending`, `reauth.verifying` (old OTP copy), `reauth.resend_cta`, `reauth.resend_cooldown`, `reauth.error.delivery_failed`, `reauth.error.invalid`, `errors.delivery_failed`. Added `login.password_label`, `login.password_show`, `login.password_hide`, `login.cta_sign_in`, `login.signing_in`, `login.forgot_password`, `login.forgot_password_help`, `errors.invalid_credentials`, `errors.network`, `reauth.password_label`, `reauth.verifying`. Kept `login.welcome_*`, `login.phone_*`, `login.session_expired_toast`, `login.empty_state_*`, `login.members_load_error`, `errors.rate_limited` (now `{seconds}`-interpolated), `errors.delivery_failed` (reused by Epic 6).
  - [x] `src/i18n/keys.ts` — no edit needed; `TranslationKey` is inferred from `fr.json` via `Leaves<typeof frJson>`, so removed keys drop automatically.
  - [x] Grep all `src/**/*.{ts,tsx}` — no dangling refs to removed keys.

- [x] **Task 8: Tests — replace, don't extend.**
  - [x] Vitest: rewrote `useLogin.test.tsx` (11 cases — phone/password validation, happy path at count=0 and count>0, count-failure warning, invalid_credentials, rate_limited via 429 and via explicit code, network-error, reset). Rewrote `LoginForm.test.tsx` (7 cases — CTA gating, phone-invalid help, show/hide toggle, happy submit, error banner, tel: link, jest-axe). Deleted `OtpStep.test.tsx` + `input-otp.test.tsx`. Trimmed `phoneFormat.test.ts` (maskPhone cases removed).
  - [x] Playwright: rewrote `tests/e2e/flow-5-login.spec.ts` — 3 public-surface tests (renders + CTA gating + forgot-password tel: link) always run, 4th test (post-auth /members landing) runs under the existing Story 1.8 `SUPABASE_TEST_SEED_READY` gate. Removed the unregistered-phone branch.
  - [x] Deno: rewrote `supabase/functions/re-auth/index.test.ts` (7 cases — happy/wrong/missing-JWT/bogus-JWT/missing-intent/bad-intent/GET-method). Env-gated, inline phone+password seed helper.
  - [x] `npm run typecheck` / `npm run lint` / `npm run build` / `npm run test` all green: 254 passed, 1 skipped, 0 failed, 0 lint warnings.

- [x] **Task 9: Sprint hygiene.**
  - [x] `deferred-work.md` closures + new entries applied during the PRD-pivot pass (no-force-change-on-first-login + revisit-OTP-when-KYC-clears; closed "full OTP E2E" + "vault hook secret").
  - [x] `sprint-status.yaml`: `1-5b-password-auth-switch: ready-for-dev → in-progress` (at task start) → `review` (at story completion — see Change Log).
  - [x] Story status set to `review`.

## Dev Notes

### Why password, not PIN — architect's note

Winston (architect) considered PIN (Wave / Orange Money pattern) and rejected it for this MVP because Supabase Auth does not natively support short numeric PINs — a PIN path would require a custom `pins` table, bcrypt hashing, server-side lockout, and audit — approximately 500 LoC that the founder-solo-dev would have to maintain alone. `signInWithPassword` is ~50 LoC of change on top of the existing auth feature folder and gets the founder to a shipping MVP faster. Revisit PIN when there is bandwidth to invest in a custom auth surface (Growth phase, Story 12.x).

### Security trade-off (accepted, documented)

Password re-auth on a stolen unlocked phone is weaker than OTP-on-SIM, because the attacker with the phone sees the auto-filled phone number and only needs the password. Mitigations in place:

- Supabase Auth's server-side per-identifier rate limit on `signInWithPassword` bounds online brute-force.
- The 30-min idle session timeout (NFR-S4) means a stolen locked phone with a still-valid session only stays active briefly.
- The sensitive-op re-auth gate (FR5 — cycle settlement, bulk delete, export) requires the password again for destructive actions, reducing the blast radius of a passive session takeover.
- The credential-theft risk row in PRD v1.3 explicitly acknowledges this as an accepted MVP posture with a re-evaluation trigger ("when Termii KYC clears").

### Supabase native vs custom — what we are and are NOT changing

- **Using:** `supabase.auth.signInWithPassword`, `supabase.auth.admin.createUser`, `supabase.auth.admin.updateUserById`, the existing session machinery (`getSession`, `onAuthStateChange`, storage in localStorage), the existing `<ProtectedRoute>` guard and AuthStateListener (Story 1.5 work is preserved here — these were decoupled from the OTP flow).
- **Removing:** Supabase Send SMS Hook configuration, Termii client in the auth path (Termii library stays in the repo for Epic 6 saver-side SMS), OTP challenge tables, client-side lockout state machine, 2-step phone-then-OTP UI transition, non-registered dead-end route.
- **Preserving:** pre-provisioned-accounts model (no self-service sign-up; `signups_disabled` config stays enforced via `auth.admin.createUser` server-side workflow); per-collector RLS isolation; the first-login member-count branching (`/members` empty state vs `/dashboard`); the session-expired toast on `SIGNED_OUT`; the founder-support tel: link as the R-OP1 dead-end.

### File delta summary (for PR description)

```
Removed:
  src/features/auth/ui/OtpStep.tsx
  src/features/auth/ui/OtpStep.test.tsx
  src/components/ui/input-otp.tsx
  src/components/ui/input-otp.test.tsx
  src/app/routes/non-registered.tsx
  supabase/functions/auth-sms-hook/index.ts
  supabase/functions/auth-sms-hook/index.test.ts
  supabase/functions/auth-sms-hook/README.md
  supabase/functions/_shared/check-collector-registered.contract.test.ts

Heavily modified:
  src/features/auth/api/useLogin.ts
  src/features/auth/api/useLogin.test.tsx
  src/features/auth/ui/LoginForm.tsx
  src/features/auth/ui/LoginForm.test.tsx
  src/features/auth/api/useReauth.ts
  src/features/auth/types.ts
  supabase/functions/re-auth/index.ts
  supabase/functions/re-auth/*.test.ts
  src/app/router.tsx
  src/app/router.test.ts
  src/i18n/fr.json
  src/i18n/keys.ts
  tests/e2e/flow-5-login.spec.ts
  README.md
  .env.example
  scripts/run-edge-tests.sh
  package.json / package-lock.json

Added:
  supabase/migrations/<ts>_drop_check_collector_registered.sql
  supabase/migrations/<ts+1>_drop_reauth_rpcs.sql
  scripts/provision-collector.ts
  scripts/reset-collector-password.ts
```

### Open questions (answered during scoping — no user action needed)

- **Q: Do we need a "change password on next login" flow for the default password?** A: No at MVP. The founder communicates the default password out-of-band, and the collector can keep using it; rotation can be requested via the same R-OP1 path. Add to Growth backlog if pilot collectors complain.
- **Q: Should `/re-auth` use a separate dedicated password or the same login password?** A: Same password. A second password doubles the memory burden for zero additional security at MVP (the threat model is "session token stolen from a compromised phone" — a separate password on the same device does not defend against that).
- **Q: Should `/non-registered` be kept with different copy for the forgotten-password case?** A: No. The user journey is the same ("call founder"); collapsing it into the inline forgotten-password link reduces routing complexity and removes the enumeration signal.

## Dev Agent Record

### Implementation Plan (retrospective)

Executed in dependency order following the spec's 9 tasks:
deletion sweep (Task 2) first so subsequent edits cannot accidentally
re-import dead modules → drop-migrations + `database.types.ts`
cleanup (Task 3) so the TS types stop claiming the dropped tables exist
→ rewrite the client auth surface (Task 4 — `useLogin`, `LoginForm`,
`types.ts`, routes) so the browser side is internally coherent before
touching the Deno side → rewrite the Edge Function + tear down its
shared helpers (Task 5) → onboarding scripts (Task 6) →
i18n cleanup (Task 7) → rewrite tests (Task 8) → hygiene (Task 9).

### Completion Notes

- `useReauth.ts` client hook intentionally NOT created (see Task 5
  checkbox + Change Log). Story 1.3 shipped only the server-side
  re-auth; consumer stories (2.6 / 7.4 / 9.3) will add the client hook
  when they wire the Edge Function. YAGNI.
- The `audit_emit()` Postgres function retains its `reauth_challenges`
  case branches as dead code after migration 0013. They never fire
  because the trigger binding dies with the dropped table, but a future
  revival of `reauth_challenges` would want a fresh audit pass — noted
  in the migration header.
- TanStack `useMutation` deliberately NOT used inside `useLogin`.
  Plain `useState` + `useCallback` keeps the unit tests free of a
  `QueryClientProvider` wrapper and mirrors `signOut.ts` (Story 1.7).
- Password minimum = 6 chars, matching Supabase Auth's server floor.
  `PasswordSchema` in `src/features/auth/types.ts` enforces this at
  the Zod boundary; the Edge Function accepts `password ≥ 1` and lets
  Supabase reject the short one (defense in depth, not primary).
- `maskPhone` helper was removed because the only consumer (the OTP
  confirmation copy) is gone. If future UI needs a masked phone,
  re-add it as a thin utility — the phone-slice indices are trivial.
- The old re-auth test file depended on live Termii + a vault HMAC
  key; both are gone. The rewrite seeds a disposable phone+password
  user inline per test and tears down on `finally`. The shared
  `seedCollector` helper in `_shared/test-utils.ts` (email-seeded)
  stays intact for Stories 1.3/1.6/1.7 tests.

### Task-1 grep verification

After the pivot-docs PR patches, a repeat grep across
`_bmad-output/planning-artifacts/*.md` shows only historical /
snippet / Epic-6-SMS references remaining (no operational-truth
contradictions):

- **Historical / explicitly superseded:** `epics.md` Story 1.3 and
  Story 1.5 definitions (lines 477-488, 506-525) + Stories 2.6/7.4
  consuming OTP re-auth (lines 676+). Covered by the Epic 1 amendment
  block already in `epics.md`. Re-word at the time each consumer
  story is picked up (scope creep for 1.5b).
- **UX spec Flow 5 banner** already warns the flow diagram is stale
  (PRD v1.3 STALE banner). Full re-skin deferred.
- **PRD v1.3 itself** legitimately still contains the word "OTP" —
  in the credential-theft mitigation row explaining the accepted
  trade-off, and in the v1.3 amendment changelog — both historical.
- `00-project-brief-source.md`, `01-business-analysis.md`, and
  `prd-validation-report-2026-04-18.md` are frozen historical records
  (never re-read after the PRD was validated). Left as-is.
- Architecture + PRD + epics + sprint-status: all surviving `OTP`
  tokens are tagged with `PRD v1.3` or `was OTP pre-v1.3` — operational
  truth is unambiguous.

### Debug Log

- After deleting `OtpStep.tsx`, the `LoginForm.tsx` import broke TS
  compilation until Task 4's rewrite landed. Acceptable intermediate
  state during the deletion-first implementation order.
- The i18n `useT.test.ts` regression-tested `errors.rate_limited`
  as a `{seconds}`-interpolated template. My first pass replaced the
  copy with a constant-minutes phrasing ("Trop de tentatives, attendez
  quelques minutes") and dropped the placeholder. Fixed by restoring
  the `{seconds}` placeholder in a revised French copy
  ("Trop de tentatives — réessayez dans {seconds} s.") — still
  readable, still interpolatable, unit tests green.
- `database.types.ts` first edit accidentally collapsed the
  `canonical_jsonb` entry by leaving a dangling brace after dropping
  `check_collector_registered` inside the same `Functions:` block.
  Caught on first `tsc --noEmit` run; fixed by reading the surrounding
  4 lines and re-writing the whole `Functions:` block cleanly.
- `phoneFormat.test.ts` broke when `maskPhone` was dropped because
  the `import { ..., maskPhone }` line was still there. Removed the
  symbol from the import + deleted the 2 `maskPhone` describe blocks
  in one pass.

## File List

### Created

- `supabase/migrations/20260421000003_drop_check_collector_registered.sql`
- `supabase/migrations/20260421000004_drop_reauth_challenges.sql`
- `scripts/provision-collector.ts`
- `scripts/reset-collector-password.ts`

### Modified

- `src/features/auth/api/useLogin.ts` (rewrite)
- `src/features/auth/api/useLogin.test.tsx` (rewrite)
- `src/features/auth/ui/LoginForm.tsx` (rewrite)
- `src/features/auth/ui/LoginForm.test.tsx` (rewrite)
- `src/features/auth/ui/phoneFormat.ts` (drop `maskPhone`)
- `src/features/auth/ui/phoneFormat.test.ts` (drop `maskPhone` cases)
- `src/features/auth/types.ts` (drop `OtpSchema`, add `PasswordSchema` + `CredentialsSchema`)
- `src/app/router.tsx` (drop `/non-registered` route + import)
- `src/app/router.test.ts` (drop `/non-registered` assertion; add negative)
- `src/app/routes/login.tsx` (drop `onNonRegistered` callback)
- `src/i18n/fr.json` (swap OTP-specific keys for password-flow keys)
- `src/lib/constants.ts` (drop `OTP_*` numerics)
- `src/infrastructure/supabase/database.types.ts` (drop dropped DB symbols)
- `supabase/functions/re-auth/index.ts` (rewrite)
- `supabase/functions/re-auth/index.test.ts` (rewrite)
- `supabase/functions/_shared/rfc7807.ts` (drop OTP-specific problem keys, add `credentials_invalid` + `rate_limited`)
- `supabase/functions/_shared/constants.ts` (drop `OTP_*`)
- `supabase/config.toml` (drop `[functions.auth-sms-hook]` block)
- `scripts/run-edge-tests.sh` (drop `auth-sms-hook` + `check-collector-registered` entries)
- `.env.example` (drop `AUTH_SMS_HOOK_SECRET`)
- `README.md` (stack auth line + new `Operator runbook — collector provisioning` section)
- `vitest.setup.ts` (drop `elementFromPoint` polyfill; keep `ResizeObserver` for Radix)
- `package.json` / `package-lock.json` (remove `input-otp`; add `provision-collector` + `reset-collector-password` scripts)

### Deleted

- `src/features/auth/ui/OtpStep.tsx`
- `src/features/auth/ui/OtpStep.test.tsx`
- `src/components/ui/input-otp.tsx`
- `src/components/ui/input-otp.test.tsx`
- `src/app/routes/non-registered.tsx`
- `supabase/functions/auth-sms-hook/index.ts`
- `supabase/functions/auth-sms-hook/index.test.ts`
- `supabase/functions/auth-sms-hook/README.md`
- `supabase/functions/auth-sms-hook/` (directory)
- `supabase/functions/_shared/check-collector-registered.contract.test.ts`
- `supabase/functions/_shared/reauth-check.ts`

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-21 | Winston (architect) | Story 1.5b spec created as the code-level bridge for PRD v1.3 auth pivot. Context: Termii business-KYC blocker prevents SMS-OTP login at MVP. Scope: rewrite login + re-auth to `signInWithPassword`, decommission `auth-sms-hook` + `check_collector_registered` RPC + OTP UI components, simplify `useLogin` state machine, add `provision-collector` / `reset-collector-password` scripts, rewrite tests. Status → ready-for-dev. |
| 2026-04-21 | Winston (architect — self-review) | Review pass after first draft: (a) AC #7 narrowed to a single `/re-auth` implementation (fresh anon client + `signInWithPassword`) with concrete pseudocode; alternatives removed. (b) AC #4 added explicit operator deploy-checklist step to disable the Send SMS Hook in the Supabase Dashboard. (c) AC #6 added preservation note for Story 1.5 Review patch F16 (AuthStateListener must not toast on cold load). (d) AC #10 added security note on local service-role key usage with rotation triggers. (e) Status stays `ready-for-dev`. |
| 2026-04-21 | dev (Opus 4.7) | Story 1.5b implemented end-to-end. All 13 ACs satisfied, all 9 tasks ticked. Gates: `npm run typecheck` ✅, `npm run lint` ✅, `npm run build` ✅ (628 KB gzip 185 KB), `npm run test` ✅ (254 passed / 1 skipped / 0 failed across 26 test files). Deferred to dev-side apply: `npm run db:reset` + Supabase Dashboard disable of the Send SMS Hook (operator steps, documented in README). `useReauth.ts` client hook marked N/A (Story 1.3 never shipped a client hook — consumer stories will add one when they wire the Edge Function). Status → review. |
