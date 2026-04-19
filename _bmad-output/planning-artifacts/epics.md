---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
completedAt: '2026-04-19'
status: 'complete'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
workflowType: 'epics-and-stories'
project_name: 'SafariCash'
date: '2026-04-19'
---

# SafariCash — Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for SafariCash, decomposing the requirements from PRD v1.2, the UX Design Specification, and the Architecture Decision Document into implementable stories with testable acceptance criteria.

## Requirements Inventory

### Functional Requirements

Extracted from `prd.md` (v1.2). 50 FRs total organised in 8 capability areas. FR2 is explicitly reserved (removed in v1.2).

**Collector Authentication & Account Session**

- **FR1:** A collector can sign in to a pre-provisioned account by providing their registered mobile phone number and verifying ownership via a one-time SMS code.
- **FR2:** *(Reserved — removed in v1.2; email + magic-link sign-up retired when the product moved to an invite-only / pre-provisioned model.)*
- **FR3:** A returning collector can sign in via phone-OTP. Account recovery is handled manually via the SafariCash support line (R-OP1).
- **FR4:** A collector can sign out of the app at any time.
- **FR5:** The system requires a fresh SMS-OTP re-authentication before each of: cycle settlement, bulk member delete, data export.
- **FR6:** A collector's session expires after an idle duration specified in NFRs and requires re-authentication to resume.

**Member Lifecycle**

- **FR7:** A collector can create a member by entering name, phone (optional), and daily contribution amount.
- **FR8:** A collector can create members in bulk by granting access to device contacts and selecting entries from a local picker; no contact data leaves the device until the collector confirms.
- **FR9:** A collector can revoke the device-contacts permission at any time from a single action in settings.
- **FR10:** A collector can edit a member's name, phone, and daily contribution amount; edits affecting an in-flight cycle display an impact warning requiring explicit confirmation.
- **FR11:** A collector can delete a member. Deletion requires double confirmation including typing the literal word *"SUPPRIMER"*.
- **FR12:** A collector can restart a member's cycle after completion.
- **FR13:** A collector can view a member's full profile showing contributed total, expected total, outstanding advances, projected final balance, and complete chronological transaction history.
- **FR14:** A collector can search and filter the member list by name and by status (active / completed / with-advance).

**Cycle Management**

- **FR15:** The system initiates a 30-calendar-day cycle at member creation or on cycle restart.
- **FR16:** The system tracks a member's position within the current cycle (day 1 through day 30) based on the cycle start date.
- **FR17:** The system computes, at any point in a cycle, the projected final balance as `(daily_amount × 30) − (1 × daily_amount) − Σ(outstanding advances)`.
- **FR18:** The system transitions cycle status automatically between *active*, *with-advance*, and *completed*.
- **FR19:** The system prevents new contributions from being recorded against a completed cycle.
- **FR20:** The system identifies cycles ending within a configurable upcoming window and surfaces them as dashboard alerts.
- **FR21:** A collector can initiate settlement of a completed cycle; the system computes and displays the final payout amount.

**Transaction Capture**

- **FR22:** A collector can record a contribution for a selected member, with the member's daily amount pre-suggested.
- **FR23:** A collector can record a catch-up (*rattrapage*) transaction covering one or more missed days of the current cycle.
- **FR24:** A collector can record an advance (*prêt*); before committing, the system displays situation-in-context and simulates impact on projected final balance.
- **FR25:** Advance transactions require motive capture and saver explicit acknowledgment before being recorded.
- **FR26:** A collector can record any transaction type while offline; the system queues it locally and synchronises on reconnection.

**Saver Trust Communications**

- **FR27:** The system automatically sends an SMS receipt to the saver for each contribution, catch-up, or advance transaction.
- **FR28:** Every SMS receipt contains: amount, date/time, cycle-day position, projected final balance, unique receipt URL token.
- **FR29:** Every receipt is additionally delivered via WhatsApp if the saver has opted in and WhatsApp Business is provisioned.
- **FR30:** A saver can access a public, tokenized receipt page on any browser without authentication; the page exposes no info beyond the SMS content.
- **FR31:** The system delivers a data-protection consent notice on the saver's first SMS, with an opt-out mechanism.
- **FR32:** A saver who has opted out no longer receives SMS; the opt-out is recorded in the audit trail.
- **FR33:** A collector can resend a saver's full cycle history on request (support scenario).
- **FR33b:** A saver can flag a transaction as disputed via the receipt URL page. The system records the dispute immutably in the audit trail and immediately notifies the collector (in-app) and the founder (designated MVP support contact) via email and push. Manual adjudication at MVP.

**Visibility & Reporting**

- **FR34:** A collector can view a real-time dashboard showing active members count, amount collected today, commission earned this cycle, and recent activity.
- **FR35:** A collector can view and dismiss dashboard alerts for cycles ending in the upcoming window.
- **FR36:** A collector can view, share via OS share sheet, and re-deliver a per-transaction receipt from a member's history.
- **FR37:** A collector can export cycle-level commission summary and transaction history as CSV.
- **FR38:** A collector can view weekly and monthly auto-generated activity reports. *(Growth)*
- **FR39:** A collector can export data as PDF. *(Growth)*

**Offline Operation**

- **FR40:** A collector can perform all transaction capture, member lookup, and member edit operations while offline, with no data loss.
- **FR41:** The system displays a persistent, non-dismissable indicator showing connectivity status and pending-sync count.
- **FR42:** The system deterministically reconciles offline-captured operations with the server on reconnection, preserving operation ordering.
- **FR43:** The system alerts the collector when a pending transaction has not synchronised within the NFR-defined threshold and offers a manual retry.

**Security, Audit & Data Protection**

- **FR44:** The system records every state-mutating operation on members, transactions, and cycles as an immutable audit-log entry (actor, UTC timestamp, action, before-state hash, after-state hash).
- **FR45:** The system retains audit-log and transactional records per the retention policy (10 years audit, 2 years saver PII).
- **FR46:** The system enforces strict per-collector data isolation via RLS — no cross-collector read/list/enumerate.
- **FR47:** The system encrypts saver names, phone numbers, and transaction amounts at rest using column-level encryption; TLS 1.2+ in transit.
- **FR48:** The system honors a saver's right-to-deletion request by anonymising PII (salted hash) while preserving the audit trail.
- **FR49:** The system enforces rate limits on transaction-write endpoints per collector.

### NonFunctional Requirements

41 NFRs extracted from `prd.md`, organised in 6 categories.

**Performance (NFR-P)**

- **NFR-P1:** Transaction entry latency — p95 ≤ 5 s, p99 ≤ 8 s (app-open to server-confirmed), on mid-range Android 3G.
- **NFR-P2:** Member-list search at 150 members — p95 ≤ 300 ms from keystroke to render.
- **NFR-P3:** First Meaningful Paint on cold load — ≤ 2.5 s on 3G mid-range Android.
- **NFR-P4:** SMS receipt delivery — p95 ≤ 60 s from server commit to gateway-reported delivery; p99 ≤ 5 min.
- **NFR-P5:** Real-time simulation — client-side, zero server round-trip, completes within one animation frame (≤ 16 ms).
- **NFR-P6:** Offline→online sync throughput — drains a 24 h backlog (~150 transactions) in ≤ 90 s on typical WAEMU mobile uplink.
- **NFR-P7:** Stalled-sync alert threshold — 15 min of unacknowledged pending-sync state before manual-retry prompt. *(Growth for UI, MVP tracks state)*

**Reliability & Availability (NFR-R)**

- **NFR-R1:** Availability — 99.5 % monthly MVP; 99.9 % at ≥ 500 paying collectors (Scale).
- **NFR-R2:** Offline tolerance — 24 h continuous MVP; ≥ 7 d at Growth; zero data loss on reconnection.
- **NFR-R3:** Cycle-settlement numeric correctness — zero-tolerance (projected = settled to the franc).
- **NFR-R4:** SMS gateway failure handling — exponential backoff retry (10 s → max 10 min, abandon 24 h); failed sends surface in UI, never silently succeed.
- **NFR-R5:** RPO ≤ 1 h MVP; ≤ 15 min at Scale.
- **NFR-R6:** RTO ≤ 4 h MVP; ≤ 1 h at Scale.
- **NFR-R7:** Point-in-time restore ≥ 7 d MVP; ≥ 30 d at Scale.

**Security & Compliance (NFR-S)**

- **NFR-S1:** Encryption at rest — column-level AES-256-GCM on saver name, phone, transaction amounts.
- **NFR-S2:** Encryption in transit — TLS 1.2+ on all client-server and outbound gateway calls.
- **NFR-S3:** Receipt URL token entropy — ≥ 128 bits, unguessable, non-sequential.
- **NFR-S4:** Collector session — idle timeout 30 min; absolute lifetime 30 d with silent refresh.
- **NFR-S5:** Per-collector data isolation enforced at DB layer (RLS) validated by automated test; failing test blocks release.
- **NFR-S6:** Audit trail — append-only, cryptographically hash-chained, tamper-evidence verifiable offline.
- **NFR-S7:** Audit log and transactional records retention — 10 years (OHADA alignment; counsel-pending).
- **NFR-S8:** Saver PII retention — 2 years post-cycle-end or on explicit deletion request.
- **NFR-S9:** Rate limit — 100 req/min per collector on transaction-write endpoints at MVP.
- **NFR-S10:** Saver-facing comms contain no banking language (*"compte bancaire"*, *"dépôt"*, *"garanti"*) and carry tracker-not-mover disclosure.
- **NFR-S11:** Vulnerability management — dependency scan on every build; critical CVEs patched ≤ 7 d, high ≤ 30 d.
- **NFR-S12:** Annual third-party pentest; Critical findings remediated ≤ 14 d, High ≤ 30 d. IR plan maintained as runbook.

**Scalability (NFR-SC)**

