---
stepsCompleted:
  - step-01-init
  - step-02-context
  - step-03-starter
  - step-04-decisions
  - step-05-patterns
  - step-06-structure
  - step-07-validation
  - step-08-complete
status: 'complete'
completedAt: '2026-04-19'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
  - _bmad-output/planning-artifacts/00-project-brief-source.md
  - _bmad-output/planning-artifacts/01-business-analysis.md
  - _bmad-output/planning-artifacts/02-pm-handoff.md
  - _bmad-output/planning-artifacts/03-mockups.html
  - _bmad-output/planning-artifacts/prd-validation-report-2026-04-18.md
  - docs/project-brief.md
workflowType: 'architecture'
project_name: 'SafariCash'
user_name: 'Mamadou'
date: '2026-04-19'
---

# Architecture Decision Document — SafariCash

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements (50 total, PRD v1.2):**

Organised in 8 capability areas, each with distinct architectural implications:

| Capability area | FR count | Key architectural implication |
|---|---|---|
| Collector Authentication & Session | 6 (FR1, 3–6) | Supabase Auth with phone-OTP provider; pre-provisioned accounts (no sign-up); SMS-OTP re-auth on sensitive operations; 30-min idle / 30-day absolute session TTL |
| Member Lifecycle | 8 (FR7–14) | Standard CRUD against Postgres with RLS; opt-in device contacts access (client-only, no server transit); typed-confirmation guard at service layer |
| Cycle Management | 7 (FR15–21) | **Pure domain layer** — cycle engine isolated from infrastructure; server-side state transitions; monotonic day-N computation from cycle start date |
| Transaction Capture | 5 (FR22–26) | Write path must tolerate offline + reconcile deterministically; pre-commit simulation is client-side (no RTT); commit path is idempotent |
| Saver Trust Communications | 8 (FR27–33b) | Async SMS via Termii as **durable commitment** (queue table, retry worker, progressive state exposed to UI); tokenised receipt URL (no auth, public single-resource) |
| Visibility & Reporting | 6 (FR34–39) | Read-model projections; CSV export at MVP (PDF Growth); dashboard queries optimised via indexed materialised views if needed at scale |
| Offline Operation | 4 (FR40–43) | **Event-sourced client** with IndexedDB log; monotonic replay on reconnect; connectivity indicator as live UI contract |
| Security, Audit & Data Protection | 6 (FR44–49) | Append-only audit log (hash-chained); column-level AES-256-GCM on PII; RLS per-collector tenancy; saver PII anonymisation on right-to-deletion |

**Non-Functional Requirements (41 total):**

Grouped by architectural domain:

- **Performance (7 NFRs):** tight budgets (p95 ≤ 5 s transaction, ≤ 300 ms search at 150 members, ≤ 16 ms client-side simulation, ≤ 60 s SMS delivery p95, ≤ 2.5 s FMP on 3G). Achievable with the proposed stack but requires disciplined budget enforcement per screen.
- **Reliability (7 NFRs):** 99.5 % availability MVP → 99.9 % at scale; RPO ≤ 1 h / RTO ≤ 4 h MVP; offline 24 h MVP → 7 d Growth; **zero-tolerance cycle-settlement correctness**. Drives event-sourced design + hash-chained audit + PITR-enabled Postgres.
- **Security (12 NFRs):** column-level encryption, TLS 1.2+, RLS isolation with automated test gate, hash-chained audit, 10-year retention on audit records, 2-year on saver PII via anonymisation, rate limiting, annual third-party pentest, tracker-not-mover language compliance. Substantial but standard fintech-lite security posture.
- **Scalability (5 NFRs):** 50 concurrent collectors MVP → 500 at Growth → ~2 000 architectural ceiling; ~75 000 transactions/day at Growth with diurnal 3× peaks; ~120 M audit events over 10-year retention. Supabase + Postgres carries this comfortably with proper indexing and optional read replicas.
- **Accessibility (6 NFRs):** WCAG 2.1 AA, 44 px touch targets, colour-agnostic status, prefers-reduced-motion — mostly front-end concerns but require a11y-tested CI pipeline (axe-core + Jest).
- **Localisation (5 NFRs):** French-only MVP with i18n-ready architecture. Standard practice, no infrastructure impact.

**Scale & Complexity:**

- Primary domain: **mobile-first PWA + serverless backend + messaging pipeline**.
- Complexity level: **medium-high** — driven by offline sync correctness, cycle engine zero-tolerance, and multi-tenant RLS at 500-collector scale.
- Estimated architectural components: ~8–10 high-level modules (PWA shell + domain engine + sync service + auth + SMS pipeline + receipt URL service + audit log + admin provisioning tool).

### Technical Constraints & Dependencies

**Stack direction inherited from PRD (non-negotiable at MVP):**

- **Frontend:** React 18 + TypeScript + Vite PWA Plugin + Tailwind CSS + Framer Motion.
- **Component layer:** shadcn/ui (copy-paste) + Radix UI primitives.
- **Backend:** Supabase (Postgres + Auth + Storage + Edge Functions if needed).
- **SMS gateway:** Termii primary, Twilio fallback (NFR-R4).
- **Offline storage:** IndexedDB client-side.

**Stack direction — closed during this step (was open):**

- **Frontend hosting:** **Cloudflare Pages + Cloudflare Workers** for the public receipt URL surface. Primary driver: generous free tier and low cost at Growth scale (unlimited bandwidth, 100k Worker requests / day free). Secondary driver: edge PoPs in WAEMU (Accra, Lagos) for better RTT.
- **Backend hosting:** **Supabase cloud-managed, eu-west-3 (Paris) region**. RTT WAEMU → Paris ~ 60–80 ms, well within NFR-P1 budgets. Self-hosted Supabase on Scaleway Paris remains a migration option if UEMOA regulatory constraints tighten (tracked as future option, not MVP path).

**Stack direction still open (deferred):**

- **Admin provisioning tool (OQ7):** to evaluate in Step 3 (starter / stack choice). Three candidates: Supabase Studio, Retool, custom mini back-office.
- **WhatsApp Business API provisioning:** deferred to Growth; not MVP.

**Hard product constraints:**

- **Tracker-not-mover** — the architecture must NOT facilitate fund movement. This simplifies the compliance surface (no PCI DSS, no AML transactional) but requires explicit language discipline in code and comms.
- **Pre-provisioned accounts only** — no self-service sign-up surface. Removes an entire class of onboarding complexity and attack surface.
- **SMS primary, WhatsApp secondary** — feature-phone savers are first-class users. Receipt URL must render on any browser without JS dependency.
- **24-month native transition target** — architecture should preserve portability. React + Tailwind assets should port to React Native or Capacitor without a ground-up rewrite.

**Architecture topology (at this level of analysis — detailed in downstream steps):**

- **Cloudflare** serves PWA assets + receipt URL page (edge compute via Workers for the public surface).
- **Supabase (Paris)** hosts Postgres DB, Auth, Edge Functions (if needed), Storage.
- **Termii** is called from Supabase Edge Functions (or a dedicated Worker) for SMS delivery.
- Each layer migrates independently (Cloudflare ↔ Vercel, Supabase cloud ↔ self-hosted, Termii ↔ Twilio).

### Cross-Cutting Concerns Identified

Ten concerns that will surface in most architectural decisions. Each is flagged here for reference — we resolve each in dedicated steps downstream.

1. **Tenant isolation** — Supabase RLS as default; per-collector data boundary enforced at the DB layer; automated security tests gate releases (NFR-S5).
2. **Audit trail** — every state-mutating operation produces a hash-chained, append-only event. Chain verifiable offline. 10-year retention (NFR-S6, S7).
3. **Offline-first with deterministic sync** — event sourcing on the client (IndexedDB log), monotonic replay on the server; conflict resolution rare-to-impossible in single-writer-per-collector MVP; explicit conflict UI reserved for future multi-collector scope.
4. **Durable SMS delivery** — queue + retry with exponential backoff; receipt modelled as a commitment (retryable, auditable, status-exposed) rather than fire-and-forget (NFR-R4, FR27).
5. **Cycle engine correctness** — domain layer isolated from infrastructure; pure-function settlement computation; property-based testing for cycle state machine (NFR-R3, FR15–21).
6. **Session & re-auth** — SMS OTP re-auth at sensitive operations (FR5); session TTL 30-min idle / 30-day absolute (NFR-S4); lockout + rate-limiting at auth layer (NFR-S9).
7. **Observability** — structured logging, metrics, traces to enforce NFR-P1/P4/P6 budgets and NFR-R3 correctness in production.
8. **Secret management** — Termii keys, Supabase service key, WhatsApp tokens — environment-scoped, rotatable, never in client bundle.
9. **Column-level encryption** — AES-256-GCM on phone, amount, member name (NFR-S1); keys sourced from Supabase Vault or equivalent.
10. **Retention & anonymisation** — tiered policy: 10-year audit + transactions (anonymisable), 2-year saver PII post-cycle; deletion request triggers anonymisation (FR48) not hard delete.

### Regulatory & Compliance Posture

Already extensively scoped in PRD; architecture must enforce:

- UEMOA data protection (consent at first receipt, right-to-deletion via anonymisation).
- OHADA commercial record retention (10-year audit trail).
- Tracker-not-mover language in saver-facing comms (SMS body + receipt URL content).
- No PCI DSS, no transactional AML, no open-banking, no crypto — explicitly out of scope.

Counsel-level validation of retention durations is tracked as R-R2 / OQ2 — architecture commits to the current hypothesis and is designed to allow adjustment (retention policy is a configuration value, not a hard-coded constant).

## Starter Template Evaluation

### Primary Technology Domain

**Mobile-first PWA frontend + serverless backend.** Identified from PRD Project Classification (mobile_app / fintech / high / greenfield) and reaffirmed in UX Platform Strategy (Vite PWA at MVP, native transition at 24 months).

