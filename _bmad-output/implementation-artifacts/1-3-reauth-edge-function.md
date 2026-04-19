# Story 1.3: Re-auth Edge Function (built once, consumed many times)

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer on the SafariCash MVP**,
I want **a single hardened Edge Function that issues and verifies SMS OTP for sensitive operations and returns a short-lived single-use confirmation token**,
so that **every downstream story requiring re-authentication (Story 2.6 member delete, Story 7.4 cycle settlement, Story 9.3 CSV export, Story 6.x receipt resend) consumes the same primitive without re-implementing OTP issuance, lockout, or audit emission**.

## Acceptance Criteria

1. **Edge Function exists at the canonical path.** `supabase/functions/re-auth/index.ts` is deployed (locally via `supabase start` and remote via `supabase functions deploy re-auth`); it responds at `POST /functions/v1/re-auth`. The function imports from `supabase/functions/_shared/` and follows architecture.md § Naming Patterns + § Implementation Patterns conventions (kebab-case folder, `index.ts` entry, snake_case wire JSON, ISO 8601 UTC timestamps).
2. **Two-action wire contract (issue + verify).** Request body is a Zod-validated tagged-union: `{ action: 'issue', intended_op: 'cycle_settlement' | 'member_delete' | 'csv_export' | 'sms_resend' }` OR `{ action: 'verify', challenge_id: uuid, otp: string }`. Both actions require an authenticated caller (Supabase JWT validated via `_shared/auth-check.ts`); 401 with RFC 7807 if missing/invalid. 4xx and 5xx responses always use RFC 7807 Problem Details (`{type, title, status, detail, instance}`).
3. **Issue mode behaviour.** A POST with `action='issue'` (a) generates a fresh 6-digit numeric OTP via cryptographic RNG (`crypto.getRandomValues`), (b) computes `otp_hash = HMAC-SHA256(otp, server_hmac_key)` where `server_hmac_key` is fetched from a Vault secret named `reauth_otp_hmac_key` (provisioned by migration 0008), (c) inserts a row into `public.reauth_challenges` with `status='pending'`, `expires_at = now() + 5 minutes`, (d) calls `_shared/termii-client.ts` to dispatch the OTP via SMS to the collector's registered phone number, (e) returns `{ challenge_id, expires_at, resend_available_at }` (`resend_available_at = now() + 30 seconds`, the cooldown). The raw OTP NEVER appears in the response body, in audit_log, or in any log line. The endpoint logs structured JSON to stdout per architecture.md § Observability — log shape `{level, event:'reauth.issued', collector_id, intended_op, challenge_id, duration_ms}`, no OTP.
4. **Verify mode behaviour.** A POST with `action='verify'` looks up the challenge row by `challenge_id` AND `collector_id = auth.uid()` (caller-bound; cross-collector challenge access returns 404 not 401, so an attacker cannot enumerate). The function (a) rejects with `otp/expired` (410) if `now() > expires_at`, (b) rejects with `otp/locked` (429 + `Retry-After` header set to `lockout_until - now()` in seconds) if `lockout_until is not null and now() < lockout_until`, (c) rejects with `otp/already_used` (409) if `status != 'pending'`, (d) recomputes `HMAC-SHA256(submitted_otp, server_hmac_key)` and constant-time compares to `otp_hash`. On match: updates the row to `status='verified'`, generates a `confirmation_token uuid`, sets `confirmation_expires_at = now() + 2 minutes`, returns `{ confirmation_token, confirmation_expires_at }` (200). On mismatch: increments `attempts`, returns `otp/invalid` (401) with `attempts_remaining` field. After the 3rd consecutive failed verify on the same challenge, the function sets `lockout_until = now() + 5 minutes`, status='locked', and returns `otp/locked` (429).
5. **Lockout policy (NFR-S4 parity).** 3 failed verifies on a single challenge → 5-minute lockout on that challenge AND on any new `issue` for the same `(collector_id, intended_op)` pair within the lockout window. The Edge Function MUST check for an active lockout when handling a fresh `issue` request and reject with `otp/locked` (429) without dispatching a new SMS. Story 1.5 (phone-OTP login) uses the same numeric thresholds — they are constants in `src/lib/constants.ts` (see Task 7).
6. **Resend cooldown.** A second `issue` for the same `(collector_id, intended_op)` within 30 seconds of the previous issue returns `otp/resend_too_soon` (429 + `Retry-After`) without dispatching a duplicate SMS. The previous challenge remains active.
7. **Confirmation-token consumer helper.** `supabase/functions/_shared/reauth-check.ts` exports `consumeConfirmation(supabase, collectorId, intendedOp, confirmationToken) → { ok: true } | { ok: false, problem: <RFC7807> }`. Consumer Edge Functions (Story 7.4 cycle-settlement, Story 2.6 member-delete-edge-fn-if-needed, Story 9.3 csv-export, Story 6.x sms-resend) call this BEFORE committing the sensitive operation. The helper atomically marks `confirmation_used = true` and asserts `now() < confirmation_expires_at` AND `intended_op` matches AND `collector_id` matches AND `confirmation_used = false` — all in a single UPDATE-RETURNING. Reuse, expiration, mismatch, or wrong collector all return a generic `confirmation/invalid` (403) — distinguishing reasons would leak whether a token exists.
8. **No main-session extension.** The Edge Function NEVER calls Supabase Auth `verifyOtp` or any API that mints/refreshes the caller's session JWT. The `confirmation_token` is a row UUID in `reauth_challenges`, not a Supabase session token. Sessions follow NFR-S4 (30-min idle / 30-day absolute) independently of re-auth state — re-auth is a one-shot challenge per sensitive op (architecture.md § Authentication & Security explicitly: *"No 'elevated session' token — every sensitive operation re-auths fresh"*).
9. **Audit log emission for every state-mutating event.** Every `reauth_challenges` row INSERT and every status-changing UPDATE produces an audit_log entry via the Story 1.2 `audit_emit()` trigger (extended in migration 0008 to include `reauth_challenges`). Status-aware mappings:
   - INSERT (status='pending') → `reauth.requested`
   - UPDATE to status='verified' → `reauth.verified`
   - UPDATE to status='failed' (3rd attempt before lockout) → `reauth.failed`
   - UPDATE to status='locked' (3-attempt threshold crossed) → `reauth.locked`
   - UPDATE to status='expired' (cleanup job, future story) → `reauth.expired`