- **NFR-SC1:** MVP — 50 concurrent active collectors with stated NFR-P / NFR-R thresholds intact.
- **NFR-SC2:** Growth — 500 paying collectors × avg 50 active savers each = 25 000 savers.
- **NFR-SC3:** Scale ceiling — ~2 000 collectors before re-architecture trigger.
- **NFR-SC4:** Transaction volume — ~75 000 transactions/day at Growth target with 3× morning peaks (06:00–10:00).
- **NFR-SC5:** Audit log growth — ~1 M events/month at Growth; 120 M events over 10-year retention without query degradation.

**Accessibility (NFR-A)**

- **NFR-A1:** WCAG 2.1 Level AA across all collector-facing screens; Level A floor on receipt URL.
- **NFR-A2:** Touch targets ≥ 44 × 44 CSS px.
- **NFR-A3:** Colour contrast ≥ 4.5 : 1 normal, ≥ 3 : 1 large.
- **NFR-A4:** Operable without colour — status badges combine colour + text label.
- **NFR-A5:** TalkBack + VoiceOver compatibility; full keyboard navigation.
- **NFR-A6:** SMS receipt — plain 7-bit ASCII / GSM-7; no emojis in receipt body.

**Localisation (NFR-L)**

- **NFR-L1:** MVP UI language — French (fr-FR, tolerant fr-SN). No other language at MVP.
- **NFR-L2:** All user-facing strings externalised via i18n keys from day 1.
- **NFR-L3:** Number and currency formatting — FCFA-aware with non-breaking space thousands separator.
- **NFR-L4:** Dates — French locale, 24-hour clock, WAT display; UTC storage.
- **NFR-L5:** Receipt copy — reviewed by a French-native legal / compliance reader before MVP launch.

### Additional Requirements

Extracted from `architecture.md` — technical and infrastructure requirements that shape epic / story creation.

- **AR1:** Project bootstrap via `create-vite` + layered manual setup (16-step init sequence documented in architecture § Starter Template Evaluation). **Impacts EPIC-0 Story 1 directly.**
- **AR2:** Supabase cloud (eu-west-3 Paris) — project provisioning, env configuration, migration pipeline setup.
- **AR3:** Cloudflare Pages + Cloudflare Workers hosting — PWA deployment + receipt URL Worker.
- **AR4:** Database schema + RLS policies in Supabase migrations (`supabase/migrations/*.sql`) — tables `users`, `members`, `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes`.
- **AR5:** Supabase Vault column-level encryption setup (saver name, phone, amounts) per NFR-S1.
- **AR6:** Automated RLS isolation test (`tests/e2e/rls-isolation.spec.ts`) as release gate per NFR-S5.
- **AR7:** Hash-chained audit log with Postgres trigger enforcement for every state mutation (NFR-S6 / FR44).
- **AR8:** Event-sourced offline sync layer (`src/infrastructure/sync/`) — IndexedDB event log, outbox pattern, deterministic reconciler.
- **AR9:** Termii SMS integration via Edge Function (`supabase/functions/sms-dispatch/` + `sms-worker/`) with durable commitment pattern (queue + retry + status propagation).
- **AR10:** Receipt URL page Cloudflare Worker (`workers/receipt-url/`) — no-JS baseline, progressive enhancement.
- **AR11:** Re-auth Edge Function (`supabase/functions/re-auth/`) for sensitive operations (FR5 / NFR-S4).
- **AR12:** Dispute notification Edge Function (`supabase/functions/dispute-notify/`) — routes to collector + founder via email + push.
- **AR13:** Saver anonymisation Edge Function (`supabase/functions/saver-delete/`) per FR48.
- **AR14:** GitHub Actions CI pipeline — lint + type-check + vitest (with 100 % domain coverage gate) + playwright + axe + RLS isolation test + preview deploy.
- **AR15:** Cycle engine as pure domain module (`src/domain/cycle/`) with 100 % coverage gate (NFR-R3).
- **AR16:** Cycle-invariants ADR (`docs/ADR/004-cycle-invariants.md`) — property-based test invariants to be defined before EPIC-3 implementation.
- **AR17:** CLAUDE.md — condensed pattern summary for AI agents; prerequisite for Phase 4.
- **AR18:** Admin provisioning at MVP via Supabase Studio (manual user table inserts by founder); no custom admin UI at MVP.
- **AR19:** French i18n key structure under `src/i18n/fr.json` + type-safe key enum; no multi-language runtime at MVP but architecture is i18n-ready.
- **AR20:** Observability baseline — structured JSON logs from Edge Functions + `audit_log` table as debugging source of truth; Supabase dashboard for logs; Sentry deferred to Growth.
- **AR21:** Runbook documentation (`docs/RUNBOOK.md`) — backup recovery drill procedure, secret rotation procedure, incident response plan reference (NFR-S12, NFR-R5/R6).

### UX Design Requirements

Extracted from `ux-design-specification.md`. Each UX-DR is specific and actionable with testable acceptance criteria.

**Design Tokens & System:**

- **UX-DR1:** Encode SafariCash palette (primary `#1D9E75` + semantic palettes + neutral scale) in `tailwind.config.ts` as design tokens, with full 50–950 tint/shade scale for primary and semantic mappings for `success`, `warning`, `destructive`, `info`.
- **UX-DR2:** Encode type scale tokens (display, title-1, title-2, body-1, body-2, caption, overline, amount-large, amount-inline) per UX Visual Foundation § Typography, using `system-ui` stack with no custom font loading.
- **UX-DR3:** Encode spacing scale (4 px base grid), corner radii (12–16 px cards, 50 % FAB/avatar), and shadow tokens (flat-by-default with hairline borders); no heavy drop shadows.
- **UX-DR4:** Initialise shadcn/ui via `npx shadcn-ui init` and copy-re-skin 10 foundation components (Button, Card, Dialog, Input, Select, Toast, Sheet, Badge, Progress, OTP Input) to match SafariCash tokens.

**Novel Components (9):**

- **UX-DR5:** Build `ConnectivityIndicator` component — persistent header pill with 4 states (connected / syncing / offline / sync-failed), tap opens sync-status drawer, `aria-live="polite"`.
- **UX-DR6:** Build `MemberActionSheet` component — bottom-sheet modal with member avatar + name, pre-filled amount CTA, secondary links (Rattrapage / Prêt / Montant personnalisé). Keeps list visible behind.
- **UX-DR7:** Build `AdvanceSimulationPanel` component — 4-row simulation (total cycle / commission / advance / projected final balance), updates client-side ≤ 16 ms, `aria-live` on final balance.
- **UX-DR8:** Build `ProgressiveToast` component — progressive state states (committed / undoable / sending / delivered / offline / failed) with 5-s undo window and truth-over-optimism contract.
- **UX-DR9:** Build `SettlementSummaryCard` component — deliberate slow trust ceremony, Verify / Confirm buttons, OTP re-auth integration.
- **UX-DR10:** Build `EnvelopeHandoverScreen` component — day-30 emotional climax with envelope-handover copy, single CTA, minimal animation.
- **UX-DR11:** Build `DisputeFlagSurface` component — mobile-web (plain HTML + Tailwind, no framework) rendered by Cloudflare Worker; dispute CTA below transaction details; confirmation bottom-sheet; compassionate acknowledgment screen.
- **UX-DR12:** Build `BottomNav` component — 4-tab persistent nav (Dashboard / Membres / Rapports / Plus); `role="tablist"`; instant switch (no animation).
- **UX-DR13:** Build `EmptyState` component — first-login member-list empty state with single CTA (*"Ajouter mon premier membre"*), minimal illustration.

**SMS Copy Templates:**

- **UX-DR14:** Implement first-SMS copy template (includes peer-voice greeting, amount, cycle day, projected balance, receipt URL, opt-out instruction, tracker-not-mover disclosure per NFR-S10).
- **UX-DR15:** Implement subsequent-SMS copy template (data-only, no greeting, maintains rigid M-Pesa-style structure for predictability).
- **UX-DR16:** Implement settlement-SMS copy template for day-30 final notice.
- **UX-DR17:** Implement dispute acknowledgment SMS (24–48 h response-time promise, no accusation language).
- **UX-DR18:** Ensure all SMS bodies are GSM-7 compatible (plain 7-bit ASCII, no emoji) per NFR-A6.

**Receipt URL Page:**

- **UX-DR19:** Render receipt URL page (`workers/receipt-url/src/render.ts`) as semantic HTML with Tailwind progressive enhancement; readable without JavaScript; responsive fluid (no breakpoints); WCAG Level A baseline.
- **UX-DR20:** Implement dispute submission flow from receipt URL page (tap CTA → bottom-sheet confirmation → optional free-text → compassionate acknowledgment screen) per Flow 4.

**Accessibility & QA:**

- **UX-DR21:** Configure axe-core assertions (via `@axe-core/playwright` and `jest-axe`) to block CI on any critical accessibility finding; cover all 5 UX Flows.
- **UX-DR22:** Implement focus management — route-change focus on main heading; action-sheet / dialog focus trap; visible 2 px primary-green outline with offset on every interactive element.
- **UX-DR23:** Implement `prefers-reduced-motion` and `prefers-contrast` guards on Framer Motion animations and CSS variables.
- **UX-DR24:** Conduct manual TalkBack + VoiceOver flow sweeps (Flows 1 / 2 / 3 / 5) and 200 % text-zoom check per release.
- **UX-DR25:** Conduct outdoor contrast qualitative test (dashboard, transaction entry, toast states) on Samsung A-series in direct sunlight per release.

**Performance & PWA:**

- **UX-DR26:** Configure Vite PWA plugin with manifest (theme_color `#1D9E75`, icons 192/512/maskable/apple-touch), service worker strategy: app-shell precache, NetworkFirst for API responses with 5 s timeout, CacheFirst for static assets; no silent reload.
- **UX-DR27:** Implement responsive breakpoints (`sm` 0–599, `md` 600–899, `lg` 900–1199, `xl` ≥ 1200) with max-width 480 px centring at `md+`; desktop banner (*"Pour une expérience optimale, utilisez votre téléphone"*).
- **UX-DR28:** Implement IndexedDB offline event log UI (connectivity indicator pending count, stalled-sync banner per NFR-P7, manual retry affordance).