### Starter Options Considered

Four categories of starter were evaluated:

1. **Official Vite + layered ecosystem setup** — `create-vite` with the `react-ts` template, then progressive layering of Tailwind, Vite PWA Plugin, shadcn/ui, Supabase client.
2. **Full-stack meta-starters** (T3, RedwoodJS, Blitz) — rejected: Next.js-based, opinionated stacks incompatible with our Vite-PWA-first posture and our "own-the-components" philosophy.
3. **Supabase + Next.js starter** — rejected: Next.js is not in our stack; Vite is.
4. **Community templates** bundling Vite + React + Tailwind + Supabase — rejected: single-maintainer risk, rapid obsolescence, often bundle opinions (Zustand, form libs, etc.) we haven't chosen.

### Selected Starter: `create-vite` + Layered Manual Setup

**Rationale for Selection:**

- Encodes exactly the PRD-specified stack (Vite + React 18 + TypeScript), no additional opinions.
- Each additional layer (Tailwind, PWA, shadcn/ui, Supabase) is added via its own official integration path, giving full control and upgrade independence.
- Maintenance surface is distributed across first-party maintainers (Vite team, Tailwind team, Radix/shadcn team, Supabase team) — no single-maintainer-risk template.
- Preserves portability toward React Native / Capacitor native transition at 24 months.
- Aligns with UX spec Design System Foundation (shadcn/ui copy-paste philosophy).

**Version note:** the exact major versions below reflect the ecosystem state as of PRD authoring (early 2026). Verify current versions at bootstrap time via `npm init` and each package's official install guide. Architecturally, we commit to **major versions**, not point releases.

### Initialization Command Sequence

Bootstrapping is a linear sequence — each step is an explicit commit in git, enabling bisection if a later step introduces regressions.

```bash
# 1. Base Vite + React + TypeScript project
npm create vite@latest safaricash -- --template react-ts
cd safaricash
npm install

# 2. Tailwind CSS (utility-first styling per UX Visual Foundation)
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
# Configure tailwind.config.ts with SafariCash palette (see UX Visual Foundation § Color System)

# 3. Vite PWA Plugin (installable PWA per PRD Mobile App Specific Requirements)
npm install -D vite-plugin-pwa
# Configure vite.config.ts with manifest (name, icons, theme_color #1D9E75, offline strategy)

# 4. shadcn/ui initialisation (component scaffolds per UX Design System Foundation)
npx shadcn-ui@latest init
# Accept defaults; components will be copied under src/components/ui/ as we build

# 5. Radix UI primitives (transitively via shadcn/ui; explicit where needed)
# npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu ... (as components require)

# 6. Framer Motion (purposeful animation layer per UX Emotional Design Principles)
npm install framer-motion

# 7. Supabase client (data + auth gateway per PRD Technical Stack)
npm install @supabase/supabase-js

# 8. React Hook Form + Zod (form validation — standard pairing, required by FR7-14)
npm install react-hook-form zod @hookform/resolvers

# 9. Sonner (toast library Radix-compatible, per UX Component Strategy § Progressive Toast)
npm install sonner

# 10. TanStack Query (server state management — standard for Supabase client integration)
npm install @tanstack/react-query

# 11. Vitest + Testing Library (testing framework per NFR-R3 cycle engine 100% coverage gate)
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom

# 12. Playwright (end-to-end testing for critical flows per UX Testing Strategy)
npm install -D @playwright/test
npx playwright install

# 13. axe-core + jest-axe (accessibility testing per NFR-A1 CI enforcement)
npm install -D axe-core @axe-core/playwright jest-axe

# 14. ESLint + Prettier (code quality baseline)
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin \
  eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-jsx-a11y \
  prettier eslint-config-prettier

# 15. Husky + lint-staged (pre-commit enforcement of lint + test gates)
npm install -D husky lint-staged
npx husky init

# 16. React Router v7 (client-side routing)
npm install react-router-dom
# Configure in src/app/router.tsx with route definitions per UX flows
# (auth routes, main routes protected by session, /admin gated by super_admin, public /r/:token for receipt URL)
```

### Architectural Decisions Provided by This Starter Path

**Language & Runtime:**

- **TypeScript 5.x strict mode** — enforced via `tsconfig.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`. Type safety is a first-class concern for a fintech product.
- **ECMAScript 2022+** target, with Vite handling polyfills for Android 8+ / iOS 13+.

**Styling Solution:**

- **Tailwind CSS 3.x** with custom `tailwind.config.ts` encoding the SafariCash design tokens (palette, type scale, spacing, radii) per UX Visual Foundation.
- No CSS-in-JS runtime. No styled-components. All styling via Tailwind utility classes or CSS variables.

**Build Tooling:**

- **Vite 5.x+** with Rollup for production builds. Fast dev server, tree-shaking, code splitting by default.
- **Vite PWA Plugin** configures service worker, manifest, offline caching strategy (app-shell precache + stale-while-revalidate for API responses).
- Production bundles emitted as ES modules with automatic code splitting per route.

**Testing Framework:**

- **Vitest** for unit + integration tests (same engine as Vite, fast).
- **React Testing Library** for component-level tests.
- **Playwright** for end-to-end browser tests against critical flows (Flow 1 transaction, Flow 3 settlement, Flow 5 login).
- **jest-axe** / **@axe-core/playwright** for automated accessibility assertions in CI.
- Coverage target: **100 % on cycle engine domain module** (NFR-R3 gate), ≥ 80 % elsewhere.

**Routing:**

- **React Router v7** (`react-router-dom`) — the boring, well-documented, widest-example-base choice. Rejects TanStack Router's type-safety overhead at MVP scope; rejects file-based routing to keep route definitions explicit and discoverable.
- Route structure mirrors UX Journey Flows: public surfaces (receipt URL, login), collector-session-protected main app, `super_admin`-gated admin routes (Growth).

**Code Organization:**

Proposed (to refine in downstream architecture steps):

```
src/
├── app/              # Route definitions, page-level components
├── components/
│   ├── ui/           # shadcn/ui copied components (Button, Dialog, etc.)
│   └── domain/       # SafariCash-specific components (MemberActionSheet, ProgressiveToast, etc.)
├── domain/           # Pure domain logic — cycle engine, settlement math (zero infra imports)
├── features/         # Feature-grouped modules (auth, member, cycle, transaction, dispute)
├── infrastructure/   # Supabase client, Termii client, sync layer, audit log
├── lib/              # Utilities (formatters, validators, date helpers)
├── hooks/            # Reusable React hooks
├── styles/           # Tailwind config, globals
└── i18n/             # French strings keyed for future Wolof / Bambara (NFR-L2)
```

**Development Experience:**

- Hot module reload on every file save.
- TypeScript strict mode enforced at IDE + CI level.
- ESLint + Prettier + jsx-a11y enforced at pre-commit via Husky.
- Storybook deferred to a separate add-on story (optional P1 at MVP).

**What this starter path EXPLICITLY does not ship:**

- State management library (Redux, Zustand, Jotai) — TanStack Query + React Context handles MVP needs.
- Backend framework — Supabase Edge Functions (Deno) are the serverless compute tier; no Node/Express backend at MVP.
- CSS-in-JS, heavy UI libraries (MUI, Ant, Chakra) — excluded by design.

### Admin Provisioning Tool (OQ7 — resolved for MVP)

At MVP, collector accounts are pre-provisioned directly via **Supabase Studio** (the managed dashboard). The founder creates a row in the `users` table with phone, name, email (if any), and subscription plan. No custom admin UI is built for MVP. Transition path to Growth: when collector count exceeds ~20–30 (where Supabase Studio edits become tedious), migrate to an **in-app `/admin` route** gated by a `super_admin` role via Supabase RLS. This migration is a ~1–2 day dev task in Phase 2. The Retool option (SaaS low-code tool) was explicitly rejected due to SaaS lock-in and poor scaling economics.

**Note:** full closure of OQ7 for Growth transition is tracked as a separate follow-up (not blocking MVP). The PRD v1.2 OQ7 remains partially open pending Growth-phase admin UI build.

**Note:** project initialization using this command sequence is the **first implementation story** (EPIC-0 / story 0 when we get to epic breakdown). Every subsequent story assumes this foundation exists.

## Core Architectural Decisions

### Decision Priority Analysis

**Already decided (by starter template, project context, PRD, or UX spec):**

| Category | Decision | Source |
|---|---|---|
| Backend DB + Auth | Supabase cloud (eu-west-3 Paris) | Context step 2 |
| Frontend hosting | Cloudflare Pages + Workers | Context step 2 |
| Frontend framework | React 18 + TypeScript + Vite | Starter step 3 |
| Styling | Tailwind CSS 3.x + custom tokens | Starter + UX Visual Foundation |
| Components | shadcn/ui + Radix primitives | Starter + UX Design System |
| Animation | Framer Motion (purposeful only) | Starter + UX Emotional Design |
| Server state | TanStack Query | Starter step 3 |
| Client state | React Context (MVP) | Starter step 3 |
| Form / validation | React Hook Form + Zod | Starter step 3 |
| Routing | React Router v7 | Starter step 3 Q-ARCH4 |
| Testing | Vitest + RTL + Playwright + axe-core | Starter step 3 |
| Linting | ESLint + Prettier + jsx-a11y | Starter step 3 |
| Auth flow | Supabase phone-OTP, pre-provisioned | PRD v1.2 |
| SMS gateway | Termii primary | PRD Domain |
| Admin provisioning (MVP) | Supabase Studio | Starter step 3 Q-ARCH3 |

**Critical decisions (decided in this step — block implementation):**

- Supabase Vault for column-level encryption (Q-ARCH5).
- Polling 60 s over Supabase Realtime for dashboard stats; Realtime reserved for dispute notifications + pending-sync count (Q-ARCH6).
- Supabase logs only for observability at MVP; Sentry free tier deferred to Growth as a safety net (Q-ARCH7).