10. **Schema migration applied.** Migration `20260419000008_reauth_challenges.sql` creates `public.reauth_challenges` table + 2 enums (`reauth_intended_op_enum`, `reauth_challenge_status_enum`) + RLS policies (anon deny + collector SELECT-only; INSERT/UPDATE locked to service_role) + extends `audit_emit()` trigger to fire on `reauth_challenges` with the status-aware event mappings above. Vault secret `reauth_otp_hmac_key` is provisioned in the same migration via `vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'reauth_otp_hmac_key')`.
11. **Termii client honours NFR-S2 + NFR-R4.** `_shared/termii-client.ts` POSTs to Termii's transactional SMS endpoint over TLS 1.2+ (NFR-S2). The client implements exponential backoff for transient 5xx (initial 10s, max 3 retries within the Edge Function timeout), but a hard failure surfaces as `otp/delivery_failed` (502) with no row mutation — the caller can retry (resend cooldown applies). Termii API key is read from `TERMII_API_KEY` env (set in Supabase project secrets dashboard, never in repo). Per NFR-R4 the long-tail retry queue is owned by Story 6.2's sms-worker and is OUT of scope for Story 1.3 — re-auth dispatches synchronously and fails fast.
12. **Tests cover happy path + 3 failure modes + 1 lockout.** A new Vitest integration suite at `supabase/functions/re-auth/index.test.ts` (executed via Deno test runner — see Task 9) covers: (a) issue happy path (200 + challenge_id + SMS dispatched stub-asserted), (b) verify happy path (200 + confirmation_token), (c) wrong OTP (401 + attempts_remaining decremented), (d) expired challenge (410), (e) 3-attempt lockout (3rd attempt returns 429 + `Retry-After`), (f) cross-collector challenge (404). A Playwright + Supabase JS E2E at `tests/e2e/reauth-flow.spec.ts` exercises the full HTTP round-trip against the local Supabase stack (using a stub Termii server or Termii's own sandbox — see Task 11). Both test files run in CI via the Story 1.2 ci.yml workflow with no additional plumbing.

## Tasks / Subtasks

- [ ] **Task 1: Author migration `20260419000008_reauth_challenges.sql`** (AC: 9, 10) — see Dev Notes § Schema specification
  - [ ] Create enum `public.reauth_intended_op_enum AS ENUM ('cycle_settlement', 'member_delete', 'csv_export', 'sms_resend')`
  - [ ] Create enum `public.reauth_challenge_status_enum AS ENUM ('pending', 'verified', 'failed', 'locked', 'expired')`
  - [ ] Create table `public.reauth_challenges` per Dev Notes § Schema specification (full column list, FKs, defaults, CHECKs, `set_updated_at` trigger)
  - [ ] Indexes: `idx_reauth_challenges_collector_id_intended_op_created_at` (composite, DESC on created_at) for the active-lockout lookup; `idx_reauth_challenges_confirmation_token` (UNIQUE, partial WHERE confirmation_token IS NOT NULL) for `consumeConfirmation` lookup
  - [ ] RLS: `ENABLE` + `FORCE`; explicit anon deny policy; SELECT-only policy for authenticated `collector_id = auth.uid()`; NO INSERT/UPDATE policy (writes are service_role only — Edge Function uses service-role key inside its handler)
  - [ ] REVOKE INSERT/UPDATE/DELETE on `reauth_challenges` from authenticated and anon (defense-in-depth — service_role retains via Postgres default)
  - [ ] Extend `public.audit_emit()` (CREATE OR REPLACE FUNCTION) to handle `reauth_challenges`: INSERT → `reauth.requested`, UPDATE branches based on `(NEW.status, OLD.status)` transitions per AC 9. Trigger attached: `CREATE TRIGGER audit_reauth_challenges AFTER INSERT OR UPDATE ON public.reauth_challenges FOR EACH ROW EXECUTE FUNCTION public.audit_emit()`
  - [ ] Provision Vault secret `reauth_otp_hmac_key` via `do $$ select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'reauth_otp_hmac_key', 'HMAC-SHA256 key for OTP hashing in reauth_challenges (Story 1.3)'); $$;` (idempotent: skip if secret with name already exists). Capture the secret_id in a comment for ADR cross-reference.
  - [ ] Verify migration applies cleanly via `supabase db reset --linked` against the cloud project
  - [ ] Update `database.types.ts` via `npm run db:types` and commit

- [ ] **Task 2: Create `_shared/auth-check.ts`** (AC: 2) — RLS-equivalent entry-point guard reused by every Edge Function
  - [ ] Export `assertAuthenticated(req: Request): Promise<{ collectorId: string; jwt: string }>`. Reads the `Authorization: Bearer <jwt>` header, validates via `supabase.auth.getUser(jwt)`, returns the resolved `collector_id` (= `auth.users.id`) AND the raw JWT (for downstream service-role-vs-collector attribution).
  - [ ] On invalid/missing JWT: throw a typed `AuthError` carrying an RFC 7807 problem (`type: 'auth/unauthenticated', status: 401`)
  - [ ] On JWT valid but `users` row missing in `public.users` (deleted collector edge case): throw with `type: 'auth/user_not_provisioned', status: 403`
  - [ ] Unit-tested via Deno test (Task 9) using a stub `getUser` mock

- [ ] **Task 3: Create `_shared/rfc7807.ts`** (AC: 2) — Problem Details builder + standard `Response` factory
  - [ ] Export `problem(status: number, type: string, title: string, detail?: string, extra?: Record<string, unknown>): Response` returning a `Response` with `Content-Type: application/problem+json`, body matching RFC 7807 (`{type, title, status, detail, instance: req.url, ...extra}`)
  - [ ] Export a typed `Problem` Zod schema for parsers / consumer-side helpers
  - [ ] Cover the 9 problem types Story 1.3 emits in a `KNOWN_PROBLEMS` const map (see Dev Notes § RFC 7807 problem types) so Story 7.4 / 2.6 / 9.3 / 6.x can reference them by symbol

- [ ] **Task 4: Create `_shared/termii-client.ts`** (AC: 11) — minimal HTTP wrapper for the Termii transactional SMS endpoint
  - [ ] Export `sendSms({ to, body, channel?: 'generic' | 'dnd' }): Promise<{ message_id: string }>` calling `POST https://api.ng.termii.com/api/sms/send` with Bearer auth from `TERMII_API_KEY` env
  - [ ] Throws a typed `TermiiError` with the upstream HTTP status + body excerpt on non-2xx; logger MUST mask the request body (the OTP) before logging
  - [ ] Implements 3 retries with exponential backoff (1s, 2s, 4s) only for 5xx and ECONNRESET — 4xx fail immediately
  - [ ] Use `fetch` (Deno native, no axios). Honour 5-second per-attempt timeout via `AbortController`
  - [ ] **Note:** Story 6.1 will extend this client (or wrap it in a queue worker). Keep the contract minimal but generic enough that 6.1 can re-use without breaking changes.

- [ ] **Task 5: Implement the re-auth handler** `supabase/functions/re-auth/index.ts` (AC: 1-8, 11) — see Dev Notes § Edge Function contract
  - [ ] Boilerplate: `Deno.serve(async (req) => { ... })` per Supabase Edge Functions canonical pattern
  - [ ] Parse + validate request via Zod `IssueRequestSchema | VerifyRequestSchema` (tagged union on `action`)
  - [ ] Resolve `{ collectorId }` via `assertAuthenticated(req)`; on auth failure return the AuthError's problem
  - [ ] Branch on `action`:
    - **'issue'** → run lockout pre-check; run resend-cooldown check; INSERT `reauth_challenges` row with HMAC'd OTP; call `termii-client.sendSms({to: lookupCollectorPhone(collectorId), body: composeOtpBody(otp)})`; on Termii success return `{challenge_id, expires_at, resend_available_at}`; on Termii failure ROLLBACK the INSERT (txn) and return `otp/delivery_failed` (502)
    - **'verify'** → SELECT challenge by `id` + `collector_id` (404 if not found); enforce expiry / lockout / already-used preconditions per AC 4 in that order; HMAC compare; on match UPDATE row to verified+token; on mismatch UPDATE attempts++; if attempts==3 UPDATE status='locked' + lockout_until
  - [ ] Wrap the handler in a try/catch — uncaught errors return `internal/unexpected` (500) with `instance` set; full stack logged to stdout per architecture.md § Observability
  - [ ] Use the service-role Supabase client inside the handler (`createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)`) — bypasses RLS by design (the handler enforces collector-bound semantics manually since we INSERT via service-role)
  - [ ] **NEVER** log the raw OTP. The structured log line must reference `challenge_id` only.

- [ ] **Task 6: Implement `_shared/reauth-check.ts` consumer helper** (AC: 7) — exported for Story 7.4 / 2.6 / 9.3 / 6.x
  - [ ] Export `consumeConfirmation(supabase, collectorId, intendedOp, confirmationToken): Promise<{ ok: true } | { ok: false, problem: ProblemDetails }>`
  - [ ] Single atomic UPDATE-RETURNING: `UPDATE reauth_challenges SET confirmation_used = true WHERE id = (SELECT id FROM reauth_challenges WHERE confirmation_token = $1 AND collector_id = $2 AND intended_op = $3 AND confirmation_used = false AND now() < confirmation_expires_at) RETURNING id`
  - [ ] If no row returned → return `{ok: false, problem: problem(403, 'confirmation/invalid', 'Confirmation token invalid or expired')}` (single error code — DO NOT distinguish "expired" vs "wrong op" vs "wrong collector" — leaks information)
  - [ ] Unit-tested via Deno test (Task 9) covering: happy path, expired token, reused token, wrong intended_op, wrong collector

- [ ] **Task 7: Add constants to `src/lib/constants.ts`** (AC: 5, 6) — single source of truth for OTP semantics
  - [ ] Create `src/lib/constants.ts` (file does not yet exist — empty `src/lib/.gitkeep` removed)
  - [ ] Export `OTP_LENGTH = 6`, `OTP_EXPIRY_MINUTES = 5`, `OTP_LOCKOUT_MINUTES = 5`, `OTP_MAX_ATTEMPTS = 3`, `OTP_RESEND_COOLDOWN_SECONDS = 30`, `CONFIRMATION_TOKEN_EXPIRY_MINUTES = 2`
  - [ ] Mirror the same values as Deno `const` in `supabase/functions/_shared/constants.ts` (Edge runtime cannot import from `src/`). Document the cross-runtime duplication with a comment that says "MUST stay in sync with src/lib/constants.ts" — Story 1.5 can later extract to a shared package if needed
  - [ ] Story 1.5 (phone-OTP login) will reuse `OTP_LENGTH`, `OTP_LOCKOUT_MINUTES`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS` from these constants — DO NOT redefine them in 1.5

- [ ] **Task 8: French copy strings** (AC: 12, French-native review) — exact strings reuse-able by consumer story UIs
  - [ ] Add to `src/i18n/fr.json` (creating the file if absent; `src/i18n/.gitkeep` removed) under namespace `reauth.*`:
    - `reauth.title`: "Vérification de sécurité"
    - `reauth.subtitle`: "Pour {{operation}}, nous vérifions que c'est bien vous."
    - `reauth.subtitle_op.cycle_settlement`: "clôturer ce cycle"
    - `reauth.subtitle_op.member_delete`: "supprimer ce membre"
    - `reauth.subtitle_op.csv_export`: "exporter ces données"
    - `reauth.subtitle_op.sms_resend`: "renvoyer ce reçu"
    - `reauth.otp_label`: "Code à 6 chiffres reçu par SMS"
    - `reauth.sending`: "Envoi du code…"
    - `reauth.verifying`: "Vérification du code…"
    - `reauth.resend_cta`: "Renvoyer le code"
    - `reauth.resend_cooldown`: "Renvoyer dans {{seconds}} s"
    - `reauth.error.invalid`: "Code incorrect"
    - `reauth.error.expired`: "Code expiré — Renvoyer le code"
    - `reauth.error.locked`: "Trop de tentatives. Réessayez dans {{minutes}} minutes."
    - `reauth.error.delivery_failed`: "Envoi du code échoué — retenter"
    - `reauth.error.network`: "Pas de réseau — vérifiez votre connexion"
    - `reauth.support_after_lockout`: "Si le problème persiste, appelez le {{founder_phone}}"
  - [ ] Wire `src/i18n/keys.ts` (typed key enum) and `src/i18n/useT.ts` (translation hook) per architecture.md § Project Structure (`src/i18n/` tree). Minimal `useT` is fine; full i18n machinery belongs to Story 1.5 onward.
  - [ ] **NFR-L5 follow-up:** flag in PR description that French-native compliance review of these strings should run before public launch (per `prd.md` NFR-L5)

- [ ] **Task 9: Test harness for Deno Edge Functions** (AC: 12) — first story to need this
  - [ ] Create `supabase/functions/_shared/test-utils.ts` exporting helpers: `createServiceClient()`, `seedCollector(phone)`, `mockTermiiServer()` (a tiny local HTTP server that records SMS dispatches without actually sending)
  - [ ] Document in README that Edge Function tests run via `deno test --allow-all supabase/functions/` against the local Supabase stack started by `supabase start`
  - [ ] Add to `package.json` a script: `"test:edge": "supabase functions serve --no-verify-jwt &disown ; deno test --allow-all supabase/functions/"` (or similar — verify exact CLI flag at implementation time, the Supabase CLI version is `^2.92`; `supabase functions serve` should already work)
  - [ ] Actually, simpler: invoke the handler directly via Deno test (import `index.ts`'s default export, call it with a `Request` mock). Pick whichever pattern is most idiomatic with Supabase CLI 2.92.x at story start. **Document the choice in Dev Agent Record.**
  - [ ] Wire `test:edge` into `.github/workflows/ci.yml` AFTER `supabase start` step; uses the same SUPABASE_LOCAL_* keys

- [ ] **Task 10: Implement Edge Function tests** `supabase/functions/re-auth/index.test.ts` (AC: 12)
  - [ ] beforeAll: spin up local Supabase via test-utils helper; seed 1 collector + retrieve their auth JWT
  - [ ] Test (a): happy issue — assert 200, `challenge_id` is a uuid, mock-Termii recorded 1 SMS, audit_log has 1 `reauth.requested` row
  - [ ] Test (b): happy verify — issue then verify with the captured OTP (from mock-Termii); assert 200, `confirmation_token` is a uuid, audit_log has `reauth.verified`
  - [ ] Test (c): wrong OTP — verify with `'000000'`; assert 401, `attempts_remaining: 2`, audit_log row update reflects attempts++
  - [ ] Test (d): expired challenge — issue, fast-forward `clock` (or update `expires_at` directly via service-role to a past timestamp), verify; assert 410
  - [ ] Test (e): 3-attempt lockout — verify wrong 3 times; 3rd response is 429 with `Retry-After`; audit_log shows `reauth.locked`; immediate new `issue` for same `(collector, intended_op)` returns 429 not a fresh SMS
  - [ ] Test (f): cross-collector challenge — collector A issues, collector B tries to verify with A's `challenge_id`; assert 404 (not 401, to prevent enumeration)
  - [ ] Test (g): consumer flow — issue, verify, then consumeConfirmation succeeds once; calling consumeConfirmation a second time with the same token returns `confirmation/invalid` (403)
  - [ ] Test (h): mock-Termii failure — Termii returns 500; assert 502 `otp/delivery_failed`; assert NO `reauth_challenges` row was inserted (transaction rolled back); assert NO audit_log row

- [ ] **Task 11: Playwright E2E for full HTTP round-trip** `tests/e2e/reauth-flow.spec.ts` (AC: 12) — also serves as integration smoke
  - [ ] Spin up local Supabase + a tiny Node-side mock Termii server on port 4567 (export `MOCK_TERMII_URL=http://localhost:4567` and have the test override the `TERMII_API_KEY` + Termii base URL so the Edge Function hits the mock)
  - [ ] Single E2E scenario: collector A signs in → POST /functions/v1/re-auth `issue` → captures the OTP from the mock-Termii server → POST `verify` → asserts confirmation_token returned → asserts a 2nd verify with same token fails
  - [ ] Wire into ci.yml after the existing Playwright step (no additional secrets, mock-Termii is a Node http.createServer)
  - [ ] Mutation-test verification: temporarily set `OTP_MAX_ATTEMPTS = 999` in constants → re-run E2E → confirm the lockout test now fails red. Restore. Document in PR description.

- [ ] **Task 12: Update `.env.example` + Supabase project secrets**
  - [ ] Verify `TERMII_API_KEY` line is present in `.env.example` (Story 1.1 should have added it; if not, add)
  - [ ] Add `SUPABASE_FUNCTIONS_URL` line if missing (used by client code in Story 7.4/2.6/9.3 to compose the re-auth URL — pattern `${SUPABASE_URL}/functions/v1/re-auth`)
  - [ ] In Supabase project secrets dashboard (manual operator step, document in PR): set `TERMII_API_KEY` to the real Termii sandbox key. **Do NOT commit the real key.**
  - [ ] Document the operator step in README under "Local dev — Edge Function secrets"

## Dev Notes

### Canonical references (do not deviate silently)

- **Edge Function path + behavioural contract:** `architecture.md § Project Structure & Boundaries → supabase/functions/re-auth/` (line ~828) AND `architecture.md § Authentication & Security → Sensitive-op re-auth` (line ~351) AND `architecture.md § Session Lifecycle → Sensitive ops re-auth via Edge Function /re-auth` (line ~656). The "no elevated session token" + "does NOT extend main session" wording is non-negotiable.
- **Shared Edge Function utilities:** `architecture.md § Project Structure → supabase/functions/_shared/` (lines 817-821). `auth-check.ts`, `audit-emit.ts`, `rfc7807.ts`, `termii-client.ts` are named explicitly. Story 1.3 is the FIRST story to create them — naming + signatures should anticipate Stories 6.1, 6.2, 7.4, 9.3 reuse.
- **Audit event taxonomy:** `architecture.md § Communication Patterns → Event naming` requires `{entity}.{action}` lowercase past-tense. New event types this story adds: `reauth.requested`, `reauth.verified`, `reauth.failed`, `reauth.locked`, `reauth.expired`. Update the event_type CHECK constraint regex in `audit_log` if it rejects these (Story 1.2's regex `^[a-z][a-z_]*\.[a-z][a-z_]*$` accepts them — verify).
- **Hash-chain integration:** Story 1.2's `audit_emit()` trigger handles the hash chain. Migration 0008 EXTENDS the trigger with a status-aware mapping for `reauth_challenges` (same pattern as the `cycle.settled` branch added in Story 1.2's review patches). Do NOT bypass the trigger — the hash chain MUST cover re-auth events.
- **RFC 7807 Problem Details:** `architecture.md § Communication Patterns → Edge Functions return RFC 7807 Problem Details for 4xx / 5xx` (line ~543). Wire format `{type, title, status, detail, instance}` plus extension fields like `attempts_remaining`. `Content-Type: application/problem+json`.
- **Naming patterns:** `architecture.md § Implementation Patterns & Consistency Rules → Naming Patterns`. Wire JSON snake_case (matches Postgres). TypeScript camelCase. Path `/functions/v1/re-auth` (kebab-case folder). The `camelize()` helper from Story 1.2 bridges where TS code consumes wire JSON.
- **Lockout numerics:** epics.md Story 1.3 AC line 486 (`5 minutes`, `3 attempts`, `5-minute lockout`); UX spec Flow 5 line 909 (login parity: 30s resend cooldown, 5-min lockout). All centralised in `src/lib/constants.ts` per Task 7.
- **French copy:** UX spec § Component Library (`ux-design-specification.md` line ~1395) error template `{action} échouée — {cause}`; UX spec line 200 reassuring header *"nous vérifions que c'est bien vous"*. Founder support phone `+221 77 791 58 98` (PRD line ~640).

### Anti-patterns to avoid (common Story 1.3 disasters)

- **Do NOT use Supabase Auth `verifyOtp` for re-auth.** It mints a fresh session JWT and resets the absolute-TTL clock — directly contradicts NFR-S4 + architecture.md § Authentication ("does NOT extend main session"). Use Termii direct + custom challenge table.
- **Do NOT store the raw OTP.** Even briefly. Even encrypted. Store HMAC-SHA256 with a Vault-stored key. The compare path uses constant-time comparison (Deno: `crypto.subtle.timingSafeEqual` if available, OR a manual XOR-fold).
- **Do NOT log the OTP.** Not in stdout, not in audit_log, not in error responses, not in the SMS template debug field. Audit rows reference `challenge_id` only. Logs reference `challenge_id` + `collector_id` only.
- **Do NOT distinguish "challenge not found" from "wrong collector".** Both return 404. Distinguishing leaks whether a `challenge_id` exists for someone else (enables enumeration of active challenges).
- **Do NOT distinguish `confirmation_token` failure modes.** "Expired", "wrong op", "wrong collector", "already used" → all return the same `confirmation/invalid` (403). The consumer story UIs only need to know the token doesn't work; the audit_log records the precise reason for forensics.
- **Do NOT set `app.actor` GUC from the Edge Function.** Story 1.2's audit trigger reads `app.source` (not actor). Actor is populated from `current_setting('request.jwt.claim.sub', true)` (the JWT sub claim) which Supabase exposes automatically at the PostgREST layer. Inside an Edge Function using service_role, that claim is NOT populated — so `actor` will resolve to `'system'` for re-auth events. **This is correct semantics:** the Edge Function IS the actor (acting on behalf of a collector but with system privileges). The `payload` jsonb of the audit row should include `collector_id` and `intended_op` so forensics can reconstruct the human actor.
- **Do NOT add a "trusted device" or "remember this device" feature.** The architecture explicitly mandates fresh re-auth per sensitive op (no trusted-device fast-path). MVP does not allow shortcuts.
- **Do NOT issue OTPs longer than 6 digits or with letters.** UX OTP Input component is 6 numeric digits with auto-advance (`ux-design-specification.md` line 1339). Diverging breaks the input UX.
- **Do NOT charge a fresh SMS per failed attempt.** A failed verify increments `attempts` on the SAME challenge row — does NOT issue a new OTP. The user can correct a typo without paying for another SMS dispatch (cost + saver UX).
- **Do NOT skip the lockout pre-check on `issue`.** A collector locked out on `(collector_id='X', intended_op='cycle_settlement')` must NOT be able to bypass the lockout by re-issuing for the same op. Fresh `issue` returns 429 if a `lockout_until > now()` row exists for that pair.
- **Do NOT bypass the resend cooldown.** 30-s cooldown applies even after Termii failure (don't let an attacker spam 100 SMS by triggering Termii errors).
- **Do NOT couple Story 1.3 to Story 6.1's sms-worker.** Re-auth dispatches synchronously via `termii-client.sendSms()`. The retry queue (sms_queue table, sms-worker drain) is for transactional receipts, not OTP. OTP is fire-once-fail-fast.

### Schema specification

```sql
-- Migration 0008 adds:

create type public.reauth_intended_op_enum as enum (
  'cycle_settlement',
  'member_delete',
  'csv_export',
  'sms_resend'
);

create type public.reauth_challenge_status_enum as enum (
  'pending', 'verified', 'failed', 'locked', 'expired'
);

create table public.reauth_challenges (
  id                       uuid primary key default gen_random_uuid(),
  collector_id             uuid not null references public.users(id) on delete restrict,
  intended_op              public.reauth_intended_op_enum not null,
  -- HMAC-SHA256 of the 6-digit OTP, hex-encoded, using the
  -- 'reauth_otp_hmac_key' Vault secret. Raw OTP NEVER stored.
  otp_hash                 text not null,
  attempts                 int not null default 0 check (attempts >= 0 and attempts <= 3),
  status                   public.reauth_challenge_status_enum not null default 'pending',
  -- Set when status transitions to 'locked' OR pre-emptively when a fresh
  -- issue arrives during a previous lockout window (carry-forward).
  lockout_until            timestamptz,
  -- Issued on successful verify. Single-use (consumed by the consumer
  -- Edge Function via _shared/reauth-check.ts atomic UPDATE).
  confirmation_token       uuid unique,
  confirmation_used        boolean not null default false,
  confirmation_expires_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  -- Invariants
  constraint reauth_challenges_lockout_consistency_chk check (
    (status = 'locked' and lockout_until is not null) or
    (status <> 'locked' and (lockout_until is null or lockout_until > created_at))
  ),
  constraint reauth_challenges_confirmation_consistency_chk check (
    (status = 'verified' and confirmation_token is not null and confirmation_expires_at is not null) or
    (status <> 'verified' and confirmation_token is null and confirmation_expires_at is null)
  ),
  constraint reauth_challenges_expires_after_created_chk check (expires_at > created_at)
);

-- Indexes
create index idx_reauth_challenges_collector_id_intended_op_created_at
  on public.reauth_challenges (collector_id, intended_op, created_at desc);

-- Partial index — confirmation_token is sparse (only set after verify)
create unique index idx_reauth_challenges_confirmation_token
  on public.reauth_challenges (confirmation_token)
  where confirmation_token is not null;

create trigger set_updated_at_reauth_challenges
  before update on public.reauth_challenges
  for each row execute function public.set_updated_at();

-- RLS
alter table public.reauth_challenges enable row level security;
alter table public.reauth_challenges force row level security;

create policy reauth_challenges_collector_select
  on public.reauth_challenges for select to authenticated
  using (collector_id = auth.uid());

create policy reauth_challenges_no_anon
  on public.reauth_challenges for all to anon
  using (false) with check (false);

revoke insert, update, delete on public.reauth_challenges from anon, authenticated;
-- service_role retains via Postgres default — Edge Function uses service-role key

-- Audit trigger extension (CREATE OR REPLACE the audit_emit() function adding
-- the reauth_challenges branches; full function body in migration 0008)
create trigger audit_reauth_challenges
  after insert or update on public.reauth_challenges
  for each row execute function public.audit_emit();

-- Vault key
do $$
declare existing_id uuid;
begin
  select id into existing_id from vault.secrets where name = 'reauth_otp_hmac_key';
  if existing_id is null then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'reauth_otp_hmac_key',
      'HMAC-SHA256 key for OTP hashing in reauth_challenges (Story 1.3)'
    );
  end if;
end;
$$;
```

### Edge Function contract specification (request / response shapes)

**Request — issue:**
```json
{
  "action": "issue",
  "intended_op": "cycle_settlement"  // or member_delete | csv_export | sms_resend
}
```

**Response — issue 200:**
```json
{
  "challenge_id": "00000000-0000-4000-8000-000000000001",
  "expires_at": "2026-04-19T10:05:23.000000Z",
  "resend_available_at": "2026-04-19T10:00:53.000000Z"
}
```

**Request — verify:**
```json
{
  "action": "verify",
  "challenge_id": "00000000-0000-4000-8000-000000000001",
  "otp": "123456"
}
```

**Response — verify 200:**
```json
{
  "confirmation_token": "00000000-0000-4000-8000-000000000099",
  "confirmation_expires_at": "2026-04-19T10:02:23.000000Z"
}
```

**Response — verify 401 (otp/invalid):**
```json
{
  "type": "https://safaricash.app/problems/otp/invalid",
  "title": "Invalid OTP",
  "status": 401,
  "detail": "The OTP submitted does not match the active challenge.",
  "instance": "https://...supabase.co/functions/v1/re-auth",
  "attempts_remaining": 2
}
```

### RFC 7807 problem types (full taxonomy)

| Symbol             | Type URI                                                        | HTTP | Used for                                                |
|--------------------|-----------------------------------------------------------------|------|---------------------------------------------------------|
| `auth/unauthenticated` | `https://safaricash.app/problems/auth/unauthenticated`      | 401  | Missing/invalid Supabase JWT                            |
| `auth/user_not_provisioned` | `.../auth/user_not_provisioned`                       | 403  | JWT valid but no `public.users` row                    |
| `request/invalid` | `.../request/invalid`                                            | 400  | Zod schema validation failed                            |
| `otp/invalid`      | `.../otp/invalid`                                              | 401  | Wrong OTP submitted (attempts++ done by handler)        |
| `otp/expired`      | `.../otp/expired`                                              | 410  | `now() > expires_at`                                   |
| `otp/already_used` | `.../otp/already_used`                                         | 409  | Status != 'pending' (verified, locked, expired, failed) |
| `otp/locked`       | `.../otp/locked`                                                | 429  | Lockout window active; `Retry-After` header set         |
| `otp/resend_too_soon` | `.../otp/resend_too_soon`                                    | 429  | Issue within 30s of previous; `Retry-After` set         |
| `otp/delivery_failed` | `.../otp/delivery_failed`                                    | 502  | Termii hard failure after retries                       |
| `confirmation/invalid` | `.../confirmation/invalid`                                  | 403  | Consumer-side: token expired/used/wrong                 |
| `internal/unexpected` | `.../internal/unexpected`                                    | 500  | Uncaught exception; full stack in logs                  |

### Latest tech information (verify at implementation time)

- **Supabase Edge Functions runtime (Deno):** uses Deno 1.x (likely 1.45+) with TypeScript native. Verify the exact runtime version against the Supabase CLI 2.92.x at story start (`supabase --version`) and document. The handler pattern is `Deno.serve(async (req) => Response)`. Imports from `_shared/` use relative paths (`../_shared/auth-check.ts`); no JSR / npm-import gymnastics required.
- **Termii API:** verify the current Transactional SMS endpoint URL + auth scheme at `https://developer.termii.com/`. As of architecture authoring it was `POST /api/sms/send` with Bearer auth. Confirm at implementation; if changed, update `_shared/termii-client.ts` and document in Dev Agent Record.
- **`supabase functions serve` for local testing:** the CLI 2.92 supports `--no-verify-jwt` to skip JWT validation for tests. For production deploy, JWT verification is mandatory.
- **Deno `crypto.subtle.timingSafeEqual`:** verify availability — if missing, fall back to a manual XOR-fold equality check (constant-time over byte length).

### Risks & mitigations

- **Risk — Termii sandbox costs / quota blow-up during CI runs.** Mitigation: CI uses a mock Termii server (Task 11), not the real Termii sandbox. Real Termii hits only happen during dev-local testing (operator-controlled).
- **Risk — Vault HMAC key rotation.** ADR-001 mandates quarterly review. Rotating `reauth_otp_hmac_key` invalidates ALL pending challenges (the new HMAC won't match old hashes). Mitigation: rotate during a known low-activity window; pending challenges (max 5 min old) self-expire shortly after rotation. Document in ADR-001 § Key rotation procedure (extend with a `reauth_otp_hmac_key` line).
- **Risk — Race condition on attempts++.** Two concurrent verify requests on the same challenge could both read attempts=2 and both increment to 3. Mitigation: the UPDATE uses `attempts = attempts + 1` (atomic on the row) inside a single statement; the lockout decision uses the RETURNING value, not a re-SELECT. PostgreSQL row-level locking serializes concurrent UPDATEs on the same row.
- **Risk — Cross-collector challenge enumeration via timing.** A 404 for non-existent and a 404 for wrong-collector should take comparable time. Mitigation: for "wrong collector" path, perform a dummy HMAC compare so the response time matches the wrong-OTP path. Document the constant-time intent in Task 5 implementation comments.
- **Risk — Replay attack on confirmation_token.** A network sniffer could replay a captured `confirmation_token` to consume a valid sensitive op. Mitigation: HTTPS-only (NFR-S2 TLS 1.2+); confirmation_token is single-use (atomic UPDATE-RETURNING); confirmation_token expires in 2 minutes. The threat reduces to a 2-minute MITM window which TLS protects against.
- **Risk — Termii rate-limits SafariCash account.** Mitigation: per-collector resend cooldown (30s) + per-collector lockout (3 attempts) bound the Termii dispatch rate. Story 1.4's middleware adds the upstream 100-req/min cap.

### Project Structure Notes

- **Alignment with unified project structure:** full alignment per `architecture.md § Project Structure & Boundaries`:
  - `supabase/functions/re-auth/index.ts` ✓
  - `supabase/functions/_shared/{auth-check,audit-emit,rfc7807,termii-client,reauth-check,test-utils,constants}.ts` — Story 1.3 creates the shared utilities (architecture line 817-821 names auth-check, audit-emit, rfc7807, termii-client; reauth-check, test-utils, constants are this story's natural extensions).
  - `src/lib/constants.ts` — first story to need this file
  - `src/i18n/{fr.json,keys.ts,useT.ts}` — first story to populate i18n; minimal scaffolding only (full machinery in Story 1.5+)
- **Detected variances:** none. The architecture's "audit-emit.ts" shared utility may not be needed at all if Story 1.3 routes audit emission through the trigger extension (cleaner). Document the choice in Dev Agent Record.
- **Migration numbering:** Story 1.2 used 0001-0007. Story 1.3 uses `20260419000008_reauth_challenges.sql`. Future stories continue the sequence.

### Previous-story intelligence (Story 1.2)

- **Audit chain integrity:** Story 1.2's `audit_emit()` trigger uses `clock_timestamp()` (not `now()`), per-collector `pg_advisory_xact_lock`, and `canonical_jsonb()` for SQL ↔ TS hash parity. Story 1.3's extension to `audit_emit()` MUST preserve all three properties. The `cycle.settled` status-aware mapping pattern Story 1.2 added is the template for the `reauth.*` mappings.
- **`vault_decrypt` is REVOKEd from `authenticated`.** Story 1.3's Edge Function uses `service_role` so it can call `vault_decrypt` on the `reauth_otp_hmac_key` secret to compute HMACs. Authenticated callers cannot retrieve the HMAC key directly.
- **Audit event_type CHECK regex:** Story 1.2 added `^[a-z][a-z_]*\.[a-z][a-z_]*$`. Story 1.3's new event types (`reauth.requested`, etc.) match. Verify before deploy.
- **Anon-deny policies are explicit.** Migration 0008 must add `reauth_challenges_no_anon` policy following the Story 1.2 review-patches pattern.
- **Length CHECKs on `audit_log.entry_hash` / `prev_hash`:** Story 1.2 added 32-byte CHECKs. The trigger's `audit_emit()` produces 32-byte SHA-256 outputs; Story 1.3's new event types continue to flow through the same trigger so the constraint is automatically respected.
- **Conventional commits + bisectability:** Story 1.1 / 1.2 established one-commit-per-logical-change. Story 1.3 should follow: 1 commit for the migration, 1 per shared util, 1 for the handler, 1 for the tests, 1 for i18n + constants.

### Testing standards for this story

- **Edge Function unit tests** via `deno test` (Task 9, 10): cover the 8 scenarios in Task 10. Use a mock Termii server (test-utils helper) — never hit real Termii during tests.
- **Playwright E2E** (Task 11): one happy-path full HTTP round-trip against local Supabase; mutation-test verification (Task 11 last subtask) must be performed and documented in the PR.
- **Integration with Story 1.2 contract test:** the SQL ↔ TS hash chain contract test continues to pass — Story 1.3 adds new audit event types but the trigger's serialization recipe is unchanged. If the contract test fails after migration 0008, something diverged in the trigger function rewrite — stop and reconcile.
- **CI coverage:** `.github/workflows/ci.yml` (Story 1.1 + 1.2 patches) already runs lint/typecheck/test/build/playwright. Add a `test:edge` step (Task 9) after `supabase start`. The mock-Termii server is started by the test fixture, not as a separate workflow step.
- **No frontend tests in this story.** The OTP modal + UI flow lives in consumer stories (2.6, 7.4, 9.3). Story 1.3 ships only the Edge Function + DB + shared utils + i18n strings + constants.
- **Coverage gate:** `src/lib/constants.ts` is constants only — no tests needed. `src/i18n/keys.ts` + `useT.ts` are minimal scaffolding — Story 1.5 owns full i18n test coverage.

### References

All technical details cite their source per the import-restriction rule:

- Edge Function path + behavioural intent → [Source: `_bmad-output/planning-artifacts/architecture.md` § Project Structure & Boundaries → `supabase/functions/re-auth/`; § Authentication & Security → Sensitive-op re-auth; § Session Lifecycle]
- Shared Edge Function utilities (`auth-check.ts`, `audit-emit.ts`, `rfc7807.ts`, `termii-client.ts`) → [Source: `architecture.md` § Project Structure → `supabase/functions/_shared/`]
- "No elevated session token" rule → [Source: `architecture.md` § Authentication & Security; § Session Lifecycle (`re-issues and verifies OTP without touching main session`)]
- Audit event naming + payload structure → [Source: `architecture.md` § Communication Patterns → Event naming + Event payload structure]
- RFC 7807 Problem Details for Edge Function errors → [Source: `architecture.md` § Communication Patterns]
- Wire JSON snake_case + ISO 8601 UTC timestamps → [Source: `architecture.md` § Implementation Patterns → Naming Patterns]
- Lockout numerics (3 attempts / 5 min) + 30s resend cooldown → [Source: `_bmad-output/planning-artifacts/epics.md` Story 1.3 line 486; UX `ux-design-specification.md` line 909 (Flow 5 login parity)]
- Sensitive operations classification (settlement, bulk delete, export) → [Source: `_bmad-output/planning-artifacts/prd.md` § FR5; UX `ux-design-specification.md` line 63]
- NFR-S4 session TTL + re-auth on sensitive ops → [Source: `prd.md` § Non-Functional Requirements → NFR-S4]
- NFR-S2 TLS 1.2+ → [Source: `prd.md` § NFR-S2]
- NFR-R4 SMS retry policy (NOT applied to OTP — fire-once-fail-fast for re-auth) → [Source: `prd.md` § NFR-R4]
- Termii integration → [Source: `prd.md` § Domain Requirements; UX line 875]
- Founder support phone for lockout escalation → [Source: `prd.md` line 640]
- French copy templates + reassuring header *"nous vérifions que c'est bien vous"* → [Source: `ux-design-specification.md` lines 200, 1395]
- OTP Input component (6-digit, auto-advance) → [Source: `ux-design-specification.md` lines 963, 1247, 1339]
- Story 1.2 hash chain contract → [Source: `_bmad-output/implementation-artifacts/1-2-supabase-foundation.md` AC #6, ADR-001]
- Story 1.5 (login) reuses constants → [Source: `epics.md` Story 1.5 lines 504-525, lockout numerics line 523]
- Consumer Story 2.6 (member delete) → [Source: `epics.md` Story 2.6 lines 671-690]
- Consumer Story 7.4 (settlement) → [Source: `epics.md` Story 7.4 lines 1133-1149]
- Consumer Story 9.3 (CSV export) → [Source: `epics.md` Story 9.3 lines 1300-1315]
- Architecture cross-cutting rule "every destructive op → re-auth OTP gate" → [Source: `architecture.md` line 427]

## Dev Agent Record

### Agent Model Used

*(to be filled by the dev agent upon implementation start)*

### Debug Log References

### Completion Notes List

### File List