**French Locale & Formatting:**

- **UX-DR29:** Implement FCFA currency formatter (non-breaking space thousands separator, NFR-L3) in `src/lib/format/currency.ts`.
- **UX-DR30:** Implement French date formatter (fr-FR locale, 24-hour, WAT display; UTC storage) in `src/lib/format/date.ts`.
- **UX-DR31:** Implement Senegalese phone validator with Zod refinement + `+221` prefix input UX in `src/lib/validators/phoneNumber.ts`.
- **UX-DR32:** Externalise every user-facing string into `src/i18n/fr.json` with typed key enum; no inline strings in JSX.

**Field Testing (Pilot):**

- **UX-DR33:** Implement pilot field-shadowing instrumentation (ad-hoc usability issue logging in `audit_log` with `event_type='ux.friction_observed'`).
- **UX-DR34:** Implement saver sampled survey SMS at day-15 of first cycle (post-deployment, not a feature per se but a pilot workflow to define).

### FR Coverage Map

Every MVP FR is mapped to a specific epic. FR2 is reserved (removed in v1.2). FR38 and FR39 are Growth-phase, explicitly out of MVP epic scope.

| FR | Epic | Note |
|---|---|---|
| FR1 | Epic 1 | Sign-in phone-OTP |
| FR2 | — | Reserved (removed v1.2) |
| FR3 | Epic 1 | Returning sign-in |
| FR4 | Epic 1 | Sign-out |
| FR5 | Epic 1 (built once, dedicated re-auth Edge Function story); consumed by Epic 2 (bulk delete), Epic 7 (settlement), Epic 9 (export) | Cross-cutting re-auth gate — implemented once, gated per consumer |
| FR6 | Epic 1 | Idle session expiry |
| FR7 | Epic 2 | Create member manually |
| FR8 | Epic 2 | Bulk import via device contacts (opt-in) |
| FR9 | Epic 2 | Revoke contacts permission |
| FR10 | Epic 2 | Edit member with impact alert |
| FR11 | Epic 2 | Delete member with *"SUPPRIMER"* typed-confirmation (uses FR5 re-auth) |
| FR12 | Epic 2 | Cycle restart from member profile |
| FR13 | Epic 2 | Member 360 profile view |
| FR14 | Epic 2 | Search + status filter on member list |
| FR15 | Epic 3 | Cycle initiation |
| FR16 | Epic 3 | Day-N cycle-position tracking |
| FR17 | Epic 3 | Projection-balance formula |
| FR18 | Epic 3 (active/with-advance transitions); Epic 7 (settled transition) | Automatic status transitions |
| FR19 | Epic 3 | Prevent contributions post-completion |
| FR20 | Epic 3 | Identify cycles ending in upcoming window |
| FR21 | Epic 7 | Settlement initiation + payout display (uses FR5 re-auth) |
| FR22 | Epic 4 | Contribution capture (online happy path) |
| FR23 | Epic 4 | Rattrapage (multi-day catch-up) |
| FR24 | Epic 5 | Advance with situation-in-context + simulation |
| FR25 | Epic 5 | Motive capture + saver explicit acknowledgment |
| FR26 | Epic 4 (online queue) + Epic 8 (offline reconciliation) | Offline transaction capture spans both |
| FR27 | Epic 6 | Automatic SMS receipt dispatch |
| FR28 | Epic 6 | SMS content specification |
| FR29 | Epic 6 | WhatsApp secondary delivery (opt-in + provisioning dependent) |
| FR30 | Epic 6 | Public tokenized receipt URL page |
| FR31 | Epic 6 | First-SMS consent notice + opt-out mechanism |
| FR32 | Epic 6 (enforcement) + Epic 10 (opt-out action in data-rights surface) | Opt-out handling |
| FR33 | Epic 6 | Resend cycle history (support scenario) |
| FR33b | Epic 10 | Saver dispute flag from receipt URL |
| FR34 | Epic 9 | Dashboard real-time stats (polling 60 s) |
| FR35 | Epic 9 | Dashboard alerts dismissable |
| FR36 | Epic 6 | Per-transaction receipt share (OS share sheet + re-deliver) |
| FR37 | Epic 9 | CSV export of cycle + transaction history (uses FR5 re-auth) |
| FR38 | — (Growth — out of MVP scope) | Weekly/monthly auto-reports |
| FR39 | — (Growth — out of MVP scope) | PDF export |
| FR40 | Epic 8 | Offline transaction capture + member ops |
| FR41 | Epic 8 | Connectivity indicator (persistent top-bar pill) |
| FR42 | Epic 8 | Deterministic reconciliation on reconnect |
| FR43 | Epic 8 | Stalled-sync alert with manual retry |
| FR44 | Epic 1 (audit_log table + trigger + hash chain scaffold); enforced in every mutation epic (2, 3, 4, 5, 7, 8, 10) | Cross-cutting audit foundation |
| FR45 | Epic 1 (retention policy config) | Retention enforcement |
| FR46 | Epic 1 (RLS policies + automated isolation test gate) | Per-collector tenancy |
| FR47 | Epic 1 (Supabase Vault setup) | Column-level encryption |
| FR48 | Epic 10 | Saver anonymisation (right-to-deletion) |
| FR49 | Epic 1 (rate-limit middleware baseline on transaction-write endpoints) | Rate limiting |

## Epic List

Ten MVP epics organised around user value. Implementation order: **1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9 → 10.** Rationale: foundation first (auth + cycle + transaction), then saver-side differentiator (SMS) validated early, then advance and settlement close the cycle, then offline hardens the app, then visibility and compliance complete the MVP.

### Epic 1: Collector Onboarding & Sign-In

**Goal:** Ibrahim can open the app, sign in with his pre-provisioned phone number, and land in a functional authenticated session. This epic also establishes the cross-cutting platform foundation (project bootstrap, Supabase schema + RLS + Vault, audit log with hash chain, CI pipeline, re-auth Edge Function, rate limiting) that every subsequent epic depends on.

**FRs covered:** FR1, FR3, FR4, FR5 (dedicated re-auth Edge Function built here), FR6, FR44 (audit log scaffold), FR45 (retention config), FR46 (RLS policies), FR47 (Vault setup), FR49 (rate limits)

**Additional coverage:** AR1 (bootstrap), AR2 (Supabase Paris), AR3 (Cloudflare Pages), AR4 (schema migrations), AR5 (Vault), AR6 (RLS automated test), AR7 (audit trigger), AR11 (re-auth Edge Function), AR14 (CI pipeline), AR17 (CLAUDE.md), AR18 (Supabase Studio provisioning), AR19 (i18n scaffolding), AR21 (runbook initial)

**User outcome:** Ibrahim receives a WhatsApp link, opens the app URL, enters his phone, receives an OTP, signs in, and lands on an empty member list with a "*Ajouter mon premier membre*" CTA. The session persists 30 days with 30-min idle refresh.

### Epic 2: Member Lifecycle Management

**Goal:** Ibrahim can build and maintain his route of savers — adding members individually or in bulk via device contacts, editing with impact awareness, safely deleting with typed confirmation, browsing profiles with full history, and finding members instantly via search and status filters.

**FRs covered:** FR7, FR8, FR9, FR10, FR11 (consumes FR5 re-auth), FR12, FR13, FR14

**User outcome:** Ibrahim imports his 80 existing savers in under 25 minutes on his first-day onboarding, and can manage them confidently through every lifecycle moment.

### Epic 3: Cycle Engine & Progression

**Goal:** Every member's 30-calendar-day cycle progresses correctly and predictably, with zero-tolerance numeric accuracy. The cycle engine is a pure domain module with 100 % test coverage and property-based invariants. Status transitions and end-of-cycle alerts are automatic.

**FRs covered:** FR15, FR16, FR17, FR18 (active/with-advance transitions; settled transition in Epic 7), FR19, FR20

**Additional coverage:** AR15 (pure domain module), AR16 (cycle invariants ADR)

**User outcome:** Ibrahim sees his members' cycle days advance automatically; he's alerted on the dashboard when cycles are about to end; all projected balances are computed correctly at any point in time.

### Epic 4: Daily Transaction Capture (Core)

**Goal:** Ibrahim can record a daily contribution or a catch-up (rattrapage) transaction in under 5 seconds end-to-end. The `MemberActionSheet` + `ProgressiveToast` deliver the defining interaction of the product with its one-tap commit, haptic feedback, and truth-telling post-commit state evolution.

**FRs covered:** FR22, FR23, FR26 (online path; offline reconciliation completed in Epic 8)

**User outcome:** Ibrahim runs his daily route at his habitual cadence, one tap per contribution, receiving instant confirmation and observing the toast evolve as the saver's SMS is sent and delivered.

### Epic 5: Emergency Advance Flow

**Goal:** Ibrahim can grant an advance to a saver with full transparency — the `AdvanceSimulationPanel` shows the impact on projected final balance in real time before commit, the motive is captured, and the saver explicitly acknowledges the terms before the advance is recorded.

**FRs covered:** FR24, FR25

**User outcome:** Aminata asks for 75 000 FCFA for her cousin's wedding; Ibrahim shows her the exact number she'll receive at day 30; she agrees; the advance is recorded with dignity and no future argument.

### Epic 6: Saver Trust Communications

**Goal:** Every saver receives verifiable SMS proof of every transaction within 60 seconds, delivered via Termii with a durable commitment pattern (queue + retry + status propagation). The receipt URL renders without JavaScript on any browser for verification. Consent at first contact, respectful opt-out, re-deliverable on request.

**FRs covered:** FR27, FR28, FR29, FR30, FR31, FR32 (enforcement), FR33, FR36