**Important decisions (shape architecture):**

- PostgREST auto-generated API for 80 % of CRUD; Supabase Edge Functions (Deno) for 20 % of custom logic.
- Offline-first sync architecture via custom event-sourced module under `src/infrastructure/sync/`.
- Structured audit-log table as source-of-truth for production debugging (doubles as NFR-S6 compliance surface).

**Deferred decisions (post-MVP):**

- Sentry activation (Growth trigger: first support ticket that costs > 1 h of Supabase-log archaeology).
- Self-hosted Supabase migration (trigger: UEMOA data-localisation rule change or cost inflection > ~500 collectors).
- Storybook component documentation (nice-to-have P1).
- Read replicas / materialised views (only if NFR-P2 budget breached at > 1 000 collectors).

### Data Architecture

- **Schema language:** SQL natif versionné via Supabase CLI (`supabase db diff`, `supabase db push`). No ORM at MVP — PostgREST + RLS covers CRUD, Edge Functions (Deno) write SQL directly.
- **Migrations:** Supabase migration CLI. Every schema change = timestamped migration file + upgrade / rollback test.
- **Validation:** Zod client-side (form + API response validation) + Postgres constraints server-side (NOT NULL, CHECK, FK). Two-layer defence in depth.
- **Caching:** TanStack Query client-side (stale-while-revalidate, 60 s default). **No server-side cache at MVP** — PostgREST + indexes sufficient for < 75 k txns/day (NFR-SC4).
- **Column-level encryption (Q-ARCH5 resolved):** **Supabase Vault** for saver name, saver phone, transaction amounts (NFR-S1). Key rotation managed via Vault dashboard. Rationale: lower ops overhead than `pgsodium`; Supabase-native and dashboard-managed. `pgsodium` remains a migration target if Vault's managed model becomes constraining.

**Tables (to flesh out in step 5):** `users` (collectors), `members`, `cycles`, `transactions`, `receipts`, `audit_log`, `sms_queue`, `disputes`. Each with RLS policy per-collector isolation.

### Authentication & Security

- **RBAC:** enum column `role` (`collector`, `super_admin`) on `users`. RLS policies evaluate role + collector ownership. No external RBAC library — Supabase RLS sufficient at MVP.
- **API security:** RLS is the primary auth layer. Every request passes through Supabase, which evaluates the policy set. No custom API endpoint is exposed without an RLS-equivalent check at the Edge Function boundary.
- **Rate limiting (NFR-S9):** Cloudflare Workers middleware on Edge Function endpoints (max 100 req/min/collector on write endpoints). For PostgREST direct calls, Supabase Pro's native rate-limiting covers it.
- **Secret management:** Cloudflare Workers env vars (Termii API keys, Supabase service key), Supabase dashboard env vars (WhatsApp tokens when provisioned). Frontend only sees Supabase anon key (public) + project URL. Rotation cadence: quarterly at minimum, immediate on any suspected leak.
- **Sensitive-op re-auth (FR5, NFR-S4):** dedicated Edge Function re-issues SMS OTP and validates for settlement / bulk delete / export. No "elevated session" token — every sensitive operation re-auths fresh. 30-min idle / 30-day absolute session TTL managed by Supabase Auth config.

### API & Communication Patterns

- **API style:** **PostgREST auto-generated** for 80 % of CRUD — reads (members, transactions, cycles) and most writes via direct table access protected by RLS. **Supabase Edge Functions (Deno)** for the 20 % of custom logic: cycle settlement, SMS dispatch, dispute notification, OTP re-auth, audit hash-chain append.
- **Error handling:** Edge Functions return RFC 7807 Problem Details for 4xx / 5xx. PostgREST returns its standard codes (400 / 401 / 403 / 404 / 409) — frontend translates these into named user-facing errors per UX Error Recovery Patterns.
- **Realtime (Q-ARCH6 resolved, targeted use):** Supabase Realtime subscriptions are enabled **only** for:
  - Dispute notifications to collector + founder (FR33b — the one place real-time matters).
  - Connectivity indicator pending-sync count (client-local, no WebSocket needed — just TanStack Query refresh).

  Dashboard stats use **polling 60 s via TanStack Query** (Q-ARCH6). Rationale: collector cadence is human-paced (one transaction per ~30 s at peak); 60-s lag is invisible. Avoids 500 WebSocket connections at Growth scale.

- **Communication services:** Termii via HTTP from Edge Function (no official SDK). WhatsApp Business API deferred to Growth.

### Frontend Architecture

- **Offline sync architecture (critical novel piece):** custom module `src/infrastructure/sync/` implementing:
  - **IndexedDB event log** — append-only, indexed by (collector_id, monotonic_timestamp). Every write operation (contribution, advance, rattrapage, member create/edit/delete) is an event.
  - **Outbox pattern** — mutating operations are committed to the local event log first, then pushed to Supabase via a background sync worker. UI reads from local read-model (derived from event log + cached server state).
  - **Reconciliation on reconnect** — the sync worker replays events in monotonic order to Supabase; server applies idempotently (event IDs are client-generated UUIDs + sequence numbers for dedup).
  - **Single-writer per collector** — guaranteed by the pre-provisioned model (one account = one device session). Zero conflict resolution needed at MVP. Explicit conflict UI reserved for Growth-phase multi-collector scope.
- **Service Worker strategy:** Vite PWA plugin, `generateSW` mode.
  - App shell: `precache`.
  - API responses (PostgREST GET): `NetworkFirst` with 5 s timeout, then cache fallback.
  - Static assets: `CacheFirst`.
  - Version updates: toast-gated reload, never silent.
- **Bundle optimization:** code splitting by route, lazy-loading Settings and Rapports screens, shadcn components tree-shaken, image assets in WebP + AVIF with PNG fallback.
- **State management (already decided):** TanStack Query for server state, React Context for UI state (session, connectivity, theme, modals).
- **Routing (already decided):** React Router v7 with explicit route config in `src/app/router.tsx`.

### Infrastructure & Deployment

- **CI/CD:** GitHub Actions. Pipeline on PR:
  1. Install deps (cached)
  2. Lint (`eslint`, `tsc --noEmit`)
  3. Unit tests (`vitest`, with 100 % gate on `src/domain/`)
  4. E2E tests (`playwright` on the 5 critical UX flows)
  5. Accessibility assertions (`@axe-core/playwright` across flows)
  6. Security (Supabase RLS isolation tests — NFR-S5 gate)
  7. Build + preview deploy to Cloudflare Pages (PR preview URL)

  On merge to `main`: promote preview to production deployment on Cloudflare Pages + Supabase migration apply via CLI.

- **Environment config:** `.env.local` for dev (git-ignored), Cloudflare env vars for Prod frontend (UI-managed), Supabase dashboard env vars for backend secrets. No secret in repo or Git history.
- **Branching model:** trunk-based development. `main` = production. Feature branches short-lived (< 2 days). No permanent `staging` branch — Cloudflare preview URLs per PR act as staging.
- **Backup & recovery (NFR-R5/R6/R7):** Supabase PITR (Point-in-Time Recovery) 7-day history at MVP, daily snapshot off-region via Supabase Pro. Recovery drills scheduled quarterly. RTO ≤ 4 h / RPO ≤ 1 h at MVP.
- **Observability (Q-ARCH7 resolved):** **Supabase logs + structured audit-log table as MVP baseline.**
  - Supabase dashboard provides Postgres logs, Edge Functions logs, API request logs.
  - An `audit_log` Postgres table (also serving NFR-S6 compliance, see Data Architecture) is the structured-logging source of truth for critical operations. Every production issue can be reconstructed from this table.
  - Structured JSON logs emitted by Edge Functions to Supabase stdout → queryable via dashboard.
  - **Sentry free tier deferred to Growth** as a safety net once operational pain justifies it (trigger: first incident that costs > 1 h of manual log archaeology). Free tier (5 k errors/month) is sufficient for MVP pilot scale if activated.
- **Scaling posture:**
  - MVP (50 collectors): Supabase Pro tier (~25 $/month).
  - Growth (500 collectors): still Supabase Pro; consider read replicas if dashboard NFR-P2 budget breached.
  - Scale ceiling (~2 000 collectors): evaluate Supabase Team tier or migration to self-hosted.

### Decision Impact Analysis

**Implementation sequence (what depends on what):**

1. **EPIC-0 (bootstrap):** Vite + React + TS + Tailwind + Vite PWA + shadcn/ui + Supabase client + routing. Repo skeleton. CI minimal.
2. **EPIC-1 (data model):** Supabase schema + RLS policies + audit log table + encryption setup. Automated RLS isolation tests gate.
3. **EPIC-2 (auth):** Supabase phone-OTP integration + session management + re-auth Edge Function.
4. **EPIC-3 (domain engine):** pure cycle engine module with 100 % unit + property-based test coverage (NFR-R3 gate).
5. **EPIC-4 (transaction capture):** online commit path via PostgREST + Zod + optimistic UI.
6. **EPIC-5 (offline sync):** IndexedDB event log + outbox + reconciliation worker. **Highest technical risk — allocate buffer.**
7. **EPIC-6 (SMS pipeline):** Termii integration + queue table + retry worker + Progressive Toast state contract.
8. **EPIC-7 (receipt URL):** Cloudflare Workers endpoint + receipt render + dispute flag (FR33b).
9. **EPIC-8 (UI flows):** 5 UX flows composed from components (Flow 1 → 5).
10. **EPIC-9 (observability):** audit log instrumentation + Supabase logs query playbook + PITR recovery drill.

**Cross-component dependencies (critical):**

