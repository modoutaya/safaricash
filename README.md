# SafariCash

SafariCash is a mobile-first PWA that turns the daily collector–saver tontine ritual into a calm, fast, trustworthy experience. Built for collector phones first; the saver receives SMS-anchored receipts and a public read-only receipt URL.

**Status:** Phase 4 implementation in progress — EPIC-1 Story 1.1 (project bootstrap) complete.

## Quickstart

```bash
nvm use            # picks up .nvmrc (Node 22 LTS)
npm install        # install deps
cp .env.example .env.local  # populate local env (Supabase wiring lands in Story 1.2)
npm run dev        # vite dev server on http://localhost:5173
```

## Scripts

| Script                                    | Purpose                                       |
| ----------------------------------------- | --------------------------------------------- |
| `npm run dev`                             | Vite dev server with HMR                      |
| `npm run build`                           | Type-check + production build (emits `dist/`) |
| `npm run preview`                         | Preview the production build locally          |
| `npm run test`                            | Vitest unit + component tests (single run)    |
| `npm run test:watch`                      | Vitest in watch mode                          |
| `npm run test:e2e`                        | Playwright end-to-end tests                   |
| `npm run lint`                            | ESLint over `.ts` / `.tsx`                    |
| `npm run typecheck`                       | TypeScript strict check (`tsc --noEmit`)      |
| `npm run format`                          | Prettier write across the repo                |
| `npm run provision-collector -- <args>`   | Create a pre-provisioned collector (founder)  |
| `npm run reset-collector-password -- <a>` | Reset an existing collector's password        |

## Stack

- **Frontend:** React 18 + TypeScript 5 + Vite 5 + Tailwind 3 + shadcn/ui + Radix
- **PWA:** vite-plugin-pwa (service worker + manifest)
- **State:** TanStack Query (server) + React Context (client)
- **Forms:** react-hook-form + zod
- **Animation:** framer-motion (purposeful only)
- **Routing:** react-router-dom v7
- **Backend (Story 1.2+):** Supabase (Postgres + Auth + Edge Functions + Vault)
- **Auth (PRD v1.3, Story 1.5b):** Supabase phone + password (`signInWithPassword`). Pre-provisioned collectors only — the founder creates accounts via `npm run provision-collector` and communicates the default password out-of-band (WhatsApp / call). See § Operator runbook — collector provisioning.
- **Hosting:** Cloudflare Pages (frontend) + Cloudflare Workers (rate-limit middleware front of Supabase Edge Functions; receipt URL)
- **Testing:** Vitest + Testing Library + Playwright + axe-core

## Documentation

| Document                                                     | What it is                                  |
| ------------------------------------------------------------ | ------------------------------------------- |
| `_bmad-output/planning-artifacts/prd.md`                     | Product Requirements Document               |
| `_bmad-output/planning-artifacts/ux-design-specification.md` | UX spec + design tokens + flows             |
| `_bmad-output/planning-artifacts/architecture.md`            | Architecture, project structure, decisions  |
| `_bmad-output/planning-artifacts/epics.md`                   | Epic + story breakdown                      |
| `_bmad-output/implementation-artifacts/sprint-status.yaml`   | Live sprint status                          |
| `docs/ADR/`                                                  | Architecture Decision Records (lightweight) |
| `CLAUDE.md`                                                  | AI-agent operating notes (placeholder)      |

## Conventions

- **Tokens, not hex.** Brand colours live in `tailwind.config.ts`; an ESLint rule blocks hard-coded SafariCash hex codes in component code.
- **Strict TypeScript.** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `strict` — all on.
- **Layering.** `domain/` (pure) ← `infrastructure/` ← `features/` ← `components/`. Cross-feature imports must go through the feature's `index.ts` (enforced by ESLint).
- **Locale.** App is French-first (NFR-L1). Strings live under `src/i18n/fr.json` (Story 1.5 onward).

## Session policy (NFR-S4)

SafariCash enforces a **30-minute idle timeout** and a **30-day absolute session lifetime** per NFR-S4. Both halves are dual-enforced:

- **Idle (30 min)** — client-side only. `src/features/auth/api/useIdleTimeout.ts` arms a wall-clock `setTimeout` on sign-in and resets it on `mousedown` / `keydown` / `touchstart` / `scroll` (debounced at 1 s). On expiry the hook calls `supabase.auth.signOut()`; the existing `AuthStateListener` (Story 1.5) catches the resulting `SIGNED_OUT` event, fires the toast _"Session expirée, reconnectez-vous"_, and redirects to `/login`.
- **Absolute lifetime (30 days)** — dual-enforced. A client-side guard in `useIdleTimeout` persists `sc_session_started_at` (ISO 8601) to `localStorage` on `SIGNED_IN` and signs the user out if `Date.now() - parsed >= 30 days` at any mount or idle-timer fire. The Supabase Auth project config is the authoritative enforcement — the client guard is defense in depth in case the dashboard drifts.

### Operator runbook — Supabase Auth configuration

To align the server side with NFR-S4, verify (in the Supabase dashboard → **Auth** → **Settings**):

1. **JWT expiry time** — set to ≤ `3600` s (1 h). This is the access-token lifetime; Supabase auto-refreshes within this window when `autoRefreshToken: true` (already configured in `src/infrastructure/supabase/client.ts`).
2. **Refresh token rotation** — enabled. Prevents replay of a stolen refresh token across devices.
3. **Refresh token absolute expiry** — set to `2592000` s (30 days). This caps the total session lifetime at 30 days regardless of activity, matching the client-side `localStorage` guard.
4. Verify with `supabase projects config get --ref <project>` after saving.

The exact field names in the Supabase dashboard evolve between versions; if they differ, cross-reference the current [Supabase Auth config docs](https://supabase.com/docs/guides/auth) and update this runbook with the observed names.

The earliest expiry wins: a misconfigured dashboard (e.g., 90-day refresh token) would silently violate NFR-S4, but the client guard fails closed at 30 days regardless.

See `_bmad-output/planning-artifacts/prd.md` § NFR-S4 and `_bmad-output/implementation-artifacts/1-6-session-management.md` for the full spec.

## Operator runbook — collector provisioning (Story 1.5b)

The MVP auth model is **invite-only, pre-provisioned**: the founder creates each collector account and communicates the default password out-of-band (WhatsApp or phone call). There is no self-service sign-up and no self-service password reset at MVP.

### Onboard a new collector

```bash
# Replace <phone> and <password> below. Use a generated password
# (e.g., `openssl rand -base64 12`) rather than anything guessable.
npm run provision-collector -- --phone +221771234567 --password '<defaultPassword>'
```

`public.users` is minimal at MVP — only `id`, `phone_number`, `role`, `created_at`, `updated_at`. The collector's display name is tracked out-of-band by the founder (pilot-scale bookkeeping). Add a migration + `--name` flag if a server-side display name becomes necessary.

The script:

1. Calls `supabase.auth.admin.createUser({ phone, password, phone_confirm: true })`.
2. Inserts the matching `public.users` row with `role = 'collector'`.
3. Prints the credentials for the founder to forward to the collector.

After running, copy-paste the credentials into WhatsApp / call the collector. The collector signs in on `/login` with the phone + password.

### Reset a forgotten password

```bash
npm run reset-collector-password -- --phone +221771234567 --password '<newDefaultPassword>'
```

The script calls `supabase.auth.admin.updateUserById`. Communicate the new password out-of-band.

### Required env vars (`.env.local`)

Both scripts need the service-role key, which bypasses RLS and can read / mutate any row:

```ini
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...        # dashboard → Project Settings → API
```

### Security — service-role key handling

- **Never commit `.env.local`.** It is git-ignored; keep it that way.
- **Rotate the service-role key immediately** if either of the following happens:
  - The founder's laptop is lost or stolen.
  - The laptop disk is ever unencrypted (macOS FileVault OFF / Linux without LUKS).
- Rotate via Supabase dashboard → Project Settings → API → Reset service_role. Update `.env.local` with the new value.

At MVP scale (one founder, ≤ 10 pilot collectors) this ops posture is accepted. Revisit when a second operator joins or when founder-admin moves to a hosted tool (Retool, custom back-office — OQ7).

### Auth SMS Hook (disabled in v1.3)

SafariCash's Story 1.5 login used a Supabase Auth "Send SMS Hook" → Termii pipeline to deliver OTPs. Story 1.5b decommissioned that path because Termii's business-KYC requirement blocked a solo founder from activating the gateway. The hook + its Edge Function are gone from the repo; if Termii KYC ever clears and re-enabling OTP becomes desirable, re-add both via a new story. Meanwhile, ensure the **Supabase Dashboard → Auth → Hooks → Send SMS Hook** entry is disabled (toggle off or delete the URL) so that stray `signInWithOtp` calls don't try to reach a deleted endpoint.