**Additional coverage:** AR9 (SMS pipeline), AR10 (receipt URL Worker)

**User outcome:** Fatou receives a SMS on her Nokia within seconds of every payment; she can show it to her niece who opens the receipt URL on a smartphone to verify. Her trust in Ibrahim quietly upgrades from *"he is honest"* to *"he is verifiable"*.

### Epic 7: Cycle Settlement Ceremony

**Goal:** Ibrahim can close a completed cycle on day 30 with a deliberate, trust-ceremony flow. The `SettlementSummaryCard` shows the full math, OTP re-auth gates the commit, and the `EnvelopeHandoverScreen` crystallises the moment of trust with envelope-handover copy and a final SMS to the saver.

**FRs covered:** FR5 (consumes the Epic 1 re-auth Edge Function), FR21, FR18 (settled transition)

**User outcome:** Ibrahim clicks "Clôturer le cycle" for Awa, verifies the transactions, enters his OTP, sees the envelope-handover screen with *"Remettez 87 000 FCFA à Awa"*, hands over the cash, and both receive a final SMS confirming cycle closure.

### Epic 8: Offline Resilience

**Goal:** Ibrahim can work his entire daily route seamlessly on spotty 3G — transactions captured offline are queued in IndexedDB, the connectivity indicator communicates state with dignity (never alarm), and the reconciler replays operations deterministically on reconnect with zero data loss.

**FRs covered:** FR40, FR41, FR42, FR43, FR26 (offline aspect)

**Additional coverage:** AR8 (event-sourced sync layer)

**User outcome:** Ibrahim spends six hours at Tilène market with no signal; he keeps entering transactions; the badge shows *"Hors-ligne — 47 en attente"*; when he gets home, everything syncs in under 90 seconds and every SMS receipt goes out.

### Epic 9: Dashboard & Activity Visibility

**Goal:** Ibrahim sees his business performance at a glance on the dashboard home — active members, today's collection, commission earned, cycles ending alerts — and can export his cycle + transaction history as CSV for his accountant.

**FRs covered:** FR34, FR35, FR37 (consumes FR5 re-auth for export)

**User outcome:** Ibrahim opens the app each morning and immediately sees where he stands — how many members are active, how much he collected yesterday, which cycles need his attention this week.

**Note — Growth deferred:** FR38 (weekly/monthly auto-reports) and FR39 (PDF export) are explicitly Growth-phase and are not part of this MVP epic. They will be addressed in a future Growth epic.

### Epic 10: Saver Dispute Flow & Data Rights