- Every write path → audit log append (enforced via Postgres trigger or Edge Function wrapper).
- Every Edge Function → RLS-equivalent role / ownership check at entry.
- Every user-facing screen → connectivity indicator + offline-tolerant write path.
- Every destructive operation → re-auth OTP gate (FR5 implemented as a shared middleware Edge Function).
- Every saver-facing text surface (SMS body, receipt URL page) → tracker-not-mover language audit (NFR-S10).

### PRD Amendments Implicitly Triggered by This Step

None directly. All architectural decisions operate **below** PRD abstraction level. However:

- OQ4 (Supabase region) is **closed** → eu-west-3 Paris. Recommend a small PRD edit in a future amendment cycle to mark OQ4 as resolved.
- OQ7 (Admin tool) is **partially closed** → Supabase Studio at MVP, in-app `/admin` at Growth. Same treatment.

These closures will be bundled with the next `bmad-edit-prd` pass if any further amendments emerge from downstream steps.

## Implementation Patterns & Consistency Rules

**Purpose:** prevent micro-conflicts between developers, AI agents, and codebase regions. Every rule below is machine-enforceable via lint / type-check / test when possible. These are not stylistic preferences — they are **interop contracts**.

### Pattern Categories Defined

~20 areas where divergent choices would cause integration friction. Each resolved below with rationale grounded in the Supabase + React + TypeScript stack.

### Naming Patterns

**Database (Postgres / Supabase):**

| Element | Convention | Example |
|---|---|---|
| Table names | `snake_case`, plural | `members`, `transactions`, `audit_log` |
| Column names | `snake_case`, singular | `daily_amount`, `cycle_start_date`, `created_at` |
| Foreign keys | `{referenced_singular}_id` | `collector_id`, `member_id` |
| Enum types | `{table}_{field}_enum` | `members_status_enum` |
| Indexes | `idx_{table}_{columns}` | `idx_transactions_member_id_created_at` |
| Timestamps | `created_at`, `updated_at` (never `creation_date` / `dateCreated`) | — |
| Soft-delete marker | not used at MVP — deletion is hard-delete with anonymisation (FR48) | — |

**Rationale:** Supabase PostgREST exposes DB names directly. Keeping DB snake_case aligns the API surface without translation layers.

**API (PostgREST + Edge Functions):**

| Element | Convention | Example |
|---|---|---|
| PostgREST paths | Auto-generated from table names (snake_case, plural) | `/rest/v1/members?collector_id=eq.xxx` |
| Edge Function paths | `/functions/v1/{kebab-case-action}` | `/functions/v1/cycle-settlement`, `/functions/v1/sms-dispatch` |
| Query parameters | PostgREST uses its own syntax; Edge Functions use snake_case | `?collector_id=eq.xxx` / `?member_id=abc` |
| Custom headers | `X-` prefix, kebab-case | `X-Request-Id`, `X-Idempotency-Key` |
| API version | URL-embedded (`/v1/`) — already Supabase convention | — |

**Code (TypeScript / React):**

| Element | Convention | Example |
|---|---|---|
| Component files | `PascalCase.tsx` | `MemberActionSheet.tsx`, `ProgressiveToast.tsx` |
| Non-component source files | `camelCase.ts` | `syncWorker.ts`, `cycleEngine.ts`, `formatCurrency.ts` |
| Test files | co-located `.test.ts` / `.test.tsx` | `cycleEngine.test.ts` beside `cycleEngine.ts` |
| Hooks | `useXxx.ts` camelCase | `useMemberList.ts`, `useConnectivityStatus.ts` |
| Component names | `PascalCase` | `<MemberActionSheet />` |
| Functions / methods | `camelCase` verbs | `computeFinalBalance()`, `dispatchSms()` |
| Constants | `UPPER_SNAKE_CASE` | `MAX_OFFLINE_HOURS`, `OTP_LOCKOUT_MINUTES` |
| TypeScript types / interfaces | `PascalCase`, no `I` prefix | `Member`, `CycleState`, `TransactionKind` |
| Zod schemas | `PascalCaseSchema` suffix | `MemberSchema`, `TransactionSchema` |
| Enums / string union types | `PascalCase` type name, `SCREAMING_SNAKE` or lowercase values | `type CycleStatus = 'active' \| 'with_advance' \| 'completed'` |
| CSS classes (when custom) | Tailwind utilities only; rare custom classes in `kebab-case` | `.safaricash-hero-gradient` |

**Component-to-DB translation rule:**

The **boundary layer** (TanStack Query hooks in `src/features/{domain}/api/`) is the **only** place where `snake_case` ↔ `camelCase` conversion happens. A small helper (`camelize` / `decamelize`) performs this. Downstream code **never** sees snake_case. This keeps database-idiomatic naming and JS-idiomatic naming cleanly separated.

### Structure Patterns

**Project structure (authoritative — from Starter Template Evaluation):**

```
src/
├── app/              # Route definitions, page-level components (React Router)
├── components/
│   ├── ui/           # shadcn/ui copied components
│   └── domain/       # SafariCash-specific components
├── domain/           # Pure domain logic (zero infra imports)
├── features/         # Feature modules: auth, member, cycle, transaction, dispute
│   └── {feature}/
│       ├── api/      # TanStack Query hooks + camelize bridge
│       ├── ui/       # Feature-specific components
│       └── types.ts  # Feature types + Zod schemas
├── infrastructure/   # Supabase client, Termii client, sync layer, audit log
├── lib/              # Utilities (formatters, validators, date helpers)
├── hooks/            # Cross-feature hooks
├── styles/           # Tailwind config, globals
└── i18n/             # French strings + key structure for Wolof / Bambara
```

**Rule — no cross-feature imports except through public surface:**

- `features/member` imports from `features/cycle` **only** via the cycle feature's `index.ts` (explicit exports).
- `domain/` is the exception — it exports freely and imports nothing from `features/`, `infrastructure/`, or UI layers.
- Circular imports are compile errors (ESLint rule enforced).

**Test file placement:**

- Unit tests: **co-located** with source (`cycleEngine.ts` + `cycleEngine.test.ts`).
- E2E tests: `tests/e2e/*.spec.ts` (Playwright).
- Rationale: co-location surfaces test staleness faster than a separate `__tests__/` tree.

**Config file locations:**

- Tailwind: `tailwind.config.ts` at repo root.
- Vite: `vite.config.ts` at repo root.
- Supabase migrations: `supabase/migrations/`.
- CI: `.github/workflows/`.
- Environment: `.env.local` (dev, git-ignored), Cloudflare / Supabase dashboards (prod).

### Format Patterns

**API response / error formats:**

| Source | Success shape | Error shape |
|---|---|---|
| PostgREST (direct CRUD) | Raw data array / object per PostgREST defaults | PostgREST standard: `{code, details, hint, message}` |
| Edge Functions (custom) | Raw data object (no wrapper) | **RFC 7807 Problem Details**: `{type, title, status, detail, instance}` |

**Rationale:** no custom wrapper pattern (`{data: ..., error: ...}`). PostgREST already handles this cleanly; wrappers add serialisation overhead without value. Frontend consumes both formats via the TanStack Query layer which translates errors into the app's named-error contract.

**Data exchange formats:**

| Element | Rule | Example |
|---|---|---|
| JSON field naming (on the wire) | `snake_case` (matches Postgres) | `{"daily_amount": 5000, "cycle_start_date": "..."}` |
| JSON field naming (in app code, post-camelize bridge) | `camelCase` | `{dailyAmount: 5000, cycleStartDate: Date}` |
| Dates / timestamps on the wire | **ISO 8601 UTC string** | `"2026-04-19T14:32:00Z"` |
| Dates in app code | `Date` object (parsed at boundary) | — |
| Dates in UI display | French locale, 24h clock, WAT display | `19 avril 2026, 14:32` |
| Monetary amounts on the wire | **Integer in FCFA** (no decimals — FCFA has no sub-unit) | `5000` |
| Monetary amounts in UI display | Formatted per NFR-L3 | `5 000 FCFA` (non-breaking space) |
| Booleans | Native `true` / `false` (never `1`/`0`, `"yes"`/`"no"`) | — |
| Null vs absent | `null` means "known to be absent"; absent means "not provided / not applicable"; they are distinct | — |

### Communication Patterns

**Event naming (sync layer and audit log):**

Format: `{entity}.{action}` — dot-separated, lowercase, past-tense for audit events.

| Event | Fired when |
|---|---|
| `member.created` | A new member row is created |
| `member.updated` | Member name / phone / daily_amount changed |
| `member.deleted` | Member hard-deleted (with anonymisation) |
| `transaction.committed` | Contribution / advance / rattrapage written |
| `cycle.started` | New cycle initiated |
| `cycle.settled` | Cycle day-30 settlement confirmed |
| `dispute.flagged` | Saver tapped dispute CTA (FR33b) |
| `sms.queued` | SMS receipt added to `sms_queue` |
| `sms.delivered` | Termii confirmed delivery |
| `sms.failed` | Termii terminal failure |

**Event payload structure:**

```typescript
{
  eventId: string;           // UUID, client-generated, idempotency key
  eventType: string;         // "transaction.committed"
  collectorId: string;       // tenant scope
  entityId: string;          // the member/transaction/cycle ID affected
  timestamp: string;         // ISO 8601 UTC
  actor: string;             // collector_id or "system"
  source: "online" | "offline_reconciled";
  payload: Record<string, unknown>;  // event-specific
}
```

This shape is the audit-log row shape (NFR-S6 + FR44). Every write operation produces exactly one event.

**TanStack Query key convention:**

Format: `[featureDomain, operation, { filters }]` — array starts with a string, last element is an object if filters exist.

```typescript
// Good
useQuery({ queryKey: ['members', { collectorId, status: 'active' }], ... })
useQuery({ queryKey: ['cycle', memberId], ... })
useQuery({ queryKey: ['transactions', memberId, { cycleNumber: 3 }], ... })

// Bad
useQuery({ queryKey: ['getMembers'], ... })          // no action prefix
useQuery({ queryKey: [`members-${collectorId}`], ... })  // don't concatenate
```

