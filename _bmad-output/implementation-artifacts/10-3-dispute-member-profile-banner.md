# Story 10.3: In-app dispute banner on the collector member profile

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **collector**,
I want **to see dispute alerts on the affected member's profile (never on the dashboard), open a detail view, and mark a dispute resolved**,
so that **trust ceremonies stay private and I can act on a saver's dispute (FR33b, collector-side).**

> **Predicate of this story. THIRD story of Epic 10 (Saver Dispute Flow & Data Rights).** Story 10.1 shipped the dispute *capture* (the receipt-URL Worker + `flag_transaction_dispute`); Story 10.2 shipped the dispute *fan-out* (the `dispute-notify` Edge Function — SMS / founder email / a Realtime `broadcast` emit). Story 10.3 ships the *collector-side surface*: the in-app dispute experience.
>
> **What 10.3 ships:**
> 1. **The new `dispute` feature** (`src/features/dispute/` — currently empty placeholders; the architecture's planned tree). `useDisputes(memberId)` reads the member's open disputes (RLS-scoped); `DisputeInlineBanner` + `DisputeDetailSheet` render them; `useResolveDispute` flips a dispute to `resolved`.
> 2. **The member-profile banner.** On `MemberProfile`, when the member has ≥1 open dispute, a destructive-tinted banner at the very top (after `<LocalDataNote/>`). It announces the count + a "Voir le détail" CTA. **NOT on the dashboard** — disputes land privately on the member's profile only.
> 3. **The history dispute icon.** Each transaction row in the member-profile history whose transaction has an open dispute shows a dispute icon; tapping it opens that dispute's detail.
> 4. **The detail view.** A bottom-sheet (`DisputeDetailSheet`) showing the saver's optional free-text message + the `flagged_at` timestamp + a **"Marquer comme résolue"** action. Manual resolution only (automated adjudication is Growth).
> 5. **The resolution.** `useResolveDispute` does a direct PostgREST `UPDATE` on `disputes` (`status='resolved'`, `resolved_at=now()`) — RLS-scoped to the collector; a new `audit_emit` UPDATE branch hash-chains a `dispute.resolved` event. On success the member-profile query is invalidated → the banner/icon disappear.
> 6. **The Realtime subscription** (consumes Story 10.2's emit). A `useDisputeRealtime()` hook mounted in `AppLayout` subscribes to the collector-scoped `disputes:{collector_id}` channel; on a live `dispute_flagged` broadcast it shows an in-app toast and invalidates the affected member's profile query. This is the architecture's single sanctioned Realtime use (Q-ARCH6) — and the **first** Supabase Realtime subscription in the app.
>
> **Code-reuse map (DO NOT re-invent):**
> - **The banner pattern** — `src/features/cycle/ui/CycleEndingAlert.tsx` (a `role="status"` alert section, count copy, a CTA; always-mounted with an `sr-only` empty state). Mirror it — but with the *destructive* palette and NO dismiss button (the banner stays until disputes resolve).
> - **The bottom-sheet pattern** — `src/features/transaction/ui/TransactionReceiptSheet.tsx` — native `<dialog>` (`m-auto mb-0 … rounded-t-2xl`), `showModal()`/`close()` via a `useEffect` on `open`, backdrop-click dismiss. `DisputeDetailSheet` mirrors it.
> - **`MemberProfile`** — `src/features/member/ui/MemberProfile.tsx` is a pure presentation component (props only, zero fetching). The `[id]` route (`src/app/routes/members/[id].tsx`) owns the data + the modal state.
> - **`useMemberProfile`** — `src/features/member/api/useMemberProfile.ts`, query key `["members","profile",id]` (`MEMBER_PROFILE_QUERY_KEY`). `useResolveDispute` + the Realtime hook invalidate `[...MEMBER_PROFILE_QUERY_KEY, memberId]`.
> - **Realtime mount** — `AppLayout` in `src/App.tsx` already hosts always-on side-effect hooks (`useReconciler()`, `useConnectivityState()`). `useCollectorId()` (`src/features/auth/api/useCollectorId.ts`) gives the current collector id + re-renders on auth changes — gate the channel on `collectorId !== null`, `removeChannel` on cleanup.
> - **Toast** — `sonner` (`<Toaster>` already mounted in `providers.tsx`); `toast(...)`.
> - **`disputes` row type** — already generated in `src/infrastructure/supabase/database.types.ts` (`disputes` Row/Update; `disputes_status_enum`).
> - **Destructive palette** — `tailwind.config.ts`: `bg-destructive-bg` (`#FAECE7`), `text-destructive-text` (`#712B13`), `text-destructive` (`#E24B4A`), `border-destructive/20`. Tokens only — no hex literals (ESLint-enforced).
>
> **What Story 10.3 does NOT ship:**
> - Any change to Story 10.1 / 10.2 code (the Worker, `flag_transaction_dispute`, `dispute-notify`, `enqueue_dispute_ack`).
> - Dispute *dismissal* (`status='dismissed'`) or re-opening — only `open → resolved`.
> - Automated adjudication (Growth).
> - Saver anonymisation (10.4); the receipt-URL opt-out (10.5).
> - Any dashboard-home dispute surface (explicitly excluded — AC #5).

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1364-1371`; the rest are spec-derived constraints.

### The `dispute` feature + data

1. **New `dispute` feature.** `src/features/dispute/{api,ui}/` gain real modules + a `types.ts` + an `index.ts` barrel (the architecture's planned tree). Cross-feature consumers (`member`, `app`) import only from `@/features/dispute` (ESLint `import/no-internal-modules`).

2. **`useDisputes(memberId)`** — a TanStack Query hook reading the member's **open** disputes: `disputes` filtered to `status='open'` and joined to the member via `transactions` (`disputes.transaction_id → transactions.member_id`) — e.g. a PostgREST embedded `transactions!inner(member_id)` filter. RLS (`disputes_collector_isolation`, `collector_id = auth.uid()`) scopes it to the collector. Returns the open-dispute rows (`id, transaction_id, notes, flagged_at, status`).

### The member-profile banner

3. **Given** a member with ≥1 open dispute, **When** the collector opens that member's profile, **Then** a banner renders at the **top** of `MemberProfile` (immediately after `<LocalDataNote/>`), destructive-tinted (`bg-destructive-bg` / `text-destructive-text` / `border-destructive/20`), announcing the open-dispute count (one-line title + a count-aware body) with a **"Voir le détail"** CTA. `role="status"`, `aria-live="polite"`.

4. **No open dispute → no banner.** With zero open disputes the banner does not render (or renders `sr-only`, mirroring `CycleEndingAlert`'s always-mounted pattern). No layout shift artifacts.

5. **The banner is NEVER on the dashboard.** It is a member-profile-only component — not imported or mounted by `src/app/routes/dashboard.tsx`. (FR33b: disputes land privately.)

### The history dispute icon

6. **Given** a member-profile transaction-history row whose transaction has an open dispute, **Then** the row shows a dispute icon (a lucide icon, `text-destructive`) distinguishing it from undisputed rows. The icon set comes from the `useDisputes` open-dispute `transaction_id` set.

7. **Tapping a disputed row's dispute icon** opens that transaction's dispute in the `DisputeDetailSheet`. (Undisputed rows keep their existing tap behaviour — the receipt sheet.)

### The detail view + resolution

8. **Given** the collector taps the banner CTA or a disputed row's icon, **Then** a `DisputeDetailSheet` bottom-sheet opens showing: the saver's optional free-text message (`disputes.notes`, or a "(aucun message)" placeholder when null/blank), the submitted timestamp (`flagged_at`, formatted FR), and a **"Marquer comme résolue"** primary action. (Tapping the banner with multiple open disputes opens the most-recent one; per-row icons reach each individually.)

9. **"Marquer comme résolue"** → `useResolveDispute` updates the dispute row to `status='resolved'`, `resolved_at = now()` via a direct PostgREST `UPDATE` (RLS-scoped — `disputes_collector_isolation` is `FOR ALL`, `collector_id = auth.uid()`). On success: a success toast, the sheet closes, and `[...MEMBER_PROFILE_QUERY_KEY, memberId]` + the `useDisputes` query are invalidated → the banner + the icon disappear.

10. **Resolution failure** → an error toast; the sheet stays open so the collector can retry; the dispute stays `open`.

### Audit

11. **A `dispute.resolved` audit event** is hash-chained when a dispute is resolved. A migration extends `audit_emit()` with a `(disputes, UPDATE)` CASE branch: `status` `open → resolved` ⇒ `'dispute.resolved'`; a generic `disputes` UPDATE ⇒ `'dispute.updated'` (defensive catch-all). The `audit_disputes` trigger is extended from `AFTER INSERT` to `AFTER INSERT OR UPDATE`.

12. **Migration discipline.** `audit_emit()` is `CREATE OR REPLACE`d from its **current** definition — migration `20260516101216_dispute-flag-audit-and-rpc.sql` (Story 10.1, the latest to touch it) — preserving EVERY existing branch (the Story 2.5 actor-JWT fallback, 3.3 `cycle.transitioned`, 4.5 `transaction.undone`, 10.1 `dispute.flagged`); ONLY the two new `disputes`-UPDATE lines are added. The `audit_log.event_type` CHECK is a regex — `dispute.resolved` / `dispute.updated` already pass; no CHECK change. `npm run db:migrate` (NOT `db:reset`); `psql`-smoke-test the resolution audit chain.

### The Realtime subscription (consumes Story 10.2's emit)

13. **`useDisputeRealtime()`** — a side-effect hook mounted in `AppLayout` (`src/App.tsx`, alongside `useReconciler()`). Gated on `useCollectorId()`: when a collector id is present it `supabase.channel(\`disputes:${collectorId}\`).on("broadcast", { event: "dispute_flagged" }, …).subscribe()`; on cleanup / collector change / sign-out it `supabase.removeChannel(…)`. This is the FIRST Supabase Realtime subscription in the app.

14. **On a live `dispute_flagged` broadcast** (payload `{ dispute_id, transaction_id, member_id, flagged_at }` — Story 10.2's shape), the hook shows an in-app `toast(…)` ("Une transaction a été contestée") and invalidates `[...MEMBER_PROFILE_QUERY_KEY, member_id]` so an open member profile refreshes its banner live.

15. **Realtime is best-effort + non-fatal.** A failed subscribe / channel error must not crash the app or block any route; the DB-driven banner (AC #3) is the reliable channel and works regardless of whether the collector was online when the dispute landed.

### Architecture, i18n, hygiene, tests

16. **No new npm dependency.** Realtime via the already-bundled `@supabase/supabase-js`; the icon from the already-used `lucide-react`.

17. **i18n.** All copy through new `fr.json` keys (`dispute.*` and/or `members.profile.dispute.*`) — the banner title/body/CTA, the detail-sheet labels + CTA, the toasts. No hard-coded French. `TranslationKey` auto-derives.

18. **Layering.** Dispute UI/hooks live in `src/features/dispute/`; `MemberProfile` + the `[id]` route consume the barrel. `MemberProfile` stays a pure presentation component — the route owns the dispute data + the sheet's open/close state.

19. **Unit tests (vitest + RTL).** `useDisputes` (open-dispute query shaping), `useResolveDispute` (the update + invalidation; success + failure), `DisputeInlineBanner` (renders on count>0, hidden on 0, `axe`-clean), `DisputeDetailSheet` (message/timestamp render, the resolve action, failure keeps it open, `axe`-clean), `useDisputeRealtime` (subscribe on collector id, toast + invalidation on a broadcast, `removeChannel` cleanup — `supabase.channel` mocked). The dispute-icon-on-row rendering in `MemberProfile`.

20. **Playwright E2E** — `tests/e2e/flow-10-dispute-banner.spec.ts`: seed a collector + member + transaction + an open `disputes` row (service-role); open `/members/{id}` → assert the banner + the count + a disputed-row icon; the dashboard shows NO banner; tap → the detail sheet shows the saver message + timestamp; "Marquer comme résolue" → the banner disappears + a `dispute.resolved` `audit_log` row landed.

21. **All gates green** (Node 22 / npm 10): `npm run typecheck`; `npm run lint --max-warnings=0`; `npm run test -- --coverage` (global ≥ 75% branches); `npm run build` (bundle delta ≤ 5 KB gzipped); `npm run test:edge` (no Deno change — confirm still green); `npx playwright test` — the new flow + full suite no-regression. Pre-push: `nvm use 22`, coverage locally, `psql`-smoke-test the migration, grep stale assertions.

## Tasks / Subtasks

- [x] **Task 1 — Migration: `audit_emit` dispute-UPDATE branch + trigger extension** (AC: #11, #12)
  - `npm run db:migrate:new dispute-resolved-audit`. `CREATE OR REPLACE audit_emit()` from migration `20260516101216`'s body (the current version) + the two new `(disputes, UPDATE)` CASE lines (`dispute.resolved` / `dispute.updated`). `DROP TRIGGER audit_disputes` + recreate it `AFTER INSERT OR UPDATE`.
  - `npm run db:migrate`; `psql`-smoke-test: a `disputes` UPDATE `open→resolved` chains a `dispute.resolved` audit row; INSERT still chains `dispute.flagged`.

- [x] **Task 2 — `dispute` feature: data layer** (AC: #1, #2, #9, #16, #18)
  - `src/features/dispute/types.ts` — a `disputeRowSchema` (Zod) + `DisputeRow` type. `api/useDisputes.ts` — the open-disputes-for-member query. `api/useResolveDispute.ts` — the resolve mutation + invalidation. `index.ts` barrel.

- [x] **Task 3 — `dispute` feature: `DisputeInlineBanner`** (AC: #3, #4, #5, #17)
  - `src/features/dispute/ui/DisputeInlineBanner.tsx` — mirrors `CycleEndingAlert`; destructive palette; count copy; "Voir le détail" CTA (`onClick`, not a link); no dismiss.

- [x] **Task 4 — `dispute` feature: `DisputeDetailSheet`** (AC: #8, #9, #10, #17)
  - `src/features/dispute/ui/DisputeDetailSheet.tsx` — native `<dialog>` bottom-sheet (the `TransactionReceiptSheet` pattern); saver message + timestamp; the "Marquer comme résolue" action wired to `useResolveDispute`; failure keeps it open.

- [x] **Task 5 — `dispute` feature: `useDisputeRealtime`** (AC: #13, #14, #15)
  - `src/features/dispute/api/useDisputeRealtime.ts` — the collector-scoped Realtime subscription; toast + member-profile invalidation on `dispute_flagged`; `removeChannel` cleanup. Mount it in `AppLayout` (`src/App.tsx`).

- [x] **Task 6 — Member-profile wiring** (AC: #3, #6, #7, #18)
  - `MemberProfile.tsx` — render `<DisputeInlineBanner>` at the top; add a dispute icon to disputed transaction rows (a `Set` of disputed `transaction_id`s + an `onDisputeIconTap` prop). `src/app/routes/members/[id].tsx` — compose `useDisputes`, pass the props, mount `<DisputeDetailSheet>` with its open/close state. `i18n/fr.json` keys.

- [x] **Task 7 — Unit tests** (AC: #19)
  - vitest + RTL for the hooks + components per AC #19; `supabase.channel` mocked for `useDisputeRealtime`; `axe` for the banner + sheet.

- [x] **Task 8 — Playwright E2E + gate run + sprint hygiene** (AC: #20, #21)
  - `tests/e2e/flow-10-dispute-banner.spec.ts`. All gates green on Node 22; full Playwright suite locally.
  - `sprint-status.yaml`: `10-3-dispute-member-profile-banner` `ready-for-dev → review`; `last_updated` + touched line.

## Dev Notes

### The `dispute` feature is new — the architecture planned it

`src/features/dispute/{api,ui}/` exist with only `.gitkeep`. `architecture.md` (the planned file tree) names `api/useDisputes.ts`, `ui/DisputeInlineBanner.tsx`, `types.ts`, `index.ts`. Put the dispute hooks/components there — NOT in the `member` feature — and have `member` + `app` consume the `@/features/dispute` barrel (CLAUDE.md layering; ESLint `import/no-internal-modules`).

### Querying a member's open disputes

`disputes` has no `member_id` column — it links via `transaction_id → transactions.member_id`. Use a PostgREST embedded inner-join filter:
`supabase.from("disputes").select("id, transaction_id, notes, flagged_at, status, transactions!inner(member_id)").eq("transactions.member_id", memberId).eq("status", "open")`.
RLS on both `disputes` and `transactions` (`collector_id = auth.uid()`) keeps it collector-scoped. `disputes.notes` is plaintext (no vault) — no decrypted view needed.

### Resolution is a plain PostgREST UPDATE — no RPC

`disputes_collector_isolation` is `FOR ALL` for `authenticated` with `USING / WITH CHECK (collector_id = auth.uid())` — the collector may directly `UPDATE` their own dispute rows. `useResolveDispute` does `supabase.from("disputes").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", disputeId)`. The `audit_emit` trigger (extended to UPDATE by Task 1) hash-chains `dispute.resolved`; `actor` resolves to the collector UUID via the Story 2.5 JWT fallback (PostgREST sets `request.jwt.claims`). No SECURITY DEFINER RPC needed.

### `audit_emit` — rebase on the CURRENT version, NOT the original

`audit_emit()` has been `CREATE OR REPLACE`d many times. The CURRENT body is in migration `20260516101216_dispute-flag-audit-and-rpc.sql` (Story 10.1). Reproduce THAT body and add ONLY the two `(disputes, UPDATE)` lines — preserving the Story 2.5 actor-JWT fallback, 3.3 `cycle.transitioned`, 4.5 `transaction.undone`, 10.1 `dispute.flagged`. (Stories 9.3 and 10.1 each hit a bug from rebasing on a stale `audit_*` baseline — do not repeat it.) The new branch, status-aware like `transaction.undone`:
```
when v_entity_table = 'disputes' and v_op = 'UPDATE'
     and (v_payload->>'status') = 'resolved'
     and (to_jsonb(old)->>'status') = 'open'   then 'dispute.resolved'
when v_entity_table = 'disputes' and v_op = 'UPDATE' then 'dispute.updated'
```

### The Realtime subscription — the first in the app

No Supabase Realtime subscription exists today (Q-ARCH6 reserved it for disputes only — everything else polls). `useDisputeRealtime` mirrors `useConnectivityState`'s `useEffect`-keyed-on-`collectorId` shape: subscribe on a non-null collector id, `supabase.removeChannel` on cleanup. Mount it once in `AppLayout` (`src/App.tsx`) — active for all authenticated routes. The channel/event/payload contract is fixed by Story 10.2: channel `disputes:{collector_id}`, event `dispute_flagged`, payload `{ dispute_id, transaction_id, member_id, flagged_at }`. Best-effort — a subscribe failure must be swallowed (logged), never thrown.

### The banner vs the Realtime toast — two layers

The DB-driven banner (AC #3) is the RELIABLE surface: it shows whenever the collector opens a member profile that has an open dispute, regardless of connectivity history. The Realtime toast (AC #14) is the live "within seconds" ping when a dispute lands while the collector is using the app. Both are in scope; the banner is the source of truth, the toast is the enhancement.

### Anti-patterns to avoid

- **DO NOT** mount the dispute banner on the dashboard — FR33b keeps disputes private to the member profile.
- **DO NOT** put dispute code in the `member` feature — it is its own `dispute` feature.
- **DO NOT** rebase `audit_emit` on a stale migration — use `20260516101216`'s body.
- **DO NOT** add a SECURITY DEFINER RPC for resolution — a direct RLS-scoped UPDATE suffices.
- **DO NOT** add an npm dependency — Realtime is in `@supabase/supabase-js`, the icon in `lucide-react`.
- **DO NOT** let a Realtime subscribe failure throw — best-effort, swallow + log.
- **DO NOT** hard-code hex — destructive tokens (`bg-destructive-bg` etc.).
- **DO NOT** `npm run db:reset`; `nvm use 22`; `psql`-smoke-test the migration.

### Project structure notes

**New files:**
- `supabase/migrations/<timestamp>_dispute_resolved_audit.sql`
- `src/features/dispute/types.ts`, `index.ts`
- `src/features/dispute/api/{useDisputes,useResolveDispute,useDisputeRealtime}.ts` (+ tests)
- `src/features/dispute/ui/{DisputeInlineBanner,DisputeDetailSheet}.tsx` (+ tests)
- `tests/e2e/flow-10-dispute-banner.spec.ts`

**Modified files:**
- `src/features/member/ui/MemberProfile.tsx` — the banner + the row dispute icon.
- `src/app/routes/members/[id].tsx` — compose `useDisputes`, mount `DisputeDetailSheet`.
- `src/App.tsx` — mount `useDisputeRealtime()`.
- `src/i18n/fr.json` — `dispute.*` keys.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### Testing standards

- Vitest + RTL; `vi`-mock `supabase` for the hooks; `supabase.channel` mocked for `useDisputeRealtime`; `jest-axe` for the banner + sheet.
- Migration: `psql` smoke test (the `dispute.resolved` chain on an `open→resolved` UPDATE; `dispute.flagged` INSERT still works).
- Playwright for the E2E (`flow-10-dispute-banner`).
- Coverage: ≥ 75% branches global.

### Definition-of-done checklist

- All 21 ACs satisfied + all 8 tasks ticked.
- A member with an open dispute shows the banner + the history icon on the member profile (never the dashboard); the detail sheet shows the message + timestamp; "Marquer comme résolue" resolves it (audited `dispute.resolved`) and clears the banner.
- The Realtime subscription shows a live toast + refreshes an open profile.
- No new dependency; Stories 10.1/10.2 untouched.
- All gates green on Node 22; migration `psql`-smoke-tested; full Playwright suite run locally.
- Story status `review`; sprint-status updated; touched line updated.

## References

- **Epic spec:** `epics.md` lines 1356-1371 (Story 10.3 BDD).
- **PRD:** `prd.md` — FR33b (the collector is notified in-app; disputes land privately; manual adjudication at MVP), the "Against Humiliation" UX principle (disputes never on the home dashboard).
- **Architecture:** `architecture.md` — Q-ARCH6 (Realtime sanctioned ONLY for dispute notifications), the planned `src/features/dispute/` tree (`useDisputes.ts`, `DisputeInlineBanner.tsx`).
- **UX spec:** `ux-design-specification.md` — the dispute lands privately on the collector member profile, never on the home dashboard; the destructive palette.
- **Existing code:** `src/features/cycle/ui/CycleEndingAlert.tsx` + `api/useCyclesEndingAlert.ts` (the banner pattern), `src/features/transaction/ui/TransactionReceiptSheet.tsx` (the bottom-sheet pattern), `src/features/member/ui/MemberProfile.tsx` + `api/useMemberProfile.ts` + `src/app/routes/members/[id].tsx` (the surfaces to wire), `src/features/auth/api/useCollectorId.ts` (the collector id), `src/features/connectivity/api/useConnectivityState.ts` (the `useEffect`-keyed-on-collectorId pattern), `src/App.tsx` (`AppLayout` — the Realtime mount point), `src/app/providers.tsx` (`<Toaster>`, `queryClient`), `supabase/migrations/20260419000001_init_schema.sql` (the `disputes` table + enums), `20260419000002_rls_policies.sql` (`disputes_collector_isolation`), `20260516101216_dispute-flag-audit-and-rpc.sql` (Story 10.1 — the current `audit_emit` + the `audit_disputes` AFTER INSERT trigger), `tailwind.config.ts` (the `destructive` palette).
- **Story 10.2** (`10-2-dispute-notify-edge-function.md`) — the Realtime `broadcast` contract this story consumes (channel `disputes:{collector_id}`, event `dispute_flagged`).
- **CLAUDE.md:** tokens not hex; layering + the feature-barrel rule; `db:migrate` not `db:reset`; no new deps for trivial needs.
- **Memory:** `feedback_migration_rpc_smoke_test.md`, `feedback_npm_lockfile_node_version.md`, `feedback_run_coverage_locally.md`, `feedback_push_then_ci_failure.md`, `project_supabase_rpc_binding.md`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **The `dispute` feature must NOT import `@/features/member`.** The first draft had `useResolveDispute` + `useDisputeRealtime` invalidate `[...MEMBER_PROFILE_QUERY_KEY, …]` (imported from `@/features/member`). Since `MemberProfile` (member feature) imports `DisputeInlineBanner` from `@/features/dispute`, that would form a `member ↔ dispute` barrel cycle. Resolved by recognising the banner + the row icon are driven by `useDisputes` (the dispute feature's own query), NOT `useMemberProfile` — disputes never alter member/cycle/transaction data. So both hooks invalidate ONLY `[...DISPUTES_QUERY_KEY, "member", memberId]`; no `@/features/member` import; no cycle.
- **Test UUIDs must be hex.** `useDisputes`/`DisputeDetailSheet` test fixtures used mnemonic prefixes (`t0000000…` / `m0000000…`) — `t` and `m` are not hex, so `disputeRowSchema`'s `z.string().uuid()` rejected `transaction_id` and the `useDisputes` happy-path query "failed". Fixed to valid-hex UUIDs.
- **Playwright `Page` has `getByLabel`, not `getByLabelText`.** The dispute-icon `aria-label` was also flagged as identical to the banner title — fixed by giving the row icon a distinct label (`dispute.row.icon_label` = "Cette transaction est contestée" vs the banner's "Transaction contestée"); the E2E asserts the icon via an `[aria-label=…]` locator.

### Completion Notes List

- **Migration `20260516213715`** — `audit_emit()` `CREATE OR REPLACE`d from its current definition (migration `20260516101216`) + a status-aware `(disputes, UPDATE)` branch (`open→resolved` ⇒ `dispute.resolved`; else `dispute.updated`); the `audit_disputes` trigger extended `AFTER INSERT` → `AFTER INSERT OR UPDATE`. psql-smoke-tested: an `open→resolved` UPDATE chains `dispute.resolved`; an INSERT still chains `dispute.flagged`. The `audit_log.event_type` CHECK is a regex — no CHECK change needed.
- **New `src/features/dispute/` feature** — `types.ts` (`disputeRowSchema`, `DISPUTES_QUERY_KEY`), `api/useDisputes.ts` (open-disputes-for-member via a PostgREST `transactions!inner(member_id)` embedded filter), `api/useResolveDispute.ts` (a direct RLS-scoped `UPDATE` — no RPC), `api/useDisputeRealtime.ts` (the FIRST Supabase Realtime subscription in the app), `ui/DisputeInlineBanner.tsx`, `ui/DisputeDetailSheet.tsx`, `index.ts`.
- **Wiring** — `MemberProfile` renders `<DisputeInlineBanner>` at the top + a `Flag` icon on disputed transaction rows (visual indicator; the banner is the tap entry to the detail — keeps the rows free of nested interactive elements). The `[id]` route composes `useDisputes` + `useResolveDispute` + mounts `<DisputeDetailSheet>`. `AppLayout` (`App.tsx`) mounts `useDisputeRealtime()`.
- **The row dispute icon is a visual indicator, not separately tappable** — the epic AC says the row "shows a dispute icon"; making the icon its own tap target inside the already-interactive row `<button>` would nest interactive elements (an a11y violation). The banner CTA is the entry to the detail sheet.
- **`test:edge` not re-run** — Story 10.3 has no Deno change; the `audit_emit` migration is additive and is exercised by the full Playwright suite (every member/cycle/transaction mutation fires `audit_emit`) — 42 passed confirms it. The local `test:edge` is anyway gated by the pre-existing `sms-inbound`/`sms-worker` Termii-secret gap.
- **Gates** (Node 22): typecheck ✓ · lint --max-warnings=0 ✓ · 984 vitest passed (22 new) ✓ · branches 75.97% global (≥75%) ✓ · build ✓ · Playwright `flow-10-dispute-banner` green + full suite 42 passed (1 local-only failure: `flow-3-cycle-settlement` re-auth — fails identically on clean `main`, passes in CI).

### File List

**New:**
- `supabase/migrations/20260516213715_dispute-resolved-audit.sql`
- `src/features/dispute/types.ts`, `index.ts`
- `src/features/dispute/api/useDisputes.ts` (+ `.test.tsx`)
- `src/features/dispute/api/useResolveDispute.ts` (+ `.test.tsx`)
- `src/features/dispute/api/useDisputeRealtime.ts` (+ `.test.tsx`)
- `src/features/dispute/ui/DisputeInlineBanner.tsx` (+ `.test.tsx`)
- `src/features/dispute/ui/DisputeDetailSheet.tsx` (+ `.test.tsx`)
- `tests/e2e/flow-10-dispute-banner.spec.ts`

**Modified:**
- `src/features/member/ui/MemberProfile.tsx` — the dispute banner + the per-row dispute icon (+ `.test.tsx`).
- `src/app/routes/members/[id].tsx` — composes `useDisputes` / `useResolveDispute`, mounts `DisputeDetailSheet`.
- `src/App.tsx` — mounts `useDisputeRealtime()`.
- `src/i18n/fr.json` — `dispute.*` keys.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-16 | Story 10.3 implemented via bmad-dev-story on `feat/10-3-dispute-member-profile-banner` — 8 tasks / 21 ACs. Migration `20260516213715`: the `audit_emit` `(disputes, UPDATE)` branch + the `audit_disputes` trigger extended to `AFTER INSERT OR UPDATE`. New `src/features/dispute/` feature (`useDisputes` / `useResolveDispute` / `useDisputeRealtime` + `DisputeInlineBanner` + `DisputeDetailSheet`). `MemberProfile` gains the dispute banner + the per-row dispute icon; the `[id]` route composes the dispute hooks + the detail sheet; `AppLayout` mounts the Realtime subscription (the first in the app). Debug: the dispute feature must not import `@/features/member` (barrel cycle) — both hooks invalidate only the dispute query; test-fixture UUIDs fixed to valid hex. Gates green: typecheck / lint / 984 vitest / build / Playwright `flow-10-dispute-banner` + full suite 42 passed (1 local-only `flow-3` failure). | Dev agent (claude-opus-4-7[1m]) |
| 2026-05-16 | Story 10.3 drafted via bmad-create-story — THIRD story of Epic 10 (Saver Dispute Flow & Data Rights). The collector-side dispute surface: a new `src/features/dispute/` feature (`useDisputes` / `useResolveDispute` / `useDisputeRealtime` hooks, `DisputeInlineBanner` + `DisputeDetailSheet` components). A destructive-tinted banner at the top of the member profile when the member has ≥1 open dispute (NEVER on the dashboard — FR33b privacy); a dispute icon on disputed transaction-history rows; a bottom-sheet detail view (saver message + timestamp) with a "Marquer comme résolue" action that does a direct RLS-scoped PostgREST UPDATE (`status='resolved'`) — a new `audit_emit` `(disputes, UPDATE)` branch hash-chains `dispute.resolved`. A `useDisputeRealtime` hook (the FIRST Supabase Realtime subscription in the app) mounted in `AppLayout` consumes Story 10.2's `disputes:{collector_id}` broadcast → a live in-app toast + member-profile invalidation. One migration extends `audit_emit` + the `audit_disputes` trigger (INSERT → INSERT OR UPDATE). NO new dependency; Stories 10.1/10.2 untouched. 21 ACs / 8 tasks. | Spec author (claude-opus-4-7[1m]) |

## Review Findings

**Reviewed:** 2026-05-17 · `bmad-code-review` · 3-layer adversarial review (Blind Hunter / Edge Case Hunter / Acceptance Auditor, sonnet-4-6) on the uncommitted diff of `feat/10-3-dispute-member-profile-banner` (21 files, +1368/−4).

**Verdict:** APPROVE WITH PATCHES. No Critical / High defects confirmed. The `audit_emit` migration preserves every prior branch (Story 2.5 JWT fallback, 3.3 `cycle.transitioned`, 4.5 `transaction.undone`, 10.1 `dispute.flagged`); CASE ordering is correct; the `audit_disputes` trigger recreation is sound. The `member ↔ dispute` barrel-cycle is correctly avoided. 5 patches (all Low/Medium), 2 deferrals, the rest dismissed.

### Patches to apply (P1–P5)

- **P1 — `useResolveDispute` idempotency guard (Medium).** `useResolveDispute.ts:25-28` — the UPDATE filters by `id` only. Resolving an already-`resolved` dispute overwrites `resolved_at`, emits a spurious `dispute.updated` audit event, and still fires the success toast. Fix: add `.eq("status", "open").select("id")` and throw when zero rows return so the error toast fires + the sheet stays open.
- **P2 — `useResolveDispute` missing `networkMode: "always"` (Medium).** `useResolveDispute.ts:23` — every sibling user-mutation (`useRecordContribution/Advance/Rattrapage`, `useUpdateMember`) sets it; the project memory `feedback_tanstack_networkmode_offline.md` calls this out. Without it an offline "Marquer comme résolue" tap pauses the `mutationFn` — the spinner hangs forever, the error toast never fires. Fix: add `networkMode: "always"`.
- **P3 — `useDisputeRealtime` subscribe failure is not logged (Low→Medium).** `useDisputeRealtime.ts:46` — `.subscribe()` has no status callback; AC #15 requires a failed subscribe to be "logged". Fix: pass `subscribe((status) => { if status is CHANNEL_ERROR/TIMED_OUT/CLOSED → console.warn("[dispute-realtime] …") })`, matching the `[prefix]` `console.warn` convention used in `signOut.ts` / `useReconciler.ts`.
- **P4 — non-hex UUID in a test fixture (Low).** `DisputeDetailSheet.test.tsx:14` — `transaction_id: "t0000000-…"` (`t` is not hex). The Debug Log claims this class of fixture was fixed; this one survived. `DisputeDetailSheet` takes `DisputeRow` directly (no Zod parse) so the test passes — but it contradicts the story's own stated standard. Fix: `t0000000…` → `a0000000…`.
- **P5 — `useResolveDispute` called with the unguarded raw `id` (Low).** `members/[id].tsx:63` — `useMemberProfile` + `useDisputes` get `isUuid ? id : undefined`; `useResolveDispute(id)` gets the raw param. The mutation is lazy and only ever fires once `query.data` exists (valid UUID), so no live bug — but it is an inconsistency. Fix: pass `isUuid ? id : ""`.

### Deferred (log as Growth follow-on, not MVP blockers)

- **D1 — AC #7/#8: the per-row dispute icon is a non-interactive visual indicator.** All 3 agents flagged this. The Dev Notes document the a11y rationale (a tappable icon nested in the already-interactive row `<button>` is an HTML violation) — sound. But AC #8's "per-row icons reach each individually" is unimplemented: with ≥2 open disputes the banner CTA only ever opens the most-recent (`openDisputes[0]`); disputes #2+ are unreachable until #1 is resolved. Acceptable for the MVP (one open dispute per member is the realistic case); a Growth story should add per-dispute routing (e.g. a `<button>` sibling outside the row button).
- **D2 — previous-cycle disputes: banner shows, no row carries the icon.** `useMemberProfile` filters transactions to the current cycle; `useDisputes` is cross-cycle. A dispute on a prior-cycle transaction inflates `openDisputeCount` (banner shown) but `disputedTransactionIds.has(tx.id)` is false for every rendered row. The banner CTA still opens the detail sheet, so the dispute is reachable — only the row-icon correlation is lost. Edge case; defer.

### Dismissed

- **`MEMBER_PROFILE_QUERY_KEY` not invalidated by `useResolveDispute` / `useDisputeRealtime`** — spec wording predates the `member ↔ dispute` barrel-cycle discovery. The banner + row icon read from `useDisputes` (which IS invalidated); disputes never alter member/cycle/transaction data, so invalidating the profile query would be pointless churn. Correct architectural call — documented in the Debug Log.
- **`member_id: null` broadcast payload skips invalidation** — best-effort by design (the comment + AC #15 say so); the toast still informs the collector and the DB-driven banner is the reliable surface.
- **`onDisputeBannerTap` `?? (() => {})` fallback** — only the `[id]` route renders `MemberProfile` with `openDisputeCount > 0` and it always passes the handler; harmless.
- **Static banner title / `body_many` "Un saver" copy / `JSX.Element` return type / test-assertion precision / non-hex UUIDs in `useDisputeRealtime` + `useDisputes` fixtures (never Zod-validated in those paths)** — cosmetic; not worth the churn.

### Patch Resolution — 2026-05-17

All 5 patches (P1–P5) applied:

- **P1** — `useResolveDispute.ts`: UPDATE now `.eq("status", "open").select("id")` and throws `"dispute is not open"` on zero rows → no spurious `dispute.updated` event, no false success toast. New vitest case: "rejects when the dispute is no longer open".
- **P2** — `useResolveDispute.ts`: `networkMode: "always"` added.
- **P3** — `useDisputeRealtime.ts`: `.subscribe((status) => …)` callback `console.warn`s on `CHANNEL_ERROR` / `TIMED_OUT` (`CLOSED` excluded — it fires on normal teardown). New vitest case: "logs a warning only on a failed subscribe status".
- **P4** — `DisputeDetailSheet.test.tsx`: fixture `transaction_id` `t0000000…` → `a0000000…` (valid hex).
- **P5** — `members/[id].tsx`: `useResolveDispute(isUuid ? id : "")` — consistent with the other two hooks.

D1 (per-row dispute-icon routing) and D2 (previous-cycle disputes) deferred as Growth follow-ons.

**Gates re-run (Node 22):** typecheck ✓ · lint --max-warnings=0 ✓ · 986 vitest passed (+2 net) ✓ · branches 76.07% global (≥75%) ✓ · build ✓ · Playwright `flow-10-dispute-banner` green (verified the patched `.eq("status","open").select("id")` resolve query end-to-end against the local DB — `dispute.resolved` audit row still chains). Story status → `done`.