**Goal:** Savers can flag disputed transactions via the receipt URL page (FR33b — the product's sharpest trust-protection feature) and exercise their UEMOA data-protection rights (right-to-deletion via anonymisation). Notifications route to the collector (in-app) and the founder (email + push) with compassionate-acknowledgment UX.

**FRs covered:** FR32 (opt-out action surface), FR33b, FR48

**Additional coverage:** AR12 (dispute-notify Edge Function), AR13 (saver anonymisation Edge Function)

**User outcome:** A saver who sees a suspicious transaction on her receipt URL can tap *"Cette transaction n'est pas moi"* and trust that the signal reaches both Ibrahim and the founder within minutes — with a compassionate acknowledgment screen reassuring her that she will be heard. Separately, any saver can request deletion of her personal data, which the system honours via anonymisation while preserving the audit trail for regulatory obligations.

### Epic Dependency Graph

```
Epic 1 (foundation) ←─── prerequisite of all
    │
    ├── Epic 2 (members) ←── prerequisite of 3, 4, 5, 6, 7, 8
    │       │
    │       └── Epic 3 (cycle engine) ←── prerequisite of 4, 5, 7, 9
    │               │
    │               ├── Epic 4 (transaction core) ←── prerequisite of 6, 8
    │               │       │
    │               │       ├── Epic 6 (saver SMS) ←── prerequisite of 10 (dispute builds on receipts)
    │               │       │       │
    │               │       │       └── Epic 10 (dispute + data rights)
    │               │       │
    │               │       └── Epic 8 (offline) ←── adds resilience layer to 4
    │               │
    │               ├── Epic 5 (advance) — parallel-buildable after Epic 4
    │               │
    │               └── Epic 7 (settlement) — can ship after Epic 3 if Epic 4 exists
    │
    └── Epic 9 (dashboard) — parallel-buildable, reads from 2 + 3 + 4 data
```

Every epic is standalone for its user-value domain (Principle #5 — dependency-free within epic). Cross-epic dependencies are additive: Epic 8 extends Epic 4 without reorganising it; Epic 10 extends Epic 6 by adding the dispute path without touching the core receipt flow.

## Epic 1: Collector Onboarding & Sign-In

Ibrahim can open the app, sign in with his pre-provisioned phone number, and land in a functional authenticated session. This epic also establishes the cross-cutting platform foundation every subsequent epic depends on.

### Story 1.1: Project bootstrap and CI skeleton

As a developer,
I want the SafariCash project bootstrapped with Vite + React 18 + TypeScript + Tailwind + Vite PWA + shadcn/ui + CI pipeline,
So that every subsequent story has a working foundation to build on.

**Acceptance Criteria:**

**Given** an empty repository,
**When** the bootstrap sequence from `architecture.md § Starter Template Evaluation` is executed (16 commands),
**Then** the repository contains a runnable Vite dev server,
**And** `npm run build` produces a Cloudflare-Pages-deployable `dist/` artefact,
**And** `npm run test` passes with the initial smoke test,
**And** GitHub Actions CI runs lint + type-check + tests on every PR and blocks merge on failure,
**And** the repository structure matches the project tree defined in `architecture.md § Project Structure`.

### Story 1.2: Supabase backend, schema, RLS, Vault, and audit-log foundation

As a developer,
I want the Supabase project provisioned with the full MVP schema, RLS policies, Vault encryption, and hash-chained audit log,
So that every downstream epic operates on a secure, tenant-isolated, auditable data layer.

**Acceptance Criteria:**

**Given** a fresh Supabase project in eu-west-3 (Paris),
**When** the migration sequence (`supabase/migrations/*.sql`) is applied,
**Then** tables `users`, `members`, `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes` exist with snake_case naming per `architecture.md § Naming Patterns`,
**And** RLS policies enforce per-collector isolation on every user-owned table,
**And** Supabase Vault is configured to encrypt `members.name`, `members.phone_number`, and `transactions.amount` at the column level,
**And** a Postgres trigger emits an immutable hash-chained entry into `audit_log` for every INSERT / UPDATE / DELETE on `members`, `transactions`, `cycles`,
**And** an automated RLS-isolation test (`tests/e2e/rls-isolation.spec.ts`) verifies no collector can read another collector's rows,
**And** the RLS-isolation test failure blocks the GitHub Actions release pipeline.

### Story 1.3: Re-auth Edge Function (built once, consumed many times)

As a developer,
I want a single Edge Function that issues and verifies SMS OTP for sensitive operations,
So that every epic requiring re-authentication (FR5) consumes the same hardened primitive.

**Acceptance Criteria:**

**Given** an authenticated collector requesting a sensitive operation,
**When** the collector's client POSTs to `/functions/v1/re-auth` with the operation intent,
**Then** the Edge Function issues a fresh SMS OTP via Termii and returns a short-lived challenge token,
**And** the challenge token is valid for 5 minutes and single-use,
**When** the collector submits the OTP with the challenge token,
**Then** the Edge Function validates the OTP, returns a scoped confirmation,
**And** after 3 failed OTP attempts the endpoint returns a 429 with a 5-minute lockout,
**And** every challenge issue / verify / lockout event is recorded in `audit_log`.

### Story 1.4: Rate-limit middleware on transaction-write endpoints

As a security engineer,
I want per-collector rate limits on transaction-write endpoints,
So that a compromised credential cannot flood the system with fraudulent writes (NFR-S9).

**Acceptance Criteria:**

**Given** an authenticated collector,
**When** the collector issues more than 100 transaction-write requests in 60 seconds,
**Then** subsequent requests in that window return HTTP 429 with `Retry-After` header,
**And** the collector can retry after the limit window resets,
**And** the rate-limit counter is keyed by `collector_id` (not IP),
**And** rate-limit events are logged (`ratelimit.exceeded` event type).

### Story 1.5: Phone-OTP sign-in flow

As a collector (Ibrahim),
I want to sign in to my pre-provisioned account with my phone number and a one-time SMS code,
So that I can access the app and start managing my members (FR1, FR3).

**Acceptance Criteria:**

**Given** a valid pre-provisioned phone number,
**When** the collector opens the app and enters their phone,
**Then** the app validates the format and enables the "Recevoir le code" button,
**And** tapping the button calls Supabase Auth phone-OTP provider to send an SMS,
**When** the collector enters the 6-digit OTP,
**Then** the app verifies via Supabase Auth and establishes a session,
**And** on successful first-login, the app lands on a member-list empty state (Empty State component),
**And** on subsequent logins, the app lands on the dashboard,
**Given** a non-registered phone number,
**When** the collector taps "Recevoir le code",
**Then** the app displays a dead-end screen with the message *"Ce numéro n'est pas enregistré chez SafariCash. Contactez-nous au 77 791 58 98 pour démarrer"* and a tel: link CTA,
**Given** 3 failed OTP attempts within one session,
**When** the collector attempts a 4th,
**Then** the app shows a 5-minute lockout message and disables the resend button.

### Story 1.6: Session management with idle timeout and refresh

As a collector,
I want my session to persist across app reloads but expire after periods of inactivity,
So that I don't have to sign in every time and my account is protected if I leave my phone unattended (FR6, NFR-S4).

**Acceptance Criteria:**

**Given** a collector signed in to the app,
**When** 30 minutes of idle time elapse (no user interaction),
**Then** the session is marked idle and a toast prompts *"Session expirée, reconnectez-vous"*,
**And** the collector is redirected to the login screen,
**Given** a collector signed in and actively using the app,
**When** the 30-minute idle window is reset by any user interaction,
**Then** the session refreshes silently (Supabase Auth token refresh),
**Given** an absolute session lifetime of 30 days,
**When** 30 days have elapsed since the initial sign-in,
**Then** the session is invalidated regardless of activity and the collector is prompted to re-sign-in.

### Story 1.7: Sign-out

As a collector,
I want to sign out of the app at any time,
So that I can protect my account when sharing a device or finishing for the day (FR4).

**Acceptance Criteria:**

**Given** a collector with an active session,
**When** the collector taps "Se déconnecter" in the Plus / Settings tab,
**Then** the app clears the Supabase Auth session and local cache,
**And** the collector is redirected to the login screen,
**And** IndexedDB data tied to the session is purged,
**And** a `session.signed_out` event is emitted to the audit log.

### Story 1.8: CI pipeline green on lint + type-check + tests + isolation gate

As a tech lead,
I want the CI pipeline to enforce quality gates on every PR,
So that no merge introduces lint errors, type errors, test failures, or RLS isolation violations.

**Acceptance Criteria:**

**Given** a PR opened against `main`,
**When** GitHub Actions runs the `ci.yml` workflow,
**Then** the pipeline runs in order: install, lint (eslint + prettier + jsx-a11y), type-check (`tsc --noEmit`), unit tests (Vitest), E2E tests (Playwright), accessibility assertions (axe-core), RLS isolation test,
**And** any failing step blocks the merge,
**And** a successful run produces a Cloudflare Pages preview URL posted to the PR.

## Epic 2: Member Lifecycle Management

Ibrahim can build and maintain his route of savers — adding members individually or in bulk, editing with impact awareness, safely deleting with typed confirmation, browsing profiles with full history, and finding members instantly.

### Story 2.1: Display member list with search and status filters

As a collector,
I want to see my full list of members with instant search and status filtering,
So that I can find any member in seconds, even with 150+ active members (FR14, NFR-P2).

**Acceptance Criteria:**

**Given** a collector with 0 members,
**When** the member list route loads,
**Then** the Empty State component displays with the *"Ajouter mon premier membre"* CTA,
**Given** a collector with N members,
**When** the member list loads,
**Then** all members are displayed as cards with name, daily amount, cycle progress bar, and status badge,
**And** the list is sorted by recency of last interaction (most recent first),
**When** the collector types into the search box,
**Then** the list filters instantly (no submit button) and results render in p95 ≤ 300 ms,
**When** the collector taps a status filter chip (Actif / Avance / Terminé),
**Then** the list is further filtered to that status,
**And** multiple filter chips apply additively (OR semantics).

### Story 2.2: Create a member manually

As a collector,
I want to add a member by entering their name, phone, and daily contribution amount,
So that I can start a cycle for a new saver on my route (FR7).

**Acceptance Criteria:**

**Given** an authenticated collector on the member-creation screen,
**When** the collector enters a name, optional phone, and daily amount then taps "Ajouter ce Membre",
**Then** the member is persisted with `created_via: manual`,
**And** a cycle is initiated for the member (day 1 of 30, status `active`),
**And** a `member.created` event is emitted to `audit_log`,
**And** the collector is returned to the member list with the new member at the top (recency-sorted),
**Given** an invalid form state (empty name, malformed phone, non-integer amount),
**When** the collector attempts submit,
**Then** the form displays inline validation errors and the submit button remains disabled.

### Story 2.3: Bulk-import members via device contacts (opt-in)

As a collector,
I want to import multiple members from my phone's contacts in a single flow,
So that I can onboard 50+ savers quickly on my first day (FR8, FR9).

**Acceptance Criteria:**

**Given** the member list is displayed,
**When** the collector taps "Importer depuis les contacts",
**Then** a consent screen explains that contacts are read only locally and that no data leaves the device until confirmed,
**When** the collector grants Contacts permission,
**Then** the app reads the device contacts locally and presents a multi-select picker,
**When** the collector selects multiple contacts and assigns a daily amount to each,
**Then** tapping "Confirmer l'import" creates the selected members with `created_via: contacts_import`,
**And** each member triggers its own `member.created` audit event,
**Given** a collector who has granted Contacts permission,
**When** the collector taps "Révoquer l'accès aux contacts" in settings,
**Then** the Contacts permission is cleared and the import path is disabled until re-granted.

### Story 2.4: View member 360 profile with transaction history

As a collector,
I want to see a full profile view for each member with contributed total, projected balance, outstanding advances, and complete transaction history,
So that I can answer any saver question on the spot and resolve disputes quickly (FR13).

**Acceptance Criteria:**

**Given** a member exists in the collector's list,
**When** the collector taps the member's row,
**Then** the member profile opens with: avatar, name, phone, daily amount, cycle day (N of 30), cumulative contributed, outstanding advances, projected final balance,
**And** below the header, a chronological list of every transaction (contribution / rattrapage / advance) with timestamp and amount,
**When** the collector taps a transaction in the history,
**Then** that transaction's receipt detail opens with share / re-deliver actions.

### Story 2.5: Edit a member with impact alert

As a collector,
I want to edit a member's name, phone, or daily amount, with a warning when edits affect an in-flight cycle,
So that I correct mistakes without silently breaking existing cycle math (FR10).

**Acceptance Criteria:**

**Given** a member with an active cycle,
**When** the collector opens the member edit screen and modifies the daily amount,
**Then** a warning banner displays *"Cette modification affectera le cycle en cours. Les projections vont être recalculées."*,
**And** the Save button requires explicit tap to confirm,
**When** the collector saves the changes,
**Then** the updated fields persist and a `member.updated` event records the before/after state in `audit_log`,
**Given** edits to name or phone only (not daily amount),
**When** the collector saves,
**Then** the change applies immediately without a warning banner (cycle math is unaffected).

### Story 2.6: Delete a member with typed "SUPPRIMER" confirmation and re-auth

As a collector,
I want deletion of a member to require a typed "SUPPRIMER" confirmation and a re-auth OTP,
So that accidental or unauthorized deletions are impossible (FR11, consumes FR5 re-auth).

**Acceptance Criteria:**

**Given** a member profile,
**When** the collector taps "Supprimer définitivement" in the danger zone,
**Then** a confirmation dialog displays the member's avatar, name, and a summary of data to be deleted,
**And** a text input requires the collector to type exactly `SUPPRIMER` (case-insensitive),
**When** the collector types "SUPPRIMER" and taps the delete CTA,
**Then** the flow triggers the re-auth Edge Function (Story 1.3) for OTP verification,
**When** OTP is verified,
**Then** the member row is hard-deleted and a `member.deleted` event records the final state in `audit_log`,
**And** saver PII is subject to retention / anonymisation policy per Epic 10,
**Given** the collector has typed the wrong word,
**When** they tap the delete CTA,
**Then** the button remains disabled.

### Story 2.7: Restart cycle for a completed member

As a collector,
I want to restart a new 30-day cycle for a member who has completed the previous one,
So that returning savers can continue with me without me re-creating them (FR12).

**Acceptance Criteria:**

**Given** a member with `cycle.status = completed`,
**When** the collector taps "Redémarrer le cycle",
**Then** a new cycle is initiated (day 1 of 30, status `active`),
**And** a `cycle.started` event records the new cycle in `audit_log`,
**And** the member's completed cycle history remains visible in the profile,
**Given** a member with `cycle.status = active` or `with_advance`,
**When** the collector navigates to the member profile,
**Then** the "Redémarrer le cycle" action is hidden (cycle is not restartable mid-flight).

## Epic 3: Cycle Engine & Progression

Every member's 30-calendar-day cycle progresses correctly, automatically, and predictably, with zero-tolerance numeric accuracy.

### Story 3.1: Cycle-invariants ADR

As a tech lead,
I want the cycle-engine property-based test invariants defined in `docs/ADR/004-cycle-invariants.md` before the engine is coded,
So that implementation is guided by explicit correctness rules (AR16).

**Acceptance Criteria:**

**Given** the ADR template,
**When** the ADR is written,
**Then** it enumerates at minimum the following invariants: (a) projected balance monotonicity, (b) settled balance ≡ projected balance at day 30 for fully-paid cycles, (c) advance sum ≤ projected available balance, (d) commission invariant (exactly 1 × daily_amount),
**And** each invariant has a corresponding property test skeleton referenced by name.

### Story 3.2: Pure cycle engine module with 100% unit and property-based test coverage

As a developer,
I want a pure domain module (`src/domain/cycle/cycleEngine.ts`) computing projections and settlement math with zero infrastructure imports,
So that cycle correctness is independently testable and portable (FR15, FR16, FR17, NFR-R3).

**Acceptance Criteria:**

**Given** the cycle engine module,
**When** `computeProjectedFinalBalance(dailyAmount, contributionsSoFar, advancesSoFar, cycleDay)` is called,
**Then** it returns `(dailyAmount × 30) − (1 × dailyAmount) − Σ(advances)` in FCFA as an integer,
**And** all invariants from ADR-004 are verified via fast-check (property-based testing),
**And** test coverage on `src/domain/cycle/` is ≥ 100 %, gated by `vitest --coverage` in CI,
**And** the engine has no imports from `src/infrastructure/`, `src/features/`, or React.

### Story 3.3: Automatic cycle status transitions (active / with-advance)

As a collector,
I want a member's cycle status to transition automatically between *active* and *with-advance*,
So that the status badge always reflects reality without manual updates (FR18 partial — settled transition in Epic 7).

**Acceptance Criteria:**

**Given** a member with cycle status `active`,
**When** an advance is recorded for that member,
**Then** the status transitions to `with_advance` atomically,
**And** a `cycle.transitioned` event records the new status,
**Given** a member with status `with_advance`,
**When** all outstanding advances are reconciled (e.g., overturned by dispute) — not expected in MVP,
**Then** the status reverts to `active` (reserved behaviour, not MVP-required).

### Story 3.4: Prevent contributions against a completed cycle

As a collector,
I want the system to reject new contributions on a member whose cycle has completed,
So that day-31+ entries don't silently corrupt a settled cycle (FR19).

**Acceptance Criteria:**

**Given** a member with cycle status `completed`,
**When** the collector attempts to record a contribution,
**Then** the API returns 409 Conflict with an RFC 7807 problem detail,
**And** the UI displays *"Le cycle est clôturé. Redémarrez-en un nouveau pour reprendre les cotisations."*,
**And** the Primary CTA on the member action sheet is disabled with an explanatory tooltip.

### Story 3.5: Identify and surface cycles ending within upcoming window

As a collector,
I want the dashboard to alert me when cycles are about to complete,
So that I can plan settlements and avoid being caught off-guard (FR20).

**Acceptance Criteria:**

**Given** a configurable window (default 7 days),
**When** the dashboard loads,
**Then** a "Cycles se terminant cette semaine" alert displays the count of members whose cycle day is within the window,
**When** the collector taps the alert,
**Then** the member list filters to those members in the upcoming-end window,
**And** the alert is dismissible per-session (reappears on next app load).

## Epic 4: Daily Transaction Capture (Core)

Ibrahim can record a daily contribution or a catch-up (rattrapage) transaction in under 5 seconds.

### Story 4.1: MemberActionSheet component with pre-filled amount

As a developer,
I want a reusable `MemberActionSheet` component that opens as a bottom-sheet with the member's pre-suggested amount,
So that the defining interaction of the product (Flow 1) is implemented as a single component consumed by transaction capture (UX-DR6).

**Acceptance Criteria:**

**Given** a member tapped from the list,
**When** the action sheet opens,
**Then** it displays the member avatar, name, and a primary CTA with the amount pre-filled (*"Enregistrer cotisation — 5 000 FCFA"*),
**And** below the primary CTA, three secondary links: *"Rattrapage"*, *"Prêt"*, *"Montant personnalisé"*,
**And** the list behind the sheet remains visible,
**And** tapping outside, dragging down, or ESC dismisses the sheet,
**And** focus is trapped inside the sheet while open (Radix Dialog behaviour).

### Story 4.2: ProgressiveToast component with state contract

As a developer,
I want a `ProgressiveToast` component that exposes evolving transaction state to the user honestly,
So that the collector always knows whether a transaction is queued, syncing, confirmed, or failed — never a silent optimistic lie (UX-DR8).

**Acceptance Criteria:**

**Given** a transaction just committed locally,
**When** the toast appears,
**Then** the initial state is "Cotisation enregistrée" with a 5-second undo affordance,
**When** the 5-second window elapses,
**Then** the undo affordance hides and the state transitions to "Envoi du reçu..." with a spinner,
**When** Termii confirms SMS delivery,
**Then** the state transitions to "Reçu délivré ✓" and auto-dismisses 3 seconds later,
**Given** offline state,
**When** the toast appears,
**Then** the state is "Hors-ligne — envoi au prochain réseau" and remains until reconnection,
**Given** terminal SMS failure,
**When** the toast state updates,
**Then** the state becomes "Échec de l'envoi — retenter" with a manual retry action.

### Story 4.3: Record contribution (online commit path)

As a collector,
I want to tap a member, confirm the pre-filled amount, and commit a contribution in under 5 seconds,
So that I run a 150-member daily route efficiently (FR22, NFR-P1).

**Acceptance Criteria:**

**Given** an online collector on a member action sheet,
**When** the collector taps the primary CTA,
**Then** a `transaction` row is inserted via PostgREST with `kind = contribution`,
**And** the Postgres trigger appends an audit-log event and enqueues an entry in `sms_queue`,
**And** the Progressive Toast displays,
**And** the member row reorders to the top of the list (recency sort),
**And** the total elapsed time from app-open to toast-shown is p95 ≤ 5 s on a mid-range Android on 3G,
**And** the undo affordance on the toast reverses the transaction within 5 s (event-sourced rollback).

### Story 4.4: Record rattrapage (multi-day catch-up)

As a collector,
I want to record a rattrapage transaction that covers one or more missed days,
So that I handle the real-world case where a saver couldn't pay on a given day (FR23).

**Acceptance Criteria:**

**Given** a member action sheet,
**When** the collector long-presses the primary CTA,
**Then** a radial menu or inline expansion reveals options "× 2 jours", "× 3 jours", "× 4 jours",
**When** the collector selects one,
**Then** the rattrapage is recorded as a single `transaction` with `kind = rattrapage` and `days_covered = N`,
**And** the amount is `dailyAmount × N`,
**And** the SMS receipt text indicates "Rattrapage — N jours",
**Given** the rattrapage would cover days beyond the cycle's remaining days,
**When** the collector attempts the action,
**Then** the options list grays out the invalid multi-day options.

### Story 4.5: Undo a just-committed transaction within 5 seconds

As a collector,
I want to cancel an accidental transaction within 5 seconds of commit,
So that a wrong tap doesn't force me into the edit-and-audit flow (FR22 support).

**Acceptance Criteria:**

**Given** a transaction just committed,
**When** the Progressive Toast is visible with the "Annuler" action,
**And** the collector taps "Annuler" within 5 seconds,
**Then** the transaction is reversed via an event-sourced undo (inserts a compensating event, not a hard delete),
**And** the `sms_queue` entry for that transaction is cancelled before dispatch,
**And** a `transaction.undone` event is emitted to `audit_log`,
**Given** 5 seconds elapse,
**When** the collector taps "Annuler",
**Then** the action is unavailable and the UI redirects the collector to the member profile's transaction-edit flow (which requires a separate audit entry).

## Epic 5: Emergency Advance Flow

Ibrahim can grant advances to savers with transparent impact on the final balance.

### Story 5.1: AdvanceSimulationPanel component with client-side real-time computation

As a developer,
I want a reusable `AdvanceSimulationPanel` component that computes and displays the impact of an advance on projected final balance in real time,
So that the collector can show the saver the exact number before commit (UX-DR7, NFR-P5).

**Acceptance Criteria:**

**Given** a member with known `dailyAmount`, `contributionsSoFar`, `advancesSoFar`, `cycleDay`,
**When** the panel renders with a candidate advance amount,
**Then** it displays 4 rows: Total cycle projected, Commission, Advance (in destructive colour), Projected final balance (large, primary-green),
**When** the collector modifies the candidate amount,
**Then** rows 3 and 4 update within one animation frame (≤ 16 ms, NFR-P5),
**Given** the candidate amount exceeds the projected available balance,
**When** the panel renders,
**Then** row 3 displays a warning style and row 4 shows 0 FCFA with an explanatory note.

### Story 5.2: Advance flow with situation-in-context panel

As a collector,
I want a dedicated advance flow that first shows the member's current situation (day, contributed, existing advances) before I enter an amount,
So that I grant advances with full context (FR24).

**Acceptance Criteria:**

**Given** the collector taps "Prêt" from a member action sheet,
**When** the advance flow opens,
**Then** a situation panel at the top displays: cycle day of 30, contributed so far (FCFA), existing advances (FCFA),
**And** suggested amounts appear as quick-tap chips (50 000 / 100 000 / 150 000 FCFA),
**And** a free-form amount input accepts custom values,
**And** the AdvanceSimulationPanel updates as the amount is entered.

### Story 5.3: Motive capture and saver acknowledgment

As a collector,
I want the advance flow to require a free-text motive and an explicit saver acknowledgment before commit,
So that every advance is traceable to a reason and the saver has explicitly agreed (FR25).

**Acceptance Criteria:**

**Given** an amount entered in the advance flow,
**When** the collector attempts to tap the primary CTA,
**Then** the CTA is disabled until: (a) a motive is entered (min 3 characters), AND (b) the saver-acknowledgment checkbox is ticked (*"J'ai compris que ce prêt réduit mon solde final"*),
**And** the checkbox is not pre-checked,
**When** both conditions are met,
**Then** the primary CTA enables.

### Story 5.4: Commit advance transaction with audit entry

As a collector,
I want the advance commit to persist the transaction, update the cycle status, and trigger SMS dispatch,
So that the advance is recorded and the saver is notified (FR24 commit path).

**Acceptance Criteria:**

**Given** a valid advance flow with motive + acknowledgment,
**When** the collector taps the primary CTA,
**Then** a `transaction` row is inserted with `kind = advance`, `amount`, `motive`, `saver_acknowledged = true`,
**And** the audit-log event records the motive and acknowledgment state,
**And** the member's cycle status transitions to `with_advance` (if previously `active`),
**And** the SMS queue enqueues a receipt including the advance amount and updated projected final balance,
**And** the Progressive Toast displays "Prêt accordé" with the same state evolution contract as Story 4.2.

## Epic 6: Saver Trust Communications

Every saver receives verifiable SMS proof of every transaction within 60 seconds.

### Story 6.1: SMS dispatch Edge Function (operates on `sms_queue` created in Story 1.2)

As a developer,
I want a durable SMS commitment pattern implemented as a dispatch Edge Function that enqueues receipts into the `sms_queue` table created in Story 1.2,
So that no transaction's SMS is ever lost to a transient SMS gateway failure (AR9, FR27, NFR-R4).

**Acceptance Criteria:**

**Given** a transaction commit (contribution, rattrapage, advance),
**When** the Postgres trigger fires,
**Then** a row is inserted into `sms_queue` with the transaction id, saver phone, template key, and status `pending`,
**And** the row includes a `retry_count`, `next_retry_at`, `delivered_at`, and `abandoned_at` fields,
**And** the dispatch Edge Function (`/functions/v1/sms-dispatch`) is callable to manually enqueue (e.g., for re-send scenarios).

### Story 6.2: SMS worker with Termii + exponential backoff + status propagation

As a developer,
I want a scheduled SMS worker that drains `sms_queue`, calls Termii, records delivery status, and retries on failure with exponential backoff,
So that SMS delivery is reliable and the UI can expose progressive state (NFR-R4, NFR-P4).

**Acceptance Criteria:**

**Given** `sms_queue` rows with status `pending`,
**When** the worker (`/functions/v1/sms-worker`, scheduled every 30 s) runs,
**Then** it pops rows in FIFO order, calls Termii, and updates status to `sent` / `failed` / `abandoned`,
**And** on Termii failure the row is scheduled with exponential backoff (10 s → max 10 min),
**And** after 24 hours of continuous failure the row is marked `abandoned`,
**And** every status transition emits an `sms.*` audit event,
**And** p95 time from `pending` insertion to `delivered_at` timestamp is ≤ 60 s (NFR-P4).

### Story 6.3: SMS copy templates (first, subsequent, settlement, dispute ack)

As a developer,
I want French copy templates for every SMS the system sends (first receipt with consent, subsequent receipts, settlement, dispute acknowledgement),
So that saver-facing language is consistent and compliant with NFR-S10 (UX-DR14–17).

**Acceptance Criteria:**

**Given** a first-ever SMS to a saver phone,
**When** the template renders,
**Then** it includes: short greeting, amount received, cycle day, projected final balance, receipt URL, plain opt-out instruction, tracker-not-mover disclosure,
**And** the body is ≤ 160 characters or uses 2-segment SMS only if necessary,
**Given** a subsequent SMS to the same saver phone,
**When** the template renders,
**Then** it omits the greeting and the consent disclosure, keeping only the transactional data (amount, cycle day, projected, receipt URL),
**And** the body is ≤ 160 characters (1-segment),
**Given** any SMS,
**When** the body is rendered,
**Then** it contains only 7-bit ASCII / GSM-7 characters (no emoji, NFR-A6),
**And** no banking language (*"compte"*, *"dépôt"*, *"garanti"*) appears (NFR-S10).

### Story 6.4: Receipt URL Cloudflare Worker with no-JS baseline

As a saver,
I want to open the URL in my SMS on any browser, including older feature phones' browsers, and see my transaction details rendered without JavaScript,
So that I can always verify my receipt regardless of device (FR30, UX-DR19).

**Acceptance Criteria:**

**Given** a token-based URL `/r/{token}`,
**When** a GET request hits the Cloudflare Worker,
**Then** the Worker looks up the receipt by token (via Supabase service role) and renders a semantic HTML page,
**And** the page includes: amount, date/time, cycle day, projected final balance, and the dispute CTA,
**And** the page works without JavaScript (all content server-rendered),
**And** the token is not sequential and has ≥ 128 bits of entropy (NFR-S3),
**Given** a token not found or expired,
**When** the Worker responds,
**Then** it returns a 404 with a plain-text explanation.

### Story 6.5: First-SMS consent notice and opt-out mechanism

As a saver,
I want the first SMS I receive to explain what SafariCash is and how I can opt out,
So that I consent to receiving further SMS under UEMOA data protection (FR31).

**Acceptance Criteria:**

**Given** the first SMS ever sent to a saver phone,
**When** the saver replies with `STOP`,
**Then** the system flags the saver as opted-out in the `members.sms_opt_out` column,
**And** no further SMS are dispatched for any transaction involving that saver,
**And** an `sms.opt_out` audit event is recorded,
**Given** the receipt URL page,
**When** the saver taps an explicit opt-out link,
**Then** the same opt-out flag is set via an API call to the Cloudflare Worker.

### Story 6.6: Resend full cycle history to saver (support scenario)

As a collector (or support agent on behalf of),
I want to re-deliver a saver's full cycle history as SMS,
So that a saver who lost SMS or changed phones can recover their proof (FR33).

**Acceptance Criteria:**

**Given** a saver with transactions in a cycle,
**When** the collector triggers "Renvoyer l'historique" from the member profile,
**Then** the system enqueues one SMS per historical transaction (or a summary SMS per template),
**And** each resent SMS includes a clear note *"Rappel — transaction du {date}"*,
**And** the resend action requires a re-auth OTP (FR5),
**And** all resend actions are recorded in the audit log.

### Story 6.7: Per-transaction receipt share and re-deliver from member profile

As a collector,
I want to share or re-deliver any single transaction receipt from the member profile,
So that I can help a saver who needs a proof of one specific payment (FR36).

**Acceptance Criteria:**

**Given** a transaction in a member's history,
**When** the collector taps on the transaction,
**Then** the receipt detail opens with a "Partager" button (OS share sheet) and a "Renvoyer par SMS" button,
**When** the collector taps "Renvoyer par SMS",
**Then** the system enqueues a single SMS with the transaction's receipt content,
**And** a `sms.resend` audit event is recorded.

### Story 6.8: WhatsApp Business secondary delivery (opt-in savers, provisioning-dependent)

As a saver with a smartphone,
I want to receive my SafariCash receipts via WhatsApp if I've opted in,
So that the receipts land in my preferred messaging channel (FR29).

**Acceptance Criteria:**

**Given** the WhatsApp Business channel is provisioned for the SafariCash account,
**And** a saver has opted in (`members.whatsapp_opt_in = true`),
**When** a receipt is dispatched,
**Then** the message is sent via WhatsApp in addition to SMS,
**And** the WhatsApp delivery status is recorded separately in `sms_queue`,
**Given** WhatsApp is not yet provisioned,
**When** a receipt is dispatched,
**Then** only SMS is sent (no failure, no retry, no error logged for the missing WhatsApp).

## Epic 7: Cycle Settlement Ceremony

Ibrahim can close a completed cycle on day 30 and pay out the saver with full transparency.

### Story 7.1: SettlementSummaryCard component

As a developer,
I want a `SettlementSummaryCard` component that displays the full settlement math for a member's completed cycle,
So that the collector and saver can review the numbers together before commit (UX-DR9).

**Acceptance Criteria:**

**Given** a member with `cycle.status = completed`,
**When** the settlement summary card renders,
**Then** it displays: member avatar + name + cycle date range, a 4-row breakdown (contributions total / commission / advances / final payout), and CTAs "Vérifier les transactions" (secondary) and "Confirmer et clôturer" (primary),
**When** the collector taps "Vérifier les transactions",
**Then** a drill-down opens the full transaction list for that cycle (same as Story 2.4 content),
**And** a back navigation returns to the settlement card unchanged.

### Story 7.2: EnvelopeHandoverScreen component

As a developer,
I want an `EnvelopeHandoverScreen` component that crystallises the day-30 moment of trust,
So that the settlement climax is a ceremony, not a form submission (UX-DR10).

**Acceptance Criteria:**

**Given** a successfully settled cycle,
**When** the handover screen renders,
**Then** it displays: a primary-green check-mark circle, the headline "Cycle clôturé", the amount to hand over (large font, `amount-large` token), the member name, a subtext confirming SMS dispatch, and a single CTA "Retour aux membres",
**And** no animation is flashy — restrained in the spirit of "Pride over playfulness" (UX Emotional Design Principles),
**And** focus lands on the CTA for one-tap dismiss.

### Story 7.3: Settlement initiation and computation

As a collector,
I want to initiate settlement from either a dashboard alert or the member profile, and see the computed final payout,
So that I can confidently close a cycle knowing the exact amount (FR21).

**Acceptance Criteria:**

**Given** a member with `cycle.status = completed`,
**When** the collector taps "Clôturer le cycle" from the member profile,
**Then** the SettlementSummaryCard opens with the final payout computed,
**And** the final payout equals `dailyAmount × 30 − dailyAmount (commission) − Σ(advances)`,
**And** the displayed payout matches to the franc any projected-final-balance shown on prior SMS receipts for the same cycle (NFR-R3 zero-tolerance).

### Story 7.4: Settlement commit gated by re-auth OTP

As a collector,
I want the settlement commit to require a fresh SMS OTP,
So that a moment of this consequence is protected against stolen-phone abuse (consumes FR5 re-auth).

**Acceptance Criteria:**

**Given** the SettlementSummaryCard is displayed,
**When** the collector taps "Confirmer et clôturer",
**Then** the re-auth flow (Story 1.3) is invoked,
**When** OTP is verified,
**Then** the settlement Edge Function (`/functions/v1/cycle-settlement`) is called with the scoped confirmation token,
**And** the cycle transitions to `settled` status atomically,
**And** a `cycle.settled` event is emitted to `audit_log` with the final payout amount,
**And** the EnvelopeHandoverScreen is shown,
**And** a final SMS is enqueued for the saver (Story 6.3 settlement template).

### Story 7.5: Cycle settled transition and final SMS

As a saver,
I want to receive a final SMS confirming that my cycle is closed and stating the amount I will receive,
So that I have tamper-evident proof of the settlement (FR18 settled, FR21 completion).

**Acceptance Criteria:**

**Given** a cycle just settled by the collector,
**When** the settlement Edge Function completes,
**Then** a settlement SMS is enqueued with the settlement-template content (final amount, member name, cycle date range, closing statement),
**And** the SMS is subject to the same dispatch + retry contract as all other SMS (Epic 6),
**And** the receipt URL for this final SMS points to the settlement receipt page (showing the cycle summary).

## Epic 8: Offline Resilience

Ibrahim can work his entire daily route seamlessly on spotty 3G — transactions captured offline are queued and reconcile deterministically on reconnect.

### Story 8.1: ConnectivityIndicator component with 4 states

As a developer,
I want a persistent header pill that continuously shows connectivity + pending-sync state,
So that the collector always knows the truth without opening any settings (UX-DR5, FR41).

**Acceptance Criteria:**

**Given** the authenticated app layout,
**When** the page renders,
**Then** a persistent pill appears top-right of the header,
**And** it shows one of 4 states: connected (*"En ligne"*), syncing (*"Synchronisation • N"*), offline (*"Hors-ligne • N"*), sync-failed (*"Erreur • N"*),
**And** the pill uses semantic colours (green / amber / grey / amber) and never red-alarm,
**And** N = count of pending-sync operations; hidden when 0,
**When** the collector taps the pill,
**Then** a drawer opens listing pending operations with manual-retry actions.

### Story 8.2: IndexedDB event log for offline writes

As a developer,
I want a local event log stored in IndexedDB, with schema `{eventId, eventType, collectorId, entityId, timestamp, actor, source, payload}`,
So that offline operations are durable across app reloads (AR8 partial).

**Acceptance Criteria:**

**Given** the sync module,
**When** any write operation occurs (contribution, rattrapage, advance, member CRUD),
**Then** an event is appended to IndexedDB with a client-generated UUID as event ID,
**And** the event log is append-only and indexed by `(collectorId, timestamp)`,
**And** events persist across app reload and across sign-out / sign-in cycles,
**And** unit tests verify write durability after a simulated app crash.

### Story 8.3: Outbox pattern — queued writes with optimistic UI

As a collector,
I want my transactions to appear immediately in the UI even when offline,
So that my daily route never slows down because of network issues (FR40, FR26 offline aspect).

**Acceptance Criteria:**

**Given** an offline state,
**When** the collector commits a transaction,
**Then** the event is written to the IndexedDB event log,
**And** the UI updates optimistically (TanStack Query `onMutate` with rollback),
**And** the Progressive Toast shows "Hors-ligne — envoi au prochain réseau",
**When** the collector navigates to another member and back,
**Then** the just-committed transaction is persisted in the local read-model,
**And** the member list recency-sort correctly reflects the local write.

### Story 8.4: Reconciler with deterministic replay on reconnect

As a developer,
I want a reconciler worker that replays the IndexedDB event log to Supabase in monotonic order when connectivity returns,
So that offline writes become authoritative server state without conflict or loss (FR42, NFR-P6).

**Acceptance Criteria:**

**Given** a local event log with N pending events,
**When** connectivity returns,
**Then** the reconciler POSTs events in timestamp-monotonic order to PostgREST or Edge Functions,
**And** each event is idempotent by `eventId` (server dedup),
**And** a 24-hour backlog of ~150 events drains in p95 ≤ 90 s (NFR-P6),
**And** the ConnectivityIndicator transitions through syncing → connected as the backlog empties,
**Given** a single event fails to apply (e.g., server error),
**When** the reconciler retries,
**Then** the event is re-queued with exponential backoff; subsequent events are not blocked if they are independent.

### Story 8.5: Stalled-sync alert with manual retry

As a collector,
I want to be notified when a pending operation has been stuck too long,
So that I can intervene before a delay becomes a problem (FR43, NFR-P7).

**Acceptance Criteria:**

**Given** an event pending in the local queue for > 15 minutes after reconnection,
**When** the sync status is updated,
**Then** the ConnectivityIndicator transitions to `sync-failed` state,
**And** opening the sync drawer shows the stalled event with a "Retenter" action,
**When** the collector taps "Retenter",
**Then** the reconciler re-attempts the event with fresh context.

### Story 8.6: Member lookup and edit work offline

As a collector,
I want to search, view, and edit members offline,
So that I'm never blocked by network during my route (FR40 completeness).

**Acceptance Criteria:**

**Given** the collector is offline,
**When** they open the member list, search, view a profile, or edit a member,
**Then** all operations succeed against the local read-model,
**And** any edit is queued in the event log for later reconciliation,
**And** data viewed offline carries a subtle "Données locales — synchronisation en attente" note where relevant.

## Epic 9: Dashboard & Activity Visibility

Ibrahim sees his business performance at a glance and can export his data.

### Story 9.1: Dashboard home with 60-second-polled stats

As a collector,
I want a dashboard showing active members count, today's collection, commission earned, and recent activity,
So that I can open the app each morning and know immediately where I stand (FR34).

**Acceptance Criteria:**

**Given** the authenticated home route,
**When** the dashboard renders,
**Then** it displays: active members count, amount collected today (FCFA), commission earned this cycle (FCFA), and the 5 most recent transaction activities,
**And** the stats refresh every 60 seconds via TanStack Query polling,
**And** the stats are accurate within a 60-second lag window,
**And** the dashboard is fully functional offline (reads from local read-model).

### Story 9.2: Dashboard alerts for cycles ending in upcoming window

As a collector,
I want to see and dismiss dashboard alerts for cycles about to end,
So that I don't miss settlement opportunities (FR35, consumes FR20).

**Acceptance Criteria:**

**Given** at least one member with cycle ending in the configured upcoming window (default 7 days),
**When** the dashboard renders,
**Then** an alert banner displays with the count and a CTA "Voir",
**When** the collector taps "Voir",
**Then** the member list opens filtered to the cycles-ending members,
**When** the collector taps "×" on the alert,
**Then** the alert is dismissed for the current session (reappears on next app open).

### Story 9.3: CSV export of cycle summaries and transaction history

As a collector,
I want to export my cycle commissions and transaction history as CSV,
So that my accountant can use the data without manual transcription (FR37).

**Acceptance Criteria:**

**Given** the settings / data-export screen,
**When** the collector taps "Exporter en CSV",
**Then** the re-auth flow (Story 1.3) is invoked,
**When** OTP is verified,
**Then** a CSV file is generated containing columns: cycle_id, member_name, cycle_start_date, cycle_end_date, total_contributions, advances_sum, commission, final_payout, status,
**And** a second CSV contains per-transaction rows: transaction_id, date, kind, amount, member_id, member_name,
**And** both files are downloadable via the browser,
**And** an `export.csv_generated` audit event is recorded.

## Epic 10: Saver Dispute Flow & Data Rights

Savers can flag disputed transactions and exercise their UEMOA data-protection rights.

### Story 10.1: DisputeFlagSurface on receipt URL page

As a saver,
I want to tap a "Cette transaction n'est pas moi" button on my receipt URL page,
So that I can signal a problem without needing an account or app (FR33b, UX-DR11).

**Acceptance Criteria:**

**Given** a valid receipt URL page,
**When** the saver scrolls below the transaction details,
**Then** a destructive-tinted button displays "Cette transaction n'est pas moi",
**And** below the button, a reversibility note: "Appuyé par erreur ? Vous pourrez annuler dans les 24 h.",
**When** the saver taps the button,
**Then** a bottom-sheet confirmation opens with an optional free-text input and two CTAs "Signaler" (destructive) / "Annuler",
**When** the saver taps "Signaler",
**Then** the dispute is recorded via a POST to the Cloudflare Worker's `/r/{token}/dispute` endpoint,
**And** the Worker propagates the dispute by inserting a row into the `disputes` table (created in Story 1.2) + emitting an audit event.

### Story 10.2: dispute-notify Edge Function (collector + founder notification)

As a developer,
I want an Edge Function that routes dispute events to the collector (in-app alert + push) and the founder (email + push),
So that every dispute is visible to the responsible parties within minutes (AR12, FR33b).

**Acceptance Criteria:**

**Given** a `disputes` row inserted,
**When** the `/functions/v1/dispute-notify` function is triggered,
**Then** it sends an email to the founder (`77 791 58 98` — contact configured in env) and logs a `dispute.flagged` audit event,
**And** it emits a Supabase Realtime event subscribed by the collector's app (in-app notification),
**And** it enqueues a push notification for the founder (via future push channel — deferred to Growth if push infra not ready at MVP; email must work at MVP),
**And** a dispute acknowledgment SMS is dispatched to the saver phone (Story 6.3 template).

### Story 10.3: In-app dispute banner on collector member profile

As a collector,
I want to see dispute alerts on the affected member's profile (never on the dashboard),
So that trust ceremonies stay private (FR33b collector-side).

**Acceptance Criteria:**

**Given** at least one open dispute on a member's transaction,
**When** the collector opens the member profile,
**Then** a banner at the top of the profile announces the open dispute,
**And** the banner does NOT appear on the dashboard home,
**And** the affected transaction in the history shows a dispute icon,
**When** the collector taps the banner,
**Then** a detail view shows the saver's optional message and the submitted timestamp,
**And** a "Marquer comme résolue" action is available (MVP: manual resolution only; automated adjudication Growth).

### Story 10.4: Saver anonymisation Edge Function for right-to-deletion

As a saver,
I want to request the deletion of my personal data and trust that my request is honored while respecting regulatory retention obligations,
So that I can exercise my UEMOA data-protection rights (FR48, AR13).

**Acceptance Criteria:**

**Given** a saver deletion request (via receipt URL page action or direct support),
**When** `/functions/v1/saver-delete` is called with the saver's identifier and confirmation,
**Then** the saver's PII fields (`members.name`, `members.phone_number`) are replaced by salted hashes,
**And** the `members` row is retained with an anonymised reference for audit continuity,
**And** all transactions referencing the saver retain their audit-chain integrity (only PII is anonymised, not transactional data),
**And** the `member.anonymised` event records the action,
**And** no further SMS is dispatched for that saver (opt-out set as side effect),
**And** the anonymisation is irreversible.

### Story 10.5: Saver opt-out action surface from receipt URL

As a saver,
I want to opt out of future SMS from the receipt URL page,
So that I can respectfully stop notifications without replying "STOP" to an SMS (FR32 action surface).

**Acceptance Criteria:**

**Given** a receipt URL page rendered for a non-anonymised member,
**When** the saver scrolls to the footer,
**Then** a "Ne plus recevoir de SMS" link is visible,
**When** the saver taps and confirms,
**Then** the `members.sms_opt_out` flag is set,
**And** a `sms.opt_out` audit event is recorded,
**And** a final confirmation SMS is sent (once, acknowledging the opt-out and explaining how to re-subscribe via the collector if desired),
**And** no further transactional SMS are dispatched for that saver.