**State update patterns:**

- Always immutable updates in React Context / TanStack Query.
- Never mutate objects returned by TanStack Query (they're frozen in dev mode).
- Optimistic updates via TanStack Query's `onMutate` + rollback on error — required for offline transaction path (Flow 1).

### Process Patterns

**Error handling:**

| Layer | Strategy |
|---|---|
| Global | React Error Boundary at app root catches render errors; logs to audit_log table; shows user-friendly fallback |
| Per-feature | Feature-level Error Boundary for isolated failures (e.g., dashboard stats can fail without crashing member list) |
| TanStack Query | `onError` defined per hook; retries automatic for network errors (3× exponential backoff); never silent |
| Edge Functions | Always return RFC 7807 Problem Details; log full stack to Supabase stdout |
| User-facing errors | **Named per UX Error Recovery Patterns** — never *"Something went wrong"*. Template: `{action} échouée — {cause}` |

**Loading states:**

- **Always named**, never a bare spinner (NFR-A1).
- TanStack Query's `isLoading` (first load) vs `isFetching` (refetch) are distinct — use `isLoading` for initial skeletons, `isFetching` for subtle top-of-screen progress.
- **Skeleton loaders** for content with known structure (member list, member profile).
- **Global loading state** avoided — prefer per-region skeletons.

**Retry strategies:**

| Operation | Retry policy |
|---|---|
| Network GETs (PostgREST reads) | 3× automatic (TanStack Query default), exponential backoff |
| Transaction writes (idempotent via event ID) | Automatic on network recovery; user can manually retry via toast action after `NFR-P7` threshold |
| SMS dispatch (Termii) | Exponential backoff 10 s → max 10 min; abandon after 24 h; surfaced in Progressive Toast (NFR-R4) |
| OTP verification | 3 attempts then 5-min lockout (Flow 5) |

**Validation:**

- **Zod schema defined once**, reused on client form + API response validation.
- Schemas live in `features/{domain}/types.ts`.
- **Client-side validation on blur** + **server-side validation via Postgres constraints** + **Edge Function Zod re-validation** for any Edge-Function-mediated write. Defence in depth.

**Session / auth:**

- Supabase Auth session stored in localStorage (Supabase default) + refreshed automatically.
- 30-min idle → Supabase emits `SIGNED_OUT`; our app handler redirects to Flow 5 login with a toast (*"Session expirée, reconnectez-vous"*).
- Sensitive ops re-auth via Edge Function `/re-auth` that re-issues and verifies OTP without touching main session — does NOT extend main session.

**Logging conventions:**

All Edge Functions log **structured JSON** to stdout (picked up by Supabase logs):

```typescript
console.log(JSON.stringify({
  level: 'info' | 'warn' | 'error',
  event: 'sms.dispatched' | 'cycle.settled' | ...,
  collector_id: string,
  entity_id: string,
  duration_ms: number,
  error?: { name, message, stack },
  // ...event-specific context
}));
```

Never log PII (saver names, phone numbers) in plaintext — log the collector_id and hashed saver reference only.

### Enforcement Guidelines

**Automated (CI gate — failure blocks merge):**

- ESLint rules for naming (component = PascalCase, hooks = `use` prefix, no default exports from feature index files, etc.).
- `eslint-plugin-jsx-a11y` for accessibility patterns.
- TypeScript strict mode with `noUncheckedIndexedAccess`.
- Import restriction rule: no cross-feature imports except via public `index.ts`.
- Test coverage gate: 100 % on `src/domain/`, ≥ 80 % elsewhere.
- axe-core assertions pass on every screen snapshot.

**Semi-automated (PR checklist):**

- Zod schema present for every form and every Edge Function response.
- Audit log event emitted for every state-mutating operation.
- Re-auth gate present on every sensitive operation (settlement, bulk delete, export).

**Manual (code review — caught in PR):**

- Copy follows UX Consistency Patterns § Feedback / Error tone.
- No `console.log` left in committed code (ESLint also catches).
- No marketing / instructional language in saver-facing text (NFR-S10).

### Pattern Examples

**Good — a well-formed feature hook:**

```typescript
// src/features/member/api/useMembers.ts
export const useMembers = (filters?: MemberFilters) => {
  return useQuery({
    queryKey: ['members', filters],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('members')
        .select('*')
        .match(filters ?? {});
      if (error) throw error;
      return camelize(data) as Member[];
    },
  });
};
```

**Good — a well-formed event emission:**

```typescript
// src/infrastructure/audit/emit.ts
await supabase.from('audit_log').insert({
  event_id: crypto.randomUUID(),
  event_type: 'transaction.committed',
  collector_id: session.user.id,
  entity_id: transaction.id,
  timestamp: new Date().toISOString(),
  actor: session.user.id,
  source: isOffline ? 'offline_reconciled' : 'online',
  payload: { amount: transaction.amount, kind: transaction.kind },
});
```

**Anti-pattern — cross-feature direct import:**

```typescript
// ❌ features/member/ui/MemberCard.tsx
import { computeCycleBalance } from '../../cycle/api/cycleApi';  // private import

// ✅ Correct
import { computeCycleBalance } from '../../cycle';  // via public index.ts
```

**Anti-pattern — silent error swallow:**

```typescript
// ❌
try {
  await dispatchSms(receipt);
} catch {
  // swallow — looks fine
}

// ✅
try {
  await dispatchSms(receipt);
} catch (error) {
  await emitAuditEvent('sms.failed', { error });
  throw error;  // let TanStack Query surface it to UI
}
```

## Project Structure & Boundaries

This section establishes the **complete file-level project tree** for SafariCash at MVP, maps every FR / NFR / UX Flow to its architectural home, and defines the communication boundaries between layers. An AI agent or developer can read this section alone and know exactly where new code belongs.

### Complete Project Directory Structure

```
safaricash/
├── README.md                      # Project overview, quickstart, link to PRD/UX/Architecture
├── CLAUDE.md                      # AI-agent-specific instructions (patterns summary)
├── package.json
├── package-lock.json
├── tsconfig.json                  # Strict mode, noUncheckedIndexedAccess
├── tsconfig.node.json
├── vite.config.ts                 # Vite + PWA plugin + path aliases
├── tailwind.config.ts             # SafariCash palette, spacing, typography tokens
├── postcss.config.js
├── .eslintrc.cjs                  # With jsx-a11y + import-no-internal
├── .prettierrc
├── .gitignore
├── .env.example                   # All env var names, no values
├── index.html                     # PWA meta tags, viewport, icons
├── playwright.config.ts
├── vitest.config.ts
├── components.json                # shadcn/ui configuration
│
├── .github/
│   └── workflows/
│       ├── ci.yml                 # lint + type-check + vitest + playwright + axe + RLS test
│       └── deploy.yml              # Cloudflare Pages + Supabase migration apply
│
├── .husky/
│   ├── pre-commit                 # lint-staged
│   └── commit-msg                 # conventional-commits validator
│
├── public/
│   ├── icons/                     # PWA icons (192, 512, maskable, apple-touch)
│   ├── favicon.ico
│   └── robots.txt
│
├── supabase/
│   ├── config.toml                # Supabase CLI config (local dev)
│   ├── seed.sql                   # Dev-only seed (never in production)
│   ├── migrations/
│   │   ├── 20260419000001_init_schema.sql
│   │   ├── 20260419000002_rls_policies.sql
│   │   ├── 20260419000003_audit_log.sql
│   │   ├── 20260419000004_sms_queue.sql
│   │   ├── 20260419000005_vault_setup.sql
│   │   ├── 20260419000006_indexes.sql
│   │   └── 20260419000007_triggers_audit.sql
│   └── functions/                 # Edge Functions (Deno)
│       ├── _shared/               # cross-function utilities
│       │   ├── auth-check.ts      # RLS-equivalent entry-point guard
│       │   ├── audit-emit.ts      # Audit log append with hash chain
│       │   ├── rfc7807.ts         # Problem Details error helper
│       │   └── termii-client.ts   # Termii HTTP client
│       ├── cycle-settlement/
│       │   └── index.ts           # POST — computes + commits settlement
│       ├── sms-dispatch/
│       │   └── index.ts           # POST — enqueues SMS to sms_queue
│       ├── sms-worker/
│       │   └── index.ts           # Scheduled — drains queue, calls Termii, retries
│       ├── re-auth/
│       │   └── index.ts           # POST — issues + verifies OTP for sensitive ops
│       ├── dispute-notify/
│       │   └── index.ts           # POST — notifies collector + founder
│       └── saver-delete/
│           └── index.ts           # POST — anonymises saver PII per FR48
│
├── workers/                       # Cloudflare Workers (separate deploy artefact)
│   └── receipt-url/
│       ├── wrangler.toml
│       └── src/
│           ├── index.ts           # Public receipt URL handler
│           ├── render.ts          # SSR HTML for receipt page
│           └── dispute.ts         # POST /dispute from saver
│
├── src/
│   ├── main.tsx                   # App entry, React + Router + Providers
│   ├── App.tsx                    # Root component, global error boundary
│   ├── vite-env.d.ts
│   │
│   ├── app/
│   │   ├── router.tsx             # React Router v7 config
│   │   ├── routes/
│   │   │   ├── login.tsx          # Flow 5 — login surface
│   │   │   ├── dashboard.tsx      # Home / dashboard
│   │   │   ├── members/
│   │   │   │   ├── index.tsx      # Member list
│   │   │   │   ├── [id].tsx       # Member profile (360 view)
│   │   │   │   ├── new.tsx        # Member creation
│   │   │   │   └── [id]/
│   │   │   │       ├── edit.tsx
│   │   │   │       └── settle.tsx  # Cycle settlement (Flow 3)
│   │   │   ├── reports.tsx         # Rapports tab (Growth-tagged)
│   │   │   └── settings.tsx        # Plus tab
│   │   ├── providers.tsx           # TanStack Query, Supabase, i18n, Theme
│   │   └── guards.tsx              # Route guards (session, role)
│   │
│   ├── components/
│   │   ├── ui/                     # shadcn/ui copied components
│   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── input.tsx
│   │   │   ├── select.tsx
│   │   │   ├── toast.tsx
│   │   │   ├── sheet.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── progress.tsx
│   │   │   └── otp-input.tsx
│   │   └── domain/                 # SafariCash-specific novel components
│   │       ├── ConnectivityIndicator.tsx
│   │       ├── MemberActionSheet.tsx
│   │       ├── AdvanceSimulationPanel.tsx
│   │       ├── ProgressiveToast.tsx
│   │       ├── SettlementSummaryCard.tsx
│   │       ├── EnvelopeHandoverScreen.tsx
│   │       ├── BottomNav.tsx
│   │       ├── EmptyState.tsx
│   │       └── StatusBadge.tsx
│   │
│   ├── domain/                     # PURE — zero infra imports
│   │   ├── cycle/
│   │   │   ├── cycleEngine.ts      # computeFinalBalance, computeProjection, state transitions
│   │   │   ├── cycleEngine.test.ts # 100 % coverage gate (NFR-R3)
│   │   │   ├── cycleState.ts       # CycleStatus type + transition rules
│   │   │   └── index.ts
│   │   ├── transaction/
│   │   │   ├── kinds.ts            # contribution | rattrapage | advance
│   │   │   ├── validators.ts       # domain invariants (no negative amounts, etc.)
│   │   │   └── index.ts
│   │   └── audit/
│   │       ├── event.ts            # Event payload type
│   │       ├── hashChain.ts        # Hash-chain append / verify
│   │       ├── hashChain.test.ts
│   │       └── index.ts
│   │
│   ├── features/
│   │   ├── auth/
│   │   │   ├── api/
│   │   │   │   ├── useLogin.ts     # Phone + OTP flow
│   │   │   │   ├── useReauth.ts    # Sensitive-op OTP re-auth
│   │   │   │   └── useSession.ts
│   │   │   ├── ui/
│   │   │   │   ├── LoginForm.tsx
│   │   │   │   └── OtpStep.tsx
│   │   │   ├── types.ts            # AuthSchema (Zod)
│   │   │   └── index.ts            # Public exports
│   │   ├── member/
│   │   │   ├── api/
│   │   │   │   ├── useMembers.ts
│   │   │   │   ├── useMember.ts
│   │   │   │   ├── useCreateMember.ts
│   │   │   │   ├── useUpdateMember.ts
│   │   │   │   └── useDeleteMember.ts
│   │   │   ├── ui/
│   │   │   │   ├── MemberList.tsx
│   │   │   │   ├── MemberCard.tsx
│   │   │   │   ├── MemberProfile.tsx
│   │   │   │   ├── MemberForm.tsx
│   │   │   │   ├── DeleteConfirmation.tsx
│   │   │   │   └── ContactsImport.tsx
│   │   │   ├── types.ts            # MemberSchema, MemberFilters
│   │   │   └── index.ts
│   │   ├── cycle/
│   │   │   ├── api/
│   │   │   │   ├── useCycle.ts
│   │   │   │   ├── useCycleList.ts
│   │   │   │   └── useSettleCycle.ts
│   │   │   ├── ui/
│   │   │   │   ├── CycleProgressBar.tsx
│   │   │   │   ├── CycleSettlement.tsx
│   │   │   │   └── CycleEndingAlert.tsx
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── transaction/
│   │   │   ├── api/
│   │   │   │   ├── useRecordContribution.ts
│   │   │   │   ├── useRecordRattrapage.ts
│   │   │   │   ├── useRecordAdvance.ts
│   │   │   │   └── useTransactionHistory.ts
│   │   │   ├── ui/
│   │   │   │   ├── TransactionEntry.tsx
│   │   │   │   ├── AdvanceFlow.tsx
│   │   │   │   └── TransactionHistoryList.tsx
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   ├── dispute/
│   │   │   ├── api/
│   │   │   │   └── useDisputes.ts  # Collector-side dispute list
│   │   │   ├── ui/
│   │   │   │   └── DisputeInlineBanner.tsx  # Shown on member profile
│   │   │   ├── types.ts
│   │   │   └── index.ts
│   │   └── dashboard/
│   │       ├── api/
│   │       │   ├── useDashboardStats.ts  # 60-s polled
│   │       │   └── useRecentActivity.ts
│   │       ├── ui/
│   │       │   ├── DashboardHero.tsx
│   │       │   └── StatsTriple.tsx
│   │       └── index.ts
│   │
│   ├── infrastructure/
│   │   ├── supabase/
│   │   │   ├── client.ts           # Singleton Supabase client
│   │   │   ├── env.ts              # Validated env var loader (Zod)
│   │   │   └── camelize.ts         # snake_case ↔ camelCase bridge
│   │   ├── sync/                   # Offline event-sourced sync (critical module)
│   │   │   ├── eventLog.ts         # IndexedDB event log CRUD
│   │   │   ├── eventLog.test.ts
│   │   │   ├── outbox.ts           # Pending-operations queue
│   │   │   ├── reconciler.ts       # Replay to server on reconnect
│   │   │   ├── reconciler.test.ts  # Property-based tests
│   │   │   ├── connectivity.ts     # Network state observer
│   │   │   └── index.ts
│   │   ├── audit/
│   │   │   ├── emit.ts             # Convenience wrapper (local event + server push)
│   │   │   └── verify.ts           # Hash-chain verification helper
│   │   └── termii/                 # Edge Functions import from supabase/functions/_shared
│   │
│   ├── lib/
│   │   ├── format/
│   │   │   ├── currency.ts         # FCFA with non-breaking space
│   │   │   ├── phone.ts            # +221 prefix, Senegalese mobile pattern
│   │   │   └── date.ts             # fr-FR locale, 24h clock
│   │   ├── validators/
│   │   │   ├── phoneNumber.ts      # Zod refinement
│   │   │   └── amount.ts
│   │   ├── constants.ts            # MAX_OFFLINE_HOURS, OTP_LOCKOUT_MINUTES, etc.
│   │   └── utils.ts                # Generic helpers
│   │
│   ├── hooks/
│   │   ├── useOffline.ts           # Connectivity status
│   │   ├── useHaptic.ts            # Vibration API wrapper
│   │   ├── useDebounce.ts
│   │   └── useKeyboardShortcut.ts
│   │
│   ├── styles/
│   │   └── globals.css             # Tailwind directives + CSS variables
│   │
│   └── i18n/
│       ├── fr.json                 # French strings (MVP only)
│       ├── keys.ts                 # Type-safe key enum
│       └── useT.ts                 # Translation hook
│
├── tests/
│   ├── e2e/
│   │   ├── flow-1-contribution.spec.ts
│   │   ├── flow-2-advance.spec.ts
│   │   ├── flow-3-settlement.spec.ts
│   │   ├── flow-4-dispute.spec.ts
│   │   ├── flow-5-login.spec.ts
│   │   └── rls-isolation.spec.ts   # NFR-S5 gate — critical
│   └── fixtures/
│       ├── members.ts
│       └── transactions.ts
│
└── docs/
    ├── ARCHITECTURE_DECISIONS.md   # Link to this architecture.md
    ├── RUNBOOK.md                  # Prod operations (incident response, etc.)
    └── ADR/                        # Architecture Decision Records (lightweight)
        ├── 001-supabase-vault.md
        ├── 002-polling-vs-realtime.md
        └── 003-event-sourced-offline.md
```

### Architectural Boundaries

**API Boundaries:**

| Endpoint category | Handler | Auth layer |
|---|---|---|
| Read CRUD on `members`, `transactions`, `cycles` | PostgREST auto-generated | Supabase RLS |
| Write CRUD on `members` | PostgREST auto-generated | Supabase RLS |
| Write `transactions` | PostgREST direct (fast path) + audit trigger | Supabase RLS + Postgres trigger |
| Cycle settlement | Edge Function `/functions/v1/cycle-settlement` | RLS + OTP re-auth (FR5) |
| SMS dispatch (enqueue) | Edge Function `/functions/v1/sms-dispatch` | RLS entry-point check |
| SMS worker (drain queue) | Edge Function `/functions/v1/sms-worker` (scheduled) | Service role |
| Saver dispute submission | Cloudflare Worker `POST /r/{token}/dispute` | Token-based (no auth required) |
| Receipt URL page | Cloudflare Worker `GET /r/{token}` | Public, token-based |
| Dispute notification | Edge Function `/functions/v1/dispute-notify` | Service role |

**Component Boundaries:**

- **UI layer** (`src/components/ui/`) — pure presentational, no feature logic, no data fetching. Consumes props, emits events.
- **Domain-specific UI** (`src/components/domain/`) — composed of UI primitives, still presentational, but carries SafariCash-specific semantics (e.g., `AdvanceSimulationPanel` encodes the advance simulation contract).
- **Feature UI** (`src/features/{f}/ui/`) — connects domain components to feature hooks. Owns feature-specific user interactions.
- **Feature API** (`src/features/{f}/api/`) — TanStack Query hooks. The **only** layer that touches Supabase client directly.
- **Domain** (`src/domain/`) — pure functions, zero dependencies on React or Supabase. Imported by both UI (for display computation) and feature API (for validation).
- **Infrastructure** (`src/infrastructure/`) — singleton clients (Supabase, Termii), the sync layer, audit helpers. Imports from `lib/` and `domain/`, never from `features/` or `components/`.

**Data Boundaries:**

| Layer | Concern |
|---|---|
| Postgres schema | Canonical data; RLS per-collector isolation; Postgres constraints (NOT NULL, CHECK, FK) |
| `sms_queue` table | Durable SMS commitment; retried by worker |
| `audit_log` table | Hash-chained append-only; 10-year retention; NFR-S6 |
| Supabase Vault | Column-level encryption keys (NFR-S1) |
| IndexedDB (client) | Offline event log; syncs to Postgres on reconnect |
| TanStack Query cache (client, ephemeral) | Read-model cache; 60-s stale-while-revalidate |
| Cloudflare KV (optional, future) | Receipt URL token lookup cache; not MVP |

**Domain → Infrastructure boundary (critical):**

- `src/domain/` imports from nothing beyond standard library.
- `src/infrastructure/` imports from `src/domain/` but never the reverse.
- `src/features/` composes both.
- `src/components/domain/` imports from `src/domain/` for computation but never from `infrastructure/`.

This layering is enforced via ESLint `import/no-internal-modules` rules.

### Requirements to Structure Mapping

**FR category → Files:**

| FR Category | Primary home |
|---|---|
| Collector Auth & Session (FR1, 3–6) | `src/features/auth/`, `supabase/functions/re-auth/` |
| Member Lifecycle (FR7–14) | `src/features/member/`, `supabase/migrations/` for schema |
| Cycle Management (FR15–21) | `src/domain/cycle/`, `src/features/cycle/`, `supabase/functions/cycle-settlement/` |
| Transaction Capture (FR22–26) | `src/features/transaction/`, `src/infrastructure/sync/` (offline path) |
| Saver Trust Communications (FR27–33b) | `supabase/functions/sms-dispatch/`, `supabase/functions/sms-worker/`, `workers/receipt-url/` |
| Visibility & Reporting (FR34–39) | `src/features/dashboard/`, lib formatters |
| Offline Operation (FR40–43) | `src/infrastructure/sync/` entirely |
| Security / Audit / Data Protection (FR44–49) | `src/domain/audit/`, `src/infrastructure/audit/`, `supabase/migrations/20260419000005_vault_setup.sql`, `supabase/functions/saver-delete/` |

**NFR → Enforcement location:**

| NFR | Enforced in |
|---|---|
| NFR-P1 (5 s transaction) | E2E tests in `tests/e2e/flow-1-contribution.spec.ts`; production observability |
| NFR-P2 (300 ms search) | Postgres index on `members(collector_id, name gin trigram)`; E2E timing assertion |
| NFR-P3 (2.5 s FMP) | Lighthouse CI job in `.github/workflows/ci.yml`; bundle-size budget in `vite.config.ts` |
| NFR-P4 (60 s SMS) | SMS worker config (`supabase/functions/sms-worker/`); monitored via audit log timing |
| NFR-R2 (24 h offline) | `src/infrastructure/sync/` capacity + reconciler replay tests |
| NFR-R3 (cycle correctness) | `src/domain/cycle/cycleEngine.test.ts` — 100 % coverage gate |
| NFR-S1 (encryption at rest) | `supabase/migrations/20260419000005_vault_setup.sql` |
| NFR-S5 (RLS isolation) | `tests/e2e/rls-isolation.spec.ts` — release gate |
| NFR-S6 (hash-chained audit) | `src/domain/audit/hashChain.ts`, enforced on every mutation via Postgres trigger |
| NFR-A1 (WCAG 2.1 AA) | `@axe-core/playwright` in every E2E spec |

**UX Flow → Files:**

| UX Flow | Primary files |
|---|---|
| Flow 1 — Contribution | `src/features/transaction/ui/TransactionEntry.tsx`, `src/components/domain/MemberActionSheet.tsx`, `src/components/domain/ProgressiveToast.tsx` |
| Flow 2 — Advance | `src/features/transaction/ui/AdvanceFlow.tsx`, `src/components/domain/AdvanceSimulationPanel.tsx` |
| Flow 3 — Settlement | `src/app/routes/members/[id]/settle.tsx`, `src/components/domain/SettlementSummaryCard.tsx`, `EnvelopeHandoverScreen.tsx` |
| Flow 4 — Dispute | `workers/receipt-url/src/` (public surface), `src/features/dispute/` (collector-side) |
| Flow 5 — Login | `src/app/routes/login.tsx`, `src/features/auth/ui/` |

### Integration Points

**Internal communication:**

- React components → feature hooks → TanStack Query → Supabase client → PostgREST / Edge Functions / Realtime.
- UI-only state within React Context (session, connectivity, theme).
- Cross-feature coordination (e.g., transaction commit → cycle status update) via **TanStack Query invalidation** triggered from the mutating hook's `onSuccess`.

**External integrations:**

- **Supabase (Paris)** — HTTPS to `{PROJECT}.supabase.co`; PostgREST on `/rest/v1`, Edge Functions on `/functions/v1`, Realtime on `wss://{project}.supabase.co/realtime/v1`.
- **Termii** — called from Edge Functions (`sms-worker`) over HTTPS. Never from the browser.
- **Cloudflare Pages** — serves PWA shell.
- **Cloudflare Workers** — serves `/r/{token}` receipt URL surface; calls Supabase via service role for dispute write.
- **WhatsApp Business API** (Growth) — wired to SMS worker as secondary channel.

**Data flow (transaction happy path — Flow 1):**

1. Collector taps `MemberActionSheet` → `useRecordContribution` hook triggered.
2. Client writes event to IndexedDB event log (`src/infrastructure/sync/eventLog.ts`).
3. Optimistic UI update via TanStack Query.
4. If online: reconciler immediately pushes the event to Supabase (PostgREST insert on `transactions` + audit log insert via trigger).
5. Postgres trigger enqueues an SMS row in `sms_queue`.
6. `sms-worker` Edge Function (scheduled) drains `sms_queue`, calls Termii, updates status.
7. Realtime subscription (optional, disabled at MVP for dashboard) would push `sms.delivered` back to the collector's toast state.
8. If offline at step 4: event remains in IndexedDB; reconciler replays on reconnection.

### File Organization Patterns

**Configuration files** live at repo root. Never nested.

**Source code** follows the layered structure: UI components → feature modules → domain → infrastructure. Each layer imports only from layers "below" it.

**Test co-location:** unit / integration tests beside source files (`.test.ts`). E2E tests in `tests/e2e/`. RLS isolation test is first-class (`tests/e2e/rls-isolation.spec.ts`) because it gates releases.

**Assets:** static assets in `public/` (served directly). No dynamic asset pipeline — Vite handles image imports in `src/`.

### Development Workflow Integration

**Development server:** `npm run dev` launches Vite dev server + Supabase local stack in parallel (`supabase start`). IndexedDB persists locally across refreshes, so offline testing is effortless.

**Build process:** `npm run build` produces Cloudflare-Pages-ready static assets in `dist/`. `npm run build:workers` produces Cloudflare Worker bundles in `workers/*/dist/`.

**Deployment (automated via GitHub Actions):**

1. Push to `main` → CI runs full test suite.
2. Green CI → Cloudflare Pages auto-deploys PWA.
3. Separate workflow step runs `supabase db push` to apply new migrations against the production project.
4. Cloudflare Workers are deployed via `wrangler deploy` in the same workflow.

**Local dev environment parity:**

- Supabase CLI runs a local Postgres + PostgREST + Studio + Edge Functions runtime.
- Cloudflare Workers run locally via `wrangler dev`.
- Termii SMS are **stubbed in dev** — SMS messages are written to `dev-sms-log.txt` instead of dispatched. Prevents accidental production SMS during testing.

This layout lets an AI agent or developer join the project and deliver a feature end-to-end without asking *"where does this go?"* — every location is determined.

## Architecture Validation Results

Systematic validation of the architecture across coherence, requirements coverage, and implementation readiness. Conducted at the end of the 7-step architecture workflow.

### Coherence Validation ✅

**Decision compatibility:**

- Supabase (Paris) + Cloudflare (Pages + Workers) topology: clean layer separation, independent failure modes, ~60–80 ms RTT acceptable for NFR-P budgets.
- PostgREST direct reads + Edge Functions for custom writes + Postgres triggers for cross-cutting (audit, sms_queue): no routing conflicts; RLS evaluated in all paths.
- Event-sourced offline sync + PostgREST writes on reconnect: compatible (single-writer-per-collector guarantees idempotency).
- React Router v7 + Vite PWA + Tailwind + shadcn/ui: official ecosystem alignment; no integration surprises.
- Supabase Vault + PostgREST: encryption is transparent at the query layer; apps see decrypted values for authorised readers.
- Termii (HTTP API, Deno-friendly) + Edge Functions (Deno runtime): native fit, no SDK constraints.

**No contradictions found.** Every decision reinforces the others.

**Pattern consistency:**

- Naming conventions (snake_case DB → camelCase app via bridge) respected at the one boundary layer. No lateral leakage.
- Event naming (`{entity}.{action}` past-tense) consistent across audit log, TanStack Query keys, and Edge Function names.
- Error handling contract (RFC 7807 for custom, PostgREST default for CRUD) is enforced once at the TanStack Query layer.
- The **domain → infrastructure → features → ui** layering is machine-enforceable (ESLint import restrictions) and matches the project tree.

**Structure alignment:**

- Project tree has a home for every FR category, every NFR enforcement point, and every UX Flow.
- Component boundaries (ui / domain / features / infrastructure) match the import-direction rules.
- Integration points (PostgREST, Edge Functions, Workers, Termii) each have an explicit handler location.

### Requirements Coverage Validation ✅

**Functional Requirements (50 total):**

All 50 FRs have a specified architectural home (see Project Structure → Requirements to Structure Mapping). Traced spot checks:

| FR | Lives in | Verified |
|---|---|---|
| FR1 (sign-in phone + OTP) | `src/features/auth/api/useLogin.ts` | ✅ |
| FR17 (projection formula) | `src/domain/cycle/cycleEngine.ts` | ✅ |
| FR27 (SMS receipt dispatch) | `supabase/functions/sms-dispatch/` + `sms-worker/` | ✅ |
| FR33b (saver dispute flag) | `workers/receipt-url/src/dispute.ts` + `supabase/functions/dispute-notify/` | ✅ |
| FR46 (RLS per-collector isolation) | `supabase/migrations/20260419000002_rls_policies.sql` + `tests/e2e/rls-isolation.spec.ts` | ✅ |
| FR48 (right-to-deletion anonymisation) | `supabase/functions/saver-delete/` | ✅ |

No FR is orphaned. Growth-phase FRs (FR38, FR39, WhatsApp in FR29) have deferred homes flagged as `(Growth)` in scope.

**Non-Functional Requirements (41 total):**

Enforcement location table in Project Structure covers 10+ NFRs explicitly; remaining NFRs map to patterns (logging, session, encryption) already cemented in decisions. No NFR without a verifiable enforcement path.

**UX Flows (5 total):**

All 5 flows have primary-file mappings in the project tree. Flow 4 (dispute) spans both Cloudflare Worker (public surface) and Supabase Edge Function (notification routing) — explicitly boundary-crossed, documented.

**Cross-cutting concerns (10):**

Each of the 10 concerns identified in Project Context Analysis has been resolved in Core Architectural Decisions:

1. ✅ Tenant isolation — Supabase RLS + automated gate test.
2. ✅ Audit trail — hash-chained Postgres `audit_log` table + domain module.
3. ✅ Offline-first sync — event-sourced module in `src/infrastructure/sync/`.
4. ✅ Durable SMS delivery — `sms_queue` table + `sms-worker` Edge Function.
5. ✅ Cycle engine correctness — pure domain + 100 % coverage gate.
6. ✅ Session / re-auth — Supabase Auth + `/re-auth` Edge Function.
7. ✅ Observability — `audit_log` as source of truth + structured JSON logs + Supabase dashboard (Sentry deferred).
8. ✅ Secret management — Cloudflare env + Supabase Vault + dashboard-managed rotation.
9. ✅ Column encryption — Supabase Vault (NFR-S1).
10. ✅ Retention & anonymisation — tiered policy (10 y audit, 2 y PII) + FR48 anonymisation path.

### Implementation Readiness Validation ✅

**Decision completeness:**

- Every critical decision documented with rationale and affected components.
- Technology versions committed at major-version level (verification at `npm init` time specified).
- No decision paragraphs ending with "TBD" or "to be decided later" — all deferred decisions explicitly marked with Growth triggers.

**Structure completeness:**

- Directory tree covers all MVP surfaces (PWA app, Edge Functions, Workers, migrations, tests, docs).
- Every directory has at least one named file illustrating its purpose.
- Integration points (Supabase, Termii, Cloudflare) each have a single source-of-truth location.

**Pattern completeness:**

- Naming, structure, format, communication, and process patterns all specified with examples.
- Anti-patterns explicitly called out (cross-feature imports, silent error swallow).
- Enforcement split across automated (CI gate), semi-automated (PR checklist), and manual (code review) levels.

### Gap Analysis Results

**Critical gaps: 0.** No missing architectural decision blocks implementation.

**Important gaps (non-blocking, worth closing before final ship):**

1. **Cycle-engine property-based test invariants** — the architecture commits to 100 % coverage + property-based testing for `src/domain/cycle/cycleEngine.ts` but does not enumerate the specific property invariants. Should be defined in an ADR (e.g., `docs/ADR/004-cycle-invariants.md`) before EPIC-3 implementation begins. Invariants to codify at minimum: projected balance monotonicity, settlement determinism, advance-capacity bound, day-N commission invariance.
2. **CLAUDE.md content** — the project tree includes `CLAUDE.md` (AI-agent instructions) but its content is undefined. Should be written as a condensed pattern summary (naming, imports, test gates) pointing back to this architecture doc. This is required before Phase 4 (implementation) begins if AI agents will be used.
3. **Supabase region performance spike** — assumption A7 (RLS scales to 500 collectors) is an architectural commitment but has not been experimentally validated. A one-day load-test spike is recommended before EPIC-4 (transaction capture) implementation. Not blocking MVP start, but blocking Growth scale-out confidence.
4. **Backup recovery drill procedure** — NFR-R5 / R6 (RPO 1 h, RTO 4 h) are asserted but no documented procedure exists for executing a recovery drill. Should be added to `docs/RUNBOOK.md` before first paying collector.
5. **Secret rotation runbook** — the architecture mentions "quarterly rotation at minimum" but no step-by-step procedure. Add to `docs/RUNBOOK.md`.

**Nice-to-have gaps (Growth-phase considerations):**

- Observability upgrade path (Sentry activation) has a Growth trigger but no specific decision gate other than founder judgment.
- Materialised views for dashboard stats are deferred to ">1 000 collectors" but the specific NFR-P2 breach threshold that triggers them is not defined.
- Multi-collector conflict resolution UI is excluded from MVP but its future-architecture shape is not sketched (deferred to a Growth-phase architecture addendum).

### Validation Issues Addressed

No critical issues required resolution. The 5 important gaps above are flagged as follow-ups, not blockers. They can be closed in parallel with EPIC-0 bootstrap without impacting the critical path.

### Architecture Completeness Checklist

**✅ Requirements Analysis**

- [x] Project context thoroughly analysed (50 FRs, 41 NFRs, 5 UX Flows, 10 cross-cutting concerns)
- [x] Scale and complexity assessed (medium-high; 500-collector MVP → 2 000 ceiling)
- [x] Technical constraints identified (stack fixed from PRD, hosting / region decided in step 2)
- [x] Cross-cutting concerns mapped (10 items, each resolved in step 4)

**✅ Architectural Decisions**

- [x] Critical decisions documented with rationale (Q-ARCH1 through Q-ARCH7)
- [x] Technology stack fully specified (versions at major-version level)
- [x] Integration patterns defined (PostgREST / Edge Functions / Workers / Termii)
- [x] Performance considerations addressed (budgets traced to NFR-P enforcement locations)

**✅ Implementation Patterns**

- [x] Naming conventions established (DB, API, code, files)
- [x] Structure patterns defined (layered, feature-modular)
- [x] Communication patterns specified (events, TanStack Query keys, state updates)
- [x] Process patterns documented (errors, loading, retries, validation, session, logging)
- [x] Enforcement guidelines (CI gate / PR checklist / code review)

**✅ Project Structure**

- [x] Complete directory structure defined (file-level)
- [x] Component boundaries established (ui / domain / features / infrastructure)
- [x] Integration points mapped (all external services)
- [x] Requirements → Structure mapping complete (FR, NFR, UX flow)

### Architecture Readiness Assessment

**Overall status: READY FOR IMPLEMENTATION**

**Confidence level: HIGH.**

Rationale: the architecture is coherent, covers 100 % of PRD v1.2 + UX spec requirements, has no critical gaps, and specifies file-level destinations for every requirement. The novel technical areas (offline sync, cycle engine correctness, SMS durable commitment) are isolated in dedicated modules with testable contracts. Stack choices are boring and well-documented in the ecosystem.

**Key strengths:**

- **Layer discipline** — the domain / infrastructure / features / UI separation is machine-enforceable and maps cleanly to the project tree.
- **Risk isolation** — the three architectural risks (offline correctness, cycle correctness, SMS reliability) each have a dedicated module with its own test surface.
- **Trace completeness** — every FR, NFR, and UX Flow has a named architectural home. No orphan requirements.
- **Cost discipline** — Cloudflare Pages free tier + Supabase Pro (~25 $/mo MVP) keeps infra cost near zero, aligned with R-RS2 break-even math.
- **Migratability** — every layer can be swapped independently (hosting, SMS gateway, backend); no vendor lock-in at architecture level.

**Areas for future enhancement (not MVP-blocking):**

- Observability maturity: Sentry activation when operational pain justifies it.
- Multi-collector conflict resolution (Vision-phase architecture addendum).
- Materialised views or read replicas (if NFR-P2 stressed at > 1 000 collectors).
- Self-hosted Supabase migration path (if UEMOA data-localisation tightens).

### Implementation Handoff

**AI-agent / developer guidelines:**

- Follow every architectural decision in this document. If a decision seems wrong, open an ADR or PRD amendment request — do not deviate silently.
- Respect layer boundaries. ESLint will enforce them; if a layered import feels necessary, it is a signal that a feature is misplaced.
- Use implementation patterns consistently. See `CLAUDE.md` (to be written — see Gap #2) for a condensed pattern summary.
- Every state mutation emits an `audit_log` event. Every destructive action gates behind re-auth or typed confirmation. Every SMS is a durable commitment, not a fire-and-forget call.
- When unsure of where code belongs, re-read *Project Structure → Requirements to Structure Mapping*. Every FR has a home.

**First implementation priority:**

**EPIC-0 / Story 0** — project bootstrap following the Initialisation Command Sequence in the Starter Template Evaluation section. Expected deliverable: a running Vite + React + TS + Tailwind + shadcn/ui + Supabase + Cloudflare-deployable skeleton with CI green on lint + type-check + a smoke test.

Every subsequent EPIC (1–9, sequence in Decision Impact Analysis) assumes this bootstrap exists and extends it incrementally.

**Follow-up tasks to close before ship (from Gap Analysis, not blocking start):**

1. Write `docs/ADR/004-cycle-invariants.md` — property-based test invariants for the cycle engine.
2. Write `CLAUDE.md` — condensed pattern summary for AI agents.
3. Schedule the Supabase RLS 500-collector performance spike.
4. Document the backup recovery drill procedure in `docs/RUNBOOK.md`.
5. Document the secret rotation runbook in `docs/RUNBOOK.md`.
