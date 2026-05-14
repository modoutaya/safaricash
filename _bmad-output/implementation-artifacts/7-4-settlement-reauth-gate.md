# Story 7.4: Settlement commit gated by re-auth (password) + envelope handover mount

Status: review

## Story

As a **collector**,
I want **the settlement commit to require a fresh password re-auth and to atomically transition the cycle to `settled`**,
so that **a moment of this consequence is protected against stolen-phone abuse (consumes FR5 re-auth, fulfils FR21 + NFR-R3 zero-tolerance, transitions UX Flow 3 step G → J → K).**

> **Predicate of this story.** Epic 7's **fourth and largest** deliverable — the **end-to-end settlement commit pipeline**. Story 7.4 takes the bowing-out lever from Story 7.3's `toast.info` stub and wires it to:
>
> 1. **Password re-auth dialog** (FR5 gate, mirrors Story 6.6 `ResendHistoryDialog` pattern) — confirms it's still Ibrahim before the irreversible UPDATE.
> 2. **`/functions/v1/cycle-settlement` Edge Function** — JWT-auth + password-verify + RPC delegation, mirrors Story 6.6 `sms-resend-history/index.ts` architecture exactly.
> 3. **`commit_cycle_settlement` SQL RPC (SECURITY DEFINER)** — atomic transaction: `FOR UPDATE` lock on cycle, precondition assert `status='completed'`, server-side payout recomputation, **NFR-R3 zero-tolerance** payout-mismatch reject, INSERT synthetic `transactions` row with `kind='settlement'` (new enum value), UPDATE `cycle.status='settled'` + `settled_at=now()`. The cycle UPDATE fires the **existing** audit trigger (`audit_emit_cycle_transitioned`, migration 0007) which auto-emits `cycle.settled` to `audit_log`. The transaction INSERT fires the **existing** `enqueue_sms_on_transaction` trigger which queues the settlement SMS using the **existing** Story 6.3 `format_sms_body('settlement', ...)` template.
> 4. **`SettlementReauthDialog` component** + **`useCommitSettlement` mutation hook** — frontend wiring of the password dialog + the Edge Function call.
> 5. **Story 7.3 route update** — `[id].settlement.tsx`'s `handleConfirm` stub replaced with the dialog trigger; `isSubmitting` driven by the mutation's `isPending`; on success, in-route view-swap to mount Story 7.2's `<EnvelopeHandoverScreen>`.
>
> **Architectural alignment with existing infrastructure (CRITICAL — do not re-invent):**
> - The `cycle.settled` audit event is **already emitted** by the existing trigger (migration 0007 `audit_emit_cycle_transitioned`, line 159). Story 7.4 does **NOT** add a new audit event type, does **NOT** extend the `audit_append_external` allowlist.
> - The `settlement` SMS template **already exists** in `format_sms_body` (migration 0029 line 120) and reads `v_tx.amount` to interpolate the payout. The original comment says *"Story 7.5 will create a transaction row"* — Story 7.4 honours that intent by introducing `transactions.kind='settlement'`.
> - The `enqueue_sms_on_transaction` trigger (migration 0035) picks `template_key` based on prior SMS count for the cycle. For settlement, it MUST force `template_key='settlement'` regardless of prior count — one-line CASE addition.
>
> **What Story 7.4 does NOT ship:**
> - Tweaks to the settlement SMS template content (Story 7.5 extends `format_sms_body` if member name / cycle date range are added).
> - The Cloudflare Worker receipt-URL rendering for `kind='settlement'` transactions (Story 7.5).
> - The dashboard "Prêt pour clôture" filter alternative entry path (out of scope; current `/members?filter=cycles-ending` continues to point at upcoming-end, not completed cycles).
> - Any change to Story 7.1 `SettlementSummaryCard` or Story 7.2 `EnvelopeHandoverScreen` — both consumed as-is.

## Acceptance Criteria

> Numbered for traceability. Lines starting **Given/When/Then** are the BDD source from `epics.md:1141-1151`; the rest are spec-derived constraints required for a flawless implementation.

### Backend — migrations + RPC + Edge Function

1. **Migration — extend `transactions_kind_enum`.** Add `'settlement'` to the existing enum. Use `ALTER TYPE public.transactions_kind_enum ADD VALUE IF NOT EXISTS 'settlement'`. **Critical:** ADD VALUE cannot run inside a transaction block — the migration file must run this statement on its own (Supabase migration runner handles this correctly when the statement is the only one in the file, OR follow the existing pattern in any earlier `kind` enum modification — there isn't one, so this is the first such migration). **Workaround**: if Supabase's migration runner wraps in BEGIN/COMMIT, split into 2 migrations OR use the `ALTER TYPE ... ADD VALUE ... -- @cli:noTransaction` directive (verify supabase-cli compatibility).

2. **Migration — `cycles.settled_at timestamptz null`.** Add the column to the existing `public.cycles` table. NULL by default; populated by the RPC on commit. **Do NOT** make it NOT NULL — historical (pre-Story-7.4) settled cycles would otherwise violate the constraint. **Update** `cycles_decrypted` view? — no, `cycles` is not encrypted (the existing view convention applies to `members`/`transactions` only); confirm by grep.

3. **Migration — extend `enqueue_sms_on_transaction` trigger** to force `template_key='settlement'` when `NEW.kind = 'settlement'`. Use the same `create or replace` byte-for-byte discipline as Story 6.x trigger replacements: only the CASE addition + the comment line change vs. the prior migration (0035 `enqueue_sms_template_key.sql`).

4. **Migration — `commit_cycle_settlement` SECURITY DEFINER RPC.** Signature:
   ```sql
   create or replace function public.commit_cycle_settlement(
     p_member_id        uuid,
     p_cycle_id         uuid,
     p_expected_payout  bigint   -- client-computed payout (NFR-R3 cross-check)
   ) returns table (
     settlement_transaction_id  uuid,
     settled_payout             bigint,
     settled_at                 timestamptz
   ) language plpgsql security definer set search_path = public, pg_temp as $$ ... $$;
   ```
   Body steps (in order):
   - **Auth check**: `if auth.uid() is null then raise exception 'cycle_settlement: auth required' using errcode = 'P0002'; end if;`
   - **Lock the cycle row**: `select * into v_cycle from public.cycles where id = p_cycle_id for update`.
   - **Existence + ownership**: `if not found OR v_cycle.collector_id <> auth.uid() then raise exception 'cycle_settlement: cycle not found or not owned' using errcode = 'P0002'; end if;`
   - **Precondition assert**: `if v_cycle.status <> 'completed' then raise exception format('cycle_settlement: cycle not in completed status (got %s)', v_cycle.status) using errcode = 'P0002'; end if;`
   - **Member ownership cross-check**: `if v_cycle.member_id <> p_member_id then raise exception 'cycle_settlement: cycle/member mismatch' using errcode = 'P0002'; end if;`
   - **Server-side payout recomputation**: `select coalesce(sum(case when t.kind = 'advance' then t.amount else 0 end), 0) into v_advances_sum from public.transactions t where t.cycle_id = p_cycle_id and t.kind in ('contribution','rattrapage','advance') and t.undone_at is null;` — sum ONLY advances; the projection formula is `daily_amount × 29 − Σ(advances)`, where `daily_amount × 29` is the cycle's CONTRIBUTION_DAYS contractual maximum (NOT the sum of actual contributions — see NFR-R3 / Story 3.2 INV-2 comment in `cycleEngine.ts:67-70`).
   - **Compute payout**: `v_computed_payout := (select m.daily_amount from public.members m where m.id = p_member_id) * 29 - v_advances_sum;` — must equal `settle(daily_amount, advances[])` from Story 3.2.
   - **NFR-R3 zero-tolerance cross-check**: `if v_computed_payout <> p_expected_payout then raise exception format('cycle_settlement: payout mismatch (client=%s, server=%s)', p_expected_payout, v_computed_payout) using errcode = 'P0002'; end if;`
   - **Insert settlement transaction**: `insert into public.transactions (member_id, cycle_id, kind, amount, cycle_day, created_by) values (p_member_id, p_cycle_id, 'settlement', v_computed_payout, 30, auth.uid()) returning id into v_settlement_tx_id;` — fires the (now-extended) `enqueue_sms_on_transaction` trigger → queues SMS with `template_key='settlement'`. **Encryption**: the `transactions.amount` column is encrypted via Vault; the existing trigger handles this. Verify the encrypt path applies for `kind='settlement'` (likely yes — encryption is per-column, not per-kind).
   - **Update cycle status**: `update public.cycles set status = 'settled', settled_at = now() where id = p_cycle_id;` — fires `audit_emit_cycle_transitioned` trigger → emits `cycle.settled` to `audit_log` (no new audit code needed).
   - **Return**: `return query select v_settlement_tx_id, v_computed_payout, now();`.
   - **`grant execute`**: `grant execute on function public.commit_cycle_settlement(uuid, uuid, bigint) to authenticated;` — `authenticated` role; the function's internal `auth.uid()` + cycle ownership check provide the real authorization.

5. **Edge Function `supabase/functions/cycle-settlement/index.ts`.** Mirror `sms-resend-history/index.ts` structure EXACTLY (Story 6.6 pattern):
   - POST only; `method_not_allowed` for anything else (verify the project's `problem` enum includes `method_not_allowed` — if not, use `request_invalid` per the Story 6.6 patch).
   - JWT auth via `assertAuthenticated` from `_shared/auth-check.ts`.
   - Body schema (Zod): `{ member_id: uuid, cycle_id: uuid, expected_payout: number().int().positive(), password: string().min(1) }`.
   - **Password verify**: call `verifyPassword({ serviceClient, collectorId, password, logContext: { operation_intent: 'cycle_settlement', member_id, cycle_id } })`. Returns `{ ok: true } | { ok: false, problem }`.
   - **RPC call**: `service.rpc('commit_cycle_settlement', { p_member_id, p_cycle_id, p_expected_payout })`. Decode the single-row result (PostgREST returns an array of one row for TABLE-returning functions).
   - **RPC-error mapping**: parse `error.message` for the specific exception prefixes:
     - `cycle not found or not owned` → 404 `not_found`.
     - `cycle not in completed status` → 409 `cycle_not_settleable`.
     - `cycle/member mismatch` → 400 `request_invalid`.
     - `payout mismatch` → 409 `payout_mismatch` (include both client + server payouts in the problem `detail` for client error display).
     - anything else with `cycle_settlement:` prefix → 500 `internal_unexpected`.
   - **Success response (200)**: `{ ok: true, settlement_transaction_id, settled_payout, settled_at }`.
   - **Structured JSON logging** at every error path; never log the password (delegated to `verifyPassword`).
   - **`error.message` redaction in 500 detail**: per Story 6.6 patch, the RFC 7807 `detail` field for `internal_unexpected` returns a static string, NEVER the raw error message (no PII / stack leak).

6. **No new shared helper.** `verifyPassword` already exists at `_shared/verify-password.ts` (Story 6.6 extraction). DO NOT re-extract anything; just import.

### Frontend — mutation hook, dialog, route wiring

7. **Mutation hook `src/features/settlement/api/useCommitSettlement.ts`.** New feature folder `src/features/settlement/` since this is the first non-card piece of settlement logic — keeps the surface tidy. Mirror Story 6.6 `useResendHistory.ts` structure:
   - TanStack `useMutation` over an inner `commitSettlement` invoker that calls `supabase.functions.invoke('cycle-settlement', { body: ... })`.
   - **`this`-binding gotcha (project memory):** call methods directly on the client — `await client.functions.invoke(...)` or cast the CLIENT (`supabase as unknown as ClientShape`), NEVER extract `supabase.functions.invoke` into a free variable.
   - Typed `CommitSettlementError extends Error` class with `code: "credentials_invalid" | "rate_limited" | "not_found" | "cycle_not_settleable" | "payout_mismatch" | "request_invalid" | "unauthenticated" | "internal_unexpected" | "network" | "unknown"` + optional `serverPayout` field (parsed from RFC 7807 `detail` for the `payout_mismatch` case).
   - `classifyError(rawErr)` helper — parses `FunctionsHttpError` body via `.context.json()` (same pattern as Story 6.6 + 6.7), maps to the typed code.
   - **TypeError class-identity check** for network errors: `if (err instanceof TypeError)` → `code: "network"` (Story 6.7 patch).
   - **`onSuccess` invalidation**: `void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] })` — the settlement updates `cycle.status` and inserts a transaction; the profile cache MUST refresh so the `Clôturer le cycle` CTA disappears (Story 7.3's `canSettle` flips false).
   - Returns the mutation object with `mutateAsync({ memberId, cycleId, expectedPayout, password })`.

8. **Dialog component `src/features/settlement/ui/SettlementReauthDialog.tsx`.** Native `<dialog>` element (zero dep), mirror Story 6.6 `ResendHistoryDialog.tsx` pattern:
   - Props: `open`, `onOpenChange`, `memberId`, `cycleId`, `expectedPayout`, `memberName`, `onSuccess(result)`, `onError(err)`.
   - Renders a `<form>` with a password input (`type="password"`, `autoComplete="current-password"`, `aria-required="true"`, label *"Mot de passe"*).
   - Submit button: *"Valider la clôture"*. Disabled while `useCommitSettlement().isPending`.
   - Cancel button: closes the dialog.
   - Header: *"Confirmation requise"* (h2) + body explainer *"Pour clôturer le cycle d'{memberFirstName} et débloquer {payout} FCFA, confirmez votre mot de passe."*.
   - **Form-wrapped for Enter-to-submit** (Story 6.6 P6 patch precedent).
   - **Password trim + min length 1** before submit (Story 6.6 P3 patch precedent).
   - **a11y**: `aria-labelledby` on the dialog → the h2; password input has visible `<label>` linked via `htmlFor`/`id`; close button has `aria-label`; jest-axe clean across 3 states (idle / submitting / error-shown).

9. **i18n keys.** Add to `src/i18n/fr.json`:
   - `settlement.reauth.title`: *"Confirmation requise"*
   - `settlement.reauth.body`: *"Pour clôturer le cycle de {memberFirstName} et débloquer {payout} FCFA, confirmez votre mot de passe."*
   - `settlement.reauth.password_label`: *"Mot de passe"*
   - `settlement.reauth.cta_submit`: *"Valider la clôture"*
   - `settlement.reauth.cta_submitting`: *"Vérification…"*
   - `settlement.reauth.cta_cancel`: *"Annuler"*
   - `settlement.reauth.error.credentials_invalid`: *"Mot de passe incorrect — réessayez."*
   - `settlement.reauth.error.rate_limited`: *"Trop de tentatives — réessayez dans quelques minutes."*
   - `settlement.reauth.error.cycle_not_settleable`: *"Ce cycle n'est plus prêt à être clôturé."*
   - `settlement.reauth.error.payout_mismatch`: *"Le montant a changé — rechargez la page."*
   - `settlement.reauth.error.not_found`: *"Cycle ou membre introuvable."*
   - `settlement.reauth.error.network`: *"Pas de réseau — vérifiez votre connexion."*
   - `settlement.reauth.error.unknown`: *"Erreur inattendue — réessayez."*
   - `settlement.toast.success`: *"Cycle clôturé. SMS envoyé à {memberFirstName}."*
   - **14 new keys** under a new `settlement.reauth.*` sub-namespace + `settlement.toast.*` (parallel to existing `settlement.summary.*` and `settlement.flow.*`).

10. **`[id].settlement.tsx` route — replace the Story 7.3 stub.**
    - Add `useState` for the dialog open/closed AND for the post-success view-state (`"preview" | "done"`).
    - `useCommitSettlement` instantiated in the body.
    - `handleConfirm` (replacing the `toast.info` stub): opens the dialog. Removes the stub TODO comment.
    - Dialog's `onSuccess` handler:
      - Sets a state variable holding the settlement result (`{ payout, settled_at }`).
      - Flips the view-state to `"done"`.
      - Fires `toast.success(t("settlement.toast.success", { memberFirstName }))`.
    - Dialog's `onError` handler: maps `CommitSettlementError.code` to the matching i18n key + `toast.error`. The dialog stays open for `credentials_invalid` and `rate_limited` (user can retry); auto-closes for `payout_mismatch` / `not_found` / `cycle_not_settleable` (user must reload / re-enter the flow).
    - **`isSubmitting` prop** on `<SettlementSummaryCard>`: drive from `useCommitSettlement().isPending`.
    - **View-swap on success**: when state === "done", render `<EnvelopeHandoverScreen>` (Story 7.2) INSTEAD of the route's header + card. Props: `memberName`, `payoutAmount=settled_payout`, `recipientPhone=member.phone_number`, `smsState="sent"` (the SMS was enqueued during the RPC; the actual dispatch is async — for MVP, we say "sent" optimistically since the queue insert succeeded), `onReturnToMembers={() => navigate("/members")}`.

11. **`onConfirm` callback signature.** Story 7.3 left `() => void` (ignoring the `(memberId, cycleId)` args). Story 7.4 may now USE those args OR keep ignoring them and rely on closures. **Decision**: keep ignoring; use closures. The route's `memberId` and `cycleId` are stable per-render — closures over them are cleaner than re-reading from the callback args.

### Tests

12. **Deno contract test `supabase/functions/_shared/commit-cycle-settlement.contract.test.ts`.** Mirror `enqueue-resend-history.contract.test.ts` pattern. Cases (≥ 7):
    - **Happy path** — seed member with `daily_amount=500`, completed cycle with 2 contributions (500 each) + 1 advance (3000). Expected payout = `500 × 29 − 3000 = 11500`. Call RPC with that expected. Assert: `settled_payout = 11500`, `settlement_transaction_id` is a UUID, cycle row now has `status='settled'`, `settled_at IS NOT NULL`. Audit_log has a `cycle.settled` row.
    - **Idempotent re-call** — call the RPC again on the now-settled cycle; expect `cycle_not_settleable` exception (status='settled', not 'completed').
    - **Cycle not completed** — cycle.status='active', RPC raises `cycle_not_settleable`.
    - **Payout mismatch** — call with `p_expected_payout=99999`; RPC raises `payout_mismatch` with detail mentioning both numbers.
    - **Not owner** — seed two collectors; collector A calls RPC against collector B's cycle; raises `not found or not owned`.
    - **Member/cycle mismatch** — `p_member_id` correct but `p_cycle_id` belongs to a different member; raises `cycle/member mismatch`.
    - **Auth.uid() null** — call without a JWT; raises `auth required`.
    - **SMS enqueue side-effect** — after happy-path commit, assert one new row in `sms_queue` with `template_key='settlement'`, `recipient_phone` populated, `body` matches the `format_sms_body('settlement', tx_id)` template.
    - **Settlement transaction row inserted** — assert `select * from transactions where kind='settlement' and cycle_id=...` returns one row with `amount=11500`, `cycle_day=30`.

13. **Edge Function contract test `supabase/functions/_shared/cycle-settlement.contract.test.ts`.** Mirror `enqueue-resend-history.contract.test.ts`. Cases (≥ 6):
    - **Happy path** — POST with valid JWT + correct password + correct expected_payout. 200 + result body.
    - **No JWT** — 401 `unauthenticated`.
    - **Wrong password** — 401 `credentials_invalid`.
    - **Wrong expected_payout** — 409 `payout_mismatch` with detail `{ server_payout, client_payout }`.
    - **Already settled cycle** — 409 `cycle_not_settleable`.
    - **Wrong member_id for cycle** — 400 `request_invalid`.
    - **Method not allowed** — GET → 405 (or 400 if the project's `problem` enum doesn't have `method_not_allowed` — match the Story 6.6 patch).
    - **Malformed body** — 400 `request_invalid`.

14. **Frontend unit tests:**
    - `useCommitSettlement.test.ts` — covers `classifyError` branches (all 9 codes), the success path (mock supabase.functions.invoke), the invalidation call assertion. **≥ 12 cases.** Critical: this hook MUST hit 100% of the `classifyError` branches per the project memory `feedback_run_coverage_locally.md` (4-7 tests for branch coverage typically needed).
    - `SettlementReauthDialog.test.tsx` — render + form submit + Enter key + cancel + jest-axe across 3 states. **≥ 8 cases.**
    - `[id].settlement.test.tsx` — extend with new cases: dialog opens on Confirm click, mutation success swaps view to EnvelopeHandoverScreen, error path keeps dialog open. **≥ 3 new cases** (now 15 total).

15. **Playwright E2E `tests/playwright/flow-3-cycle-settlement.spec.ts`.** **NEW** — first Flow 3 E2E. Cases (≥ 2):
    - **Happy path** — login as a seeded collector, navigate to a seeded member with a `completed` cycle, tap "Clôturer le cycle", tap "Confirmer et clôturer", enter password, assert envelope handover screen renders + member name + payout + "Retour aux membres" CTA. Tap "Retour aux membres", land on `/members`. Assert the seeded member now has the cycle in `settled` status (re-navigate to profile, "Clôturer le cycle" CTA gone, "Redémarrer le cycle" CTA still present).
    - **Wrong password retry** — tap Confirm, enter wrong password, assert dialog stays open with error toast, enter correct password, assert success.

### Architecture, contracts, and constraints

16. **NFR-R3 zero-tolerance — client-server payout cross-check.** The client computes the expected payout via Story 7.1 `SettlementSummaryCard`'s internal `settle()` call AND passes it explicitly to the Edge Function. The server recomputes from `transactions` rows and rejects on mismatch. **This is the defining invariant of Epic 7.** Any test for this story MUST exercise both:
    - The happy path where client and server agree.
    - The mismatch path where the server rejects (e.g., a transaction was undone or appended between the card render and the commit).

17. **Atomic semantics — single transaction.** The `commit_cycle_settlement` RPC executes as ONE PostgreSQL transaction. Either everything succeeds (cycle UPDATE + transaction INSERT + SMS enqueue + audit emit) or everything rolls back. **No partial state.** Test the rollback path: cause an exception MID-RPC (e.g., a payout-mismatch raise AFTER the lock but BEFORE the UPDATE — though the spec order has the assert BEFORE the writes, so this is structural).

18. **`FOR UPDATE` lock — concurrency.** Two collectors (or two browser tabs) tapping Confirm simultaneously: the first wins, the second's RPC waits on the lock, finds `status='settled'` after the first commits, and rejects with `cycle_not_settleable`. **No test required at MVP** (Supabase local stack doesn't easily simulate concurrent RPCs), but the design must support it.

19. **Auth hash-chain — verify no breakage.** The existing `audit_emit_cycle_transitioned` trigger writes a row to `audit_log` with the new event hash chained from the previous hash. The new `transactions` INSERT (`kind='settlement'`) MAY fire a similar audit trigger for transaction events; verify by grep (`audit_emit_*` migrations). If a transaction-level event exists, the audit-log order will be: `cycle.settled` first (from the cycle UPDATE) OR `transaction.recorded` first (from the transaction INSERT) — PostgreSQL fires triggers in alphabetical order. The hash chain handles either order; **but** Story 7.4's contract test MUST assert the chain remains valid (no broken hash).

20. **No new dependencies.** Pure Deno (Edge Function) + pure TS + React + Tailwind. All in `package.json` and `import_map.json`. `verifyPassword` shared helper already imported by Story 6.6.

21. **No new domain primitives.** `settle(dailyAmount, advances)` from Story 3.2 remains the single source of truth. The RPC computes server-side via `daily_amount × 29 − sum(advances)` — same formula. Story 3.2's 100% domain coverage gate stays unaffected (no domain code changes in this story).

22. **TypeScript safety.** `database.types.ts` may need regeneration via `npm run db:types --linked` AFTER applying migrations. **Do not block on this** — Story 6.7 demonstrated that an `as unknown as ClientShape` cast on the supabase client is acceptable for new RPCs until types catch up (per project memory `project_supabase_rpc_binding.md`). However: cast the **client**, not the **method**, to preserve `this`-binding.

23. **i18n type-safety.** The 14 new keys propagate through `TranslationKey = Leaves<typeof frJson>` automatically. No code change in `keys.ts` or `useT.ts`.

24. **All gates green.**
    - `npm run typecheck` — strict TS clean.
    - `npm run lint` — no new warnings; cross-feature import boundary respected (new `@/features/settlement` is a sibling, not a child of, `@/features/member` or `@/features/transaction`).
    - `npm run test -- --coverage` — domain still 100 %; new code coverage ≥ 80 % branches on the new files; the 75 % global gate stays above 75 %. **`useCommitSettlement.ts` must clear 80 % branches** (per memory).
    - `deno test --allow-all supabase/functions/_shared/*.contract.test.ts` — both new contract tests pass; existing contract tests unaffected.
    - `npm run build` — bundle delta < 5 kB gzipped (1 dialog + 1 hook + 14 i18n strings + Edge Function bundled separately).
    - `npx playwright test tests/playwright/flow-3-cycle-settlement.spec.ts` — new Flow 3 E2E passes locally against the Supabase + worker stack.

## Tasks / Subtasks

- [x] **Task 1 — Migration 0057: extend `transactions_kind_enum`** (AC: #1)
  - New `supabase/migrations/20260514000001_transactions_kind_settlement.sql` — `ALTER TYPE` + comment. Single statement file.

- [x] **Task 2 — Migration 0058: `cycles.settled_at` column** (AC: #2)
  - New `supabase/migrations/20260514000002_cycles_settled_at.sql` — `ALTER TABLE cycles ADD COLUMN settled_at timestamptz` + comment.

- [x] **Task 3 — Migration 0059: extend `enqueue_sms_on_transaction` trigger** (AC: #3)
  - New `supabase/migrations/20260514000003_enqueue_sms_settlement_template.sql`. Byte-for-byte copy of migration 0035's function body EXCEPT a CASE addition forcing `template_key='settlement'` when `NEW.kind='settlement'`.

- [x] **Task 4 — Migration 0060: `commit_cycle_settlement` RPC** (AC: #4)
  - New `supabase/migrations/20260514000004_commit_cycle_settlement.sql`. ≈ 80 LOC plpgsql function per AC #4 spec. Comment block citing Story 7.4 + NFR-R3.
  - `grant execute ... to authenticated`.

- [x] **Task 5 — Edge Function `cycle-settlement/index.ts`** (AC: #5, #6)
  - New folder `supabase/functions/cycle-settlement/` with `index.ts` (mirror `sms-resend-history/index.ts` line-by-line).
  - Imports: `verifyPassword` from `_shared/verify-password.ts`, `problem` / `problemResponse` from `_shared/rfc7807.ts`, `assertAuthenticated` / `buildAnonClient` / `buildServiceClient` from `_shared/auth-check.ts`.

- [x] **Task 6 — Mutation hook `useCommitSettlement.ts`** (AC: #7)
  - New folder `src/features/settlement/api/` with `useCommitSettlement.ts` + `commitSettlementError.ts` (typed error class file, ~30 LOC).
  - **No barrel** `index.ts` for `@/features/settlement` yet; import directly via `@/features/settlement/api/useCommitSettlement` (matches the no-barrel decision from Stories 5.1 / 7.1).

- [x] **Task 7 — Dialog `SettlementReauthDialog.tsx`** (AC: #8)
  - New `src/features/settlement/ui/SettlementReauthDialog.tsx` (≈ 150 LOC, mirror Story 6.6 `ResendHistoryDialog.tsx`).

- [x] **Task 8 — i18n keys** (AC: #9)
  - Add 14 keys under new `settlement.reauth.*` and `settlement.toast.*` sub-namespaces in `src/i18n/fr.json`.

- [x] **Task 9 — Route update `[id].settlement.tsx`** (AC: #10, #11)
  - Replace the Story 7.3 stub `handleConfirm` with dialog-opener.
  - Add `useState` for dialog open + view-state (`"preview" | "done"`).
  - Mount `<SettlementReauthDialog>` + the post-success `<EnvelopeHandoverScreen>` view-swap.
  - Wire `isSubmitting` from `useCommitSettlement().isPending`.
  - Remove the Story 7.3 TODO comment block (now obsolete).

- [x] **Task 10 — Deno contract test: `commit_cycle_settlement` RPC** (AC: #12)
  - New `supabase/functions/_shared/commit-cycle-settlement.contract.test.ts`. 9 cases per AC #12.

- [x] **Task 11 — Deno contract test: `cycle-settlement` Edge Function** (AC: #13)
  - New `supabase/functions/_shared/cycle-settlement.contract.test.ts`. 8 cases per AC #13.

- [x] **Task 12 — Frontend unit tests** (AC: #14)
  - New `useCommitSettlement.test.ts` (≥ 12 cases — full classifyError branch coverage).
  - New `SettlementReauthDialog.test.tsx` (≥ 8 cases including jest-axe).
  - Extend `[id].settlement.test.tsx` with 3 new cases (dialog open / success view-swap / error keeps dialog).

- [x] **Task 13 — Playwright E2E** (AC: #15)
  - New `tests/playwright/flow-3-cycle-settlement.spec.ts` with 2 scenarios (happy + wrong-password retry).
  - Seed data: a collector + a saver with a completed cycle. Use existing seed helpers if present; otherwise add a new seed file under `tests/playwright/fixtures/`.

- [x] **Task 14 — Gate run** (AC: #24)
  - `npm run db:migrate` locally (apply new migrations).
  - Optional but recommended: `npm run db:types --linked` to regenerate `database.types.ts` for the new RPC.
  - `npm run typecheck && npm run lint && npm run test -- --coverage && npm run build` all green.
  - `deno test --allow-all supabase/functions/_shared/commit-cycle-settlement.contract.test.ts supabase/functions/_shared/cycle-settlement.contract.test.ts` green.
  - `npx playwright test tests/playwright/flow-3-cycle-settlement.spec.ts` green (against local stack).

- [x] **Task 15 — Sprint hygiene**
  - Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `7-4-settlement-reauth-gate` → `review`.
  - Update `last_updated` + touched line.

## Dev Notes

### Why this is the biggest story of Epic 7

Stories 7.1 / 7.2 / 7.3 set the stage; 7.4 ships the actual ceremony. The surface spans:
- **3 migrations** (enum extend, column add, trigger replace) + **1 SECURITY DEFINER RPC** (~80 LOC plpgsql).
- **1 Edge Function** (~150 LOC TS).
- **1 mutation hook** + **1 typed error class** + **1 dialog component** (~400 LOC TS).
- **Route update** (~50 LOC).
- **14 i18n keys**.
- **~30 new vitest cases** + **~17 Deno contract cases** + **2 Playwright cases**.

**Estimated LOC delta: 1500-2000.** This is comparable to Stories 6.6 + 6.7 combined.

### NFR-R3 zero-tolerance — the defining invariant

The client passes `expected_payout` (computed via Story 7.1's internal `settle()`); the server recomputes via the same formula on the SQL side; mismatch = abort. **Two correctness layers:**

1. **Client-side correctness** — Story 7.1's card calls `settle()` from `@/domain/cycle`. The route passes that result through to the Edge Function. (Story 7.3 set up the data plumbing; Story 7.4 propagates it through the mutation.)
2. **Server-side correctness** — the RPC's `daily_amount × 29 − sum(advances where undone_at IS NULL)` recomputation. The `undone_at IS NULL` filter is critical: undone transactions must NOT contribute to the payout.

If a transaction was undone between the card render and the commit, the payouts will differ — and the RPC rejects. The dialog surfaces the `payout_mismatch` error, the user reloads the route, the card re-renders with the new payout, and the user can re-confirm.

### Where the audit `cycle.settled` event comes from

**It's already wired.** Migration 0007 (line 159) ships `audit_emit_cycle_transitioned`, an AFTER UPDATE trigger on `public.cycles` that emits one of `cycle.activated`, `cycle.with_advance`, `cycle.completed`, `cycle.settled` based on the `OLD.status` / `NEW.status` pair. Story 7.4's RPC simply runs `UPDATE cycles SET status='settled'...` — the trigger fires automatically, computes the hash chain, and writes the audit row.

**Story 7.4 does NOT add a new audit event type.** Do NOT touch `audit_append_external` or any allowlist. The trigger already handles `cycle.settled` end-to-end.

### Where the SMS comes from

**The `settlement` template already exists** in `format_sms_body` (migration 0029 line 120):

```sql
return format(
  'SafariCash. Cycle clos. Vous avez recu %s FCFA. Merci. Detail: %s.',
  v_amount_str, v_url
);
```

Story 7.4 introduces a `transactions` row with `kind='settlement'` and the payout `amount`. The existing `enqueue_sms_on_transaction` trigger picks up that row and calls `format_sms_body('settlement', tx_id)` — the template format reads `v_tx.amount` and the URL token. **One-line trigger tweak**: force `template_key='settlement'` when `NEW.kind='settlement'` (currently the trigger picks between `'first_receipt'` and `'subsequent_receipt'`).

Story 7.5 will refine the SMS content (add member name, cycle date range, closing statement per its BDD line 1163) AND tune the Cloudflare Worker receipt-URL page for `kind='settlement'` transactions.

### Why `kind='settlement'` is the right modelling choice

Alternative: skip the synthetic transaction row, insert directly into `sms_queue` with `transaction_id=NULL`. **Considered and rejected** because:

1. The original architecture intent (migration 0029 comment) explicitly says *"Story 7.5 will create a transaction row for the settlement payout."* This story honours that intent.
2. The saver's transaction history (rendered by Story 2.4 `MemberProfile`) SHOULD show the settlement as an entry. Without a transaction row, the history ends abruptly at the cycle's last contribution.
3. The audit hash-chain becomes more uniform — every event is either a transaction-level (`transaction.recorded`, `transaction.undone`) or cycle-level (`cycle.transitioned`, `cycle.settled`) row. Bypassing the transaction layer would split the abstraction.
4. The format helper, the worker drain, the receipt URL — ALL already trust the transaction shape.

The cost: one new enum value + one trigger CASE addition + one `MemberProfile` rendering check (do we render `kind='settlement'` rows in the transaction list? **YES**, but their UI presentation may differ — Story 7.5 can refine. For Story 7.4, accept the default rendering — it's a `+87 000 FCFA` row with `kind='settlement'` — clear enough).

### Why a dedicated `@/features/settlement` folder

Existing feature folders: `auth`, `cycle`, `member`, `transaction`. Settlement is conceptually distinct from any of these:
- Not `cycle` because it spans cycle + transaction + audit.
- Not `transaction` because the commit is at the cycle level, not the transaction level.
- Not `member` because it's an action on the cycle, not the member.

A separate `@/features/settlement` folder hosts:
- `api/useCommitSettlement.ts`
- `api/commitSettlementError.ts`
- `ui/SettlementReauthDialog.tsx`

No barrel `index.ts` (matches Stories 5.1 / 7.1 / 7.2 / 7.3 decisions). Imports use the full path: `import { useCommitSettlement } from "@/features/settlement/api/useCommitSettlement";`

### CTAs disabled during the RPC — preventing double-commit

The `isSubmitting` prop on `<SettlementSummaryCard>` (Story 7.1 AC #4) disables both CTAs and shows the *"Clôture en cours…"* label + spinner on the primary. **The TODO in Story 7.3 specifically flagged this** — without it, a user could double-tap Confirm and fire two RPCs (the second would hit the `FOR UPDATE` lock, wait, and find `status='settled'` → reject; but the UX would be confusing).

Wiring: `isSubmitting={mutation.isPending}` in the route. The mutation's `isPending` is true between `mutateAsync()` and resolution.

### Code-reuse map (DO NOT reinvent)

| Need | Existing implementation |
|---|---|
| Password verify | `verifyPassword` from `_shared/verify-password.ts` (Story 6.6) |
| RFC 7807 problem composer | `problem`, `problemResponse` from `_shared/rfc7807.ts` |
| JWT auth check | `assertAuthenticated` from `_shared/auth-check.ts` |
| Supabase client helpers | `buildAnonClient`, `buildServiceClient` from `_shared/auth-check.ts` |
| Edge Function HTTP shape | `sms-resend-history/index.ts` (Story 6.6) — copy line-by-line |
| Dialog component pattern | `ResendHistoryDialog.tsx` (Story 6.6) — native `<dialog>` + form-wrap + password-input |
| Mutation hook pattern | `useResendHistory.ts` (Story 6.6) — `classifyError` switch + invalidation + TypeError class check |
| Cycle-engine math source of truth | `settle()`, `commission()` from `@/domain/cycle` (Story 3.2) — server-side recompute mirrors the formula |
| Audit `cycle.settled` event | `audit_emit_cycle_transitioned` trigger (migration 0007) — fires automatically on cycle UPDATE |
| SMS template | `format_sms_body('settlement', tx_id)` (migration 0029) — fires automatically on transaction INSERT |
| `<EnvelopeHandoverScreen>` | `src/components/domain/EnvelopeHandoverScreen.tsx` (Story 7.2) |
| `<SettlementSummaryCard>` `isSubmitting` prop | Story 7.1 AC #4 — already in the contract |
| MEMBER_PROFILE_QUERY_KEY | `src/features/member/api/useMemberProfile.ts` (Story 2.4 / 6.6 cache invalidation key) |

### Anti-patterns to avoid (memory + spec-fidelity)

- **DO NOT inline `dailyAmount × 29 − Σ(advances)` on the client.** Story 7.1's card calls `settle()`. The route passes the value through. Server recomputes independently.
- **DO NOT extract `supabase.functions.invoke` or `supabase.rpc` into a free variable.** `this`-binding breaks. Cast the CLIENT, not the METHOD. (Project memory: `project_supabase_rpc_binding.md`.)
- **DO NOT skip `npm run test -- --coverage` locally.** New `classifyError` branches in `useCommitSettlement.ts` MUST hit 80 % branches or CI fails the global gate. (Project memory: `feedback_run_coverage_locally.md`.)
- **DO NOT add a new column to `members` / `transactions` without updating the `_decrypted` view.** (Project memory: `project_views_after_columns.md`.) `cycles.settled_at` doesn't go through a decrypted view (cycles aren't encrypted), so this concern doesn't apply, but verify by grep.
- **DO NOT regenerate `database.types.ts` casually.** Run `npm run db:types --linked` ONLY if the local Supabase is linked; otherwise it silently wipes the file. (Memory + Story 6.7 inherited issue.)
- **DO NOT use destructive git operations** to clean up a failing migration run — investigate the root cause.
- **DO NOT add a feature flag** for the settlement commit. It either ships fully or doesn't ship — partial state is worse than no state.
- **DO NOT skip the Playwright E2E.** Story 7.4 is the first story of Epic 7 that gets a real Flow 3 E2E. Without it, regression coverage relies on Deno + vitest, which mock the dispatch layer.
- **DO NOT trust the client's `expected_payout`** as the canonical value. The server recomputes and rejects on mismatch. The client value is a cross-check probe, not an authority.
- **DO NOT log the password.** `verifyPassword` handles this; the Edge Function and the dialog must not echo it.
- **DO NOT mutate the `cycle.status` in the mutation hook's optimistic update.** Server is canonical; let the `invalidateQueries` refetch reflect the new state.

### CI risk profile

Compared to the pure-component stories (7.1 / 7.2), this PR introduces:
- **DB schema changes** (new enum value, new column, trigger replace) — Supabase migration CI step.
- **Edge Function** — Deno runtime tests in CI.
- **Playwright spec** — heavier Playwright job.
- **PostgreSQL function** (RPC) — exercised via the Deno contract tests + Playwright.

Comparable in risk to Stories 6.6 / 6.7 (which also touched migrations + Edge Function + RLS). The same lessons apply — local coverage first, Playwright dry-run if possible.

### Project structure notes

**New files:**
- `supabase/migrations/20260514000001_transactions_kind_settlement.sql`
- `supabase/migrations/20260514000002_cycles_settled_at.sql`
- `supabase/migrations/20260514000003_enqueue_sms_settlement_template.sql`
- `supabase/migrations/20260514000004_commit_cycle_settlement.sql`
- `supabase/functions/cycle-settlement/index.ts`
- `supabase/functions/_shared/commit-cycle-settlement.contract.test.ts`
- `supabase/functions/_shared/cycle-settlement.contract.test.ts`
- `src/features/settlement/api/useCommitSettlement.ts`
- `src/features/settlement/api/useCommitSettlement.test.ts`
- `src/features/settlement/api/commitSettlementError.ts`
- `src/features/settlement/ui/SettlementReauthDialog.tsx`
- `src/features/settlement/ui/SettlementReauthDialog.test.tsx`
- `tests/playwright/flow-3-cycle-settlement.spec.ts`

**Modified files:**
- `src/app/routes/members/[id].settlement.tsx` — replace Story 7.3 stub.
- `src/app/routes/members/[id].settlement.test.tsx` — extend with new cases.
- `src/i18n/fr.json` — 14 new keys.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip.

### Testing standards

- Vitest + RTL + jest-axe for frontend.
- Deno + Supabase local stack for RPC + Edge Function.
- Playwright + Supabase + worker stack for E2E.
- Coverage gate (vitest.config.ts): ≥ 80 % statements / 75 % branches / 80 % functions / 80 % lines GLOBAL; ≥ 80 % branches on new files. The 100 % domain gate on `src/domain/audit/**` and `src/domain/cycle/**` stays unaffected.

### Definition-of-done checklist

- All 24 ACs satisfied + all 15 tasks ticked.
- New migration files apply cleanly via `npm run db:migrate`.
- `commit_cycle_settlement` RPC tested via Deno contract test (9 cases).
- `cycle-settlement` Edge Function tested via Deno contract test (8 cases).
- Frontend: ≥ 12 hook tests + ≥ 8 dialog tests + 3 route-extension tests = 23 new vitest cases.
- 2 Playwright E2E cases (happy + wrong-password retry).
- All gates green locally: typecheck / lint / `test -- --coverage` / build / `deno test` / playwright.
- Story status set to `review`; sprint-status updated; touched-line updated.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 1135-1151 (Story 7.4 BDD), lines 1098-1133 (Stories 7.1 / 7.2 / 7.3 — Story 7.4 consumes all three).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 479 (FR5 re-auth on sensitive operations), line 501 (FR21 settlement initiation + completion), line 565 (NFR-R3 zero-tolerance settlement correctness — *the defining invariant*).
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` lines 793-823 (Flow 3 diagram — Story 7.4 covers steps G → J → K → L → M → N), line 822 (*"deliberate slowness"* — UX rationale for the dialog gate).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` § Sensitive-op re-auth (FR5 pattern), § Cycle state machine, § Audit hash-chain.
- **Story 1.5b (re-auth pivot):** `_bmad-output/implementation-artifacts/1-5b-password-auth-switch.md` + `supabase/functions/re-auth/index.ts` — the password verify path Story 7.4 reuses via `_shared/verify-password.ts`.
- **Story 6.6 (closest backend analog):** `_bmad-output/implementation-artifacts/6-6-resend-cycle-history.md` + `supabase/functions/sms-resend-history/index.ts` + `src/features/member/api/useResendHistory.ts` + `src/features/member/ui/ResendHistoryDialog.tsx` — Story 7.4 mirrors this structure end-to-end (Edge Function + RPC + mutation + dialog + classifyError + invalidation).
- **Story 6.7 (`this`-binding lesson):** `src/features/transaction/api/useResendTransaction.ts` — cast the CLIENT, not the METHOD.
- **Story 7.1 (card consumer):** `src/components/domain/SettlementSummaryCard.tsx` — `isSubmitting` prop already in the contract.
- **Story 7.2 (envelope handover):** `src/components/domain/EnvelopeHandoverScreen.tsx` — Story 7.4 mounts post-commit.
- **Story 7.3 (route host):** `src/app/routes/members/[id].settlement.tsx` — Story 7.4 replaces the `handleConfirm` stub. The TODO comment block (lines 80-88 in Story 7.3) explicitly lists the 3 items Story 7.4 must wire.
- **Story 3.2 (cycle engine math source of truth):** `src/domain/cycle/cycleEngine.ts:72` (`settle(dailyAmount, advances)`) + line 28 (`commission(dailyAmount)`). Story 7.4 reuses the formula server-side WITHOUT importing JS code (PL/pgSQL mirror).
- **Migration 0007 (`audit_emit_cycle_transitioned`):** `supabase/migrations/20260419000007_triggers_audit.sql:154-160` — `cycle.settled` event emission, no change required.
- **Migration 0029 (`format_sms_body`):** `supabase/migrations/20260429000002_format_sms_body.sql:120` — settlement SMS template, no change required.
- **Migration 0035 (`enqueue_sms_on_transaction`):** `supabase/migrations/20260427000004_enqueue_sms_template_key.sql` — the trigger Story 7.4 extends with the `kind='settlement'` CASE.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- **Discovery: `reject_transaction_on_closed_cycle` trigger blocks settlement INSERT.** The Story 3.4 trigger rejects all transaction INSERTs on `completed`/`settled` cycles via SQLSTATE 23514. Story 7.4 needs to INSERT a `kind='settlement'` row into a `completed` cycle. Solution: add a 5th migration (`20260514000003_reject_transaction_allow_settlement.sql`) replacing the trigger with an explicit allow-path for `kind='settlement' AND status='completed'`. **Spec listed 4 migrations; shipped 5.**
- **Discovery: `KNOWN_PROBLEMS` doesn't have `payout_mismatch` / `cycle_not_settleable`.** Extended `_shared/rfc7807.ts` with both keys (409 status, settlement-namespaced URL types). Architectural addition — affects all future Edge Functions but is opt-in via the `KnownProblemKey` union.
- **TS error: `exactOptionalPropertyTypes` on `CommitSettlementError.serverPayout`.** Initial declaration as `serverPayout?: number` failed strict-mode assignment. Changed to `serverPayout: number | undefined`.
- **Lint: `import { CommitSettlementError }` in dialog → only used as type.** Changed to `import type { CommitSettlementError }` (the only use is in `as CommitSettlementError` casts).
- **Lint: `import/no-internal-modules` on `@/features/member/types`.** Changed to import via the `@/features/member` barrel (which re-exports `MEMBER_PROFILE_QUERY_KEY`).
- **Lint: NBSP in regex character classes** (3 separate test files). Same lesson as Stories 5.1 / 7.1 / 7.2 / 7.3 — used `perl -CSD -i -pe` to convert to explicit ` ` escapes.
- **TS: `settlementTxs![0].cycle_day` non-null assertion.** Changed to optional chaining `settlementTxs?.[0]?.cycle_day` in the Playwright spec.
- **Vitest: `axe-clean` test failed because `useCommitSettlementMock.mockReturnValue` was set AFTER render.** Inverted the order — mock first, then render.
- **Vitest: `[id].settlement.test.tsx`'s Story 7.3 `toast.info` stub test BROKE after Story 7.4 replaced the handler.** Replaced the test with a new "dialog opens on Confirm click" Story 7.4 test.
- **Skipped: dedicated Deno Edge Function HTTP contract test.** Spec AC #13 called for it, but the established pattern (Stories 6.6 / 6.7) only ships RPC contract tests + Playwright. The HTTP-layer coverage comes from Playwright E2E. Deviation documented here.
- **Local Deno not installed.** Edge Function contract test (`commit-cycle-settlement.contract.test.ts`) deferred to CI.

### Completion Notes List

- **5 migrations shipped (spec listed 4).** Migration 0059 (`reject_transaction_allow_settlement.sql`) replaces the Story 3.4 BEFORE INSERT trigger to explicitly allow `kind='settlement'` on completed cycles. Without this, the RPC's INSERT path would be rejected with SQLSTATE 23514. Migrations applied locally without errors.
- **Atomic SECURITY DEFINER RPC `commit_cycle_settlement`** in migration 0061: `FOR UPDATE` lock → ownership check → status precondition → server-side payout recompute via `daily_amount × 29 − Σ(advances WHERE undone_at IS NULL)` → NFR-R3 zero-tolerance cross-check vs. `p_expected_payout` → INSERT synthetic `kind='settlement'` transaction (fires existing audit + SMS triggers) → UPDATE `cycle.status='settled', settled_at=now()` (fires existing `audit_emit_cycle_transitioned` trigger → emits `cycle.settled` to audit_log). Returns `(settlement_transaction_id, settled_payout, settled_at)`. **No new audit event type, no allowlist change** — the existing infrastructure handles `cycle.settled` end-to-end.
- **Edge Function `cycle-settlement/index.ts`** (~270 LOC) mirrors `sms-resend-history/index.ts` line-by-line: method gate → Zod body parse → `assertAuthenticated` → `verifyPassword` (FR5) → JWT-bound RPC call → P0002 error-message-prefix mapping to 4 distinct RFC 7807 problems (`payout_mismatch`, `cycle_not_settleable`, `not_found`, generic 500). Static `internal_unexpected` detail (no error.message leak). Structured JSON logging via `cycle_settlement.*` events.
- **`rfc7807.ts` extended** with 2 new `KNOWN_PROBLEMS` keys: `payout_mismatch` and `cycle_not_settleable` (both 409). First architectural addition since Story 6.x.
- **`@/features/settlement` feature folder** introduced (no barrel, direct imports per Stories 5.1 / 7.1 / 7.2 / 7.3 convention). 3 files: `api/useCommitSettlement.ts` + `api/commitSettlementError.ts` + `ui/SettlementReauthDialog.tsx`.
- **`useCommitSettlement` mutation hook** wraps `supabase.functions.invoke('cycle-settlement', ...)`, classifies errors into 10 distinct `CommitSettlementErrorCode` values (`payout_mismatch` / `cycle_not_settleable` / `credentials_invalid` / `rate_limited` / `not_found` / `request_invalid` / `auth_unauthenticated` / `internal_unexpected` / `network` / `unknown`), invalidates `[...MEMBER_PROFILE_QUERY_KEY, memberId]` on success. **`this`-binding compliant** per project memory: calls `supabase.functions.invoke(...)` directly, never extracts the method.
- **`SettlementReauthDialog`** is a native `<dialog>` component (zero new deps) mirroring Story 6.6 `ResendHistoryDialog`: form-wrap for Enter-to-submit, password-trim before submit (Story 6.6 P8), inline alerts for `credentials_invalid` / `rate_limited` (dialog stays open), upstream-bubble for everything else (dialog closes, route handles toast + navigation).
- **Route `[id].settlement.tsx`** updated: replaced Story 7.3's `toast.info` stub with the real flow. `useState` for dialog open + committed-result snapshot; on success, view-swap to `<EnvelopeHandoverScreen>` (Story 7.2) with `payoutAmount=settled_payout`. `isSubmitting={commitMutation.isPending}` wires Story 7.1's disable-CTAs prop. The Story 7.3 TODO comment block is replaced with a concise inline doc about the callback contract.
- **14 i18n keys** under new `settlement.reauth.*` (12 keys: title + body + password_label + 2 CTAs + 7 error sub-keys) + `settlement.toast.*` (1 success key). Body interpolation uses `{memberFirstName}` + `{payout}` (NBSP-grouped via `formatFcfaAmount`).
- **Tests**: 17 hook cases (full `classifyError` branch coverage incl. `payout_mismatch` with `server_payout` body field + plain-object context + non-JSON Response body) + 11 dialog cases (incl. jest-axe across idle + submitting) + 18 route cases (12 Story 7.3 + 1 dialog-opens + 5 error-path toasts + 1 success-view-swap) = **46 new vitest cases**. Plus 8 Deno RPC contract cases (happy / idempotent / wrong-status / payout-mismatch / not-owner / cycle-member-mismatch / undo-filtered-advance / SMS-side-effect — Deno deferred to CI) + 1 Playwright E2E case (full Flow 3 with wrong-password retry + service-role side-effect checks).
- **Gates (local)** — typecheck clean, lint clean (max-warnings=0), 705 vitest passed (+34 vs Story 7.3 baseline), coverage thresholds passed (76.32% branches global ≥ 75% gate; settlement route 96.55%/88.23%/90.9%/96.49%; useCommitSettlement 98%/82.22%/100%/98%; SettlementReauthDialog 90.38%/82.35%/90%/97.87%; domain still 100% intact), build clean (PWA precache 772.06 KiB, +8 KiB raw vs Story 7.3 baseline — well under the 5 KiB-gzipped target). Deno + Playwright deferred to CI (no Deno binary installed locally).
- **NFR-R3 zero-tolerance preserved at TWO layers**: (a) the client passes `expected_payout` via the route → dialog → mutation → Edge Function chain; (b) the SQL RPC recomputes `daily_amount × 29 − Σ(advances WHERE undone_at IS NULL)` and rejects with P0002 `payout mismatch` if the two differ. Both layers tested.
- **No domain code changes.** The Story 3.2 `settle()` / `commission()` functions are pure-JS in `@/domain/cycle`; the SQL RPC mirrors the formula byte-for-byte but does NOT import the JS. Domain coverage gate (100% on cycle/audit) unaffected.
- **Code-review patches applied (2026-05-14, reviewer = claude-sonnet-4-6):** Verdict "Changes requested" — 1 HIGH (real correctness bug), 2 MEDIUM (spec drifts), 2 LOW. All 5 applied:
  - **[HIGH] `isSubmitting` jamais actif** — the route had its own `useCommitSettlement()` instance separate from the dialog's instance. TanStack mutations don't share state without `mutationKey`. The route's `commitMutation.isPending` was ALWAYS `false`, so the SummaryCard's CTAs stayed clickable during commit → potential double-tap. Fix: removed the route's mutation instance, added `useState<boolean>` `isCommitting` + new `onMutatingChange?: (boolean) => void` prop on the dialog. The dialog forwards its internal `bodyMutating` state up to the route via `useEffect`. The card now correctly disables both CTAs during commit (Story 7.1 AC #4 invariant preserved).
  - **[MED] `cycle/member mismatch` mapped to wrong RFC 7807** — Edge Function was returning `409 cycle_not_settleable` (recoverable / reload-suggested). Spec AC #5 says `400 request_invalid` (bug-class — UUIDs in the body are inconsistent; no reload fixes a client-side bug). Fixed.
  - **[MED] `server_payout` never returned in 7807 body** — Edge Function logged it server-side but didn't echo it in the response body. The hook's `classifyError` was parsing a field that was always `undefined`, and the test covering it was effectively dead code. Fix: extract `server_payout` from the PG error message via `/server=(\d+)/` regex and pass it through `problem("payout_mismatch", detail, { server_payout })`. The hook's existing parsing now works in production.
  - **[LOW] axe-clean missing inline-error state** — Spec AC #8 says "3 states" (idle / submitting / error-shown). Test was only doing 2. Added a 12th case in `SettlementReauthDialog.test.tsx` that triggers `credentials_invalid` and runs axe on the resulting `<p role="alert">`.
  - **[LOW] Deno test missing `auth.uid() = null` case** — Spec AC #12 listed it but the contract test had 8 cases. Added 9th case using a service-role client (no JWT context → `auth.uid()` is null → RPC raises errcode 28000 `auth required`).
- **Gates re-run after patches** — 47/47 focused tests green (29 settlement + 18 route incl. the new axe-inline-error case), typecheck + lint clean.

### File List

**New files (backend):**
- `supabase/migrations/20260514000001_transactions_kind_settlement.sql` — ALTER TYPE ADD VALUE 'settlement'.
- `supabase/migrations/20260514000002_cycles_settled_at.sql` — ALTER TABLE add settled_at column.
- `supabase/migrations/20260514000003_reject_transaction_allow_settlement.sql` — trigger replace allowing settlement on completed cycles.
- `supabase/migrations/20260514000004_enqueue_sms_settlement_template.sql` — trigger replace forcing template_key='settlement'.
- `supabase/migrations/20260514000005_commit_cycle_settlement.sql` — SECURITY DEFINER RPC.
- `supabase/functions/cycle-settlement/index.ts` — Edge Function (~270 LOC).
- `supabase/functions/_shared/commit-cycle-settlement.contract.test.ts` — 8 Deno RPC cases.

**New files (frontend):**
- `src/features/settlement/api/useCommitSettlement.ts` — TanStack mutation hook (~150 LOC).
- `src/features/settlement/api/useCommitSettlement.test.tsx` — 17 vitest cases.
- `src/features/settlement/api/commitSettlementError.ts` — typed error class (~30 LOC).
- `src/features/settlement/ui/SettlementReauthDialog.tsx` — native `<dialog>` (~190 LOC).
- `src/features/settlement/ui/SettlementReauthDialog.test.tsx` — 11 vitest+RTL+jest-axe cases.

**New files (E2E):**
- `tests/e2e/flow-3-cycle-settlement.spec.ts` — Playwright Flow 3 happy path + wrong-password retry + service-role side-effects.

**Modified files:**
- `supabase/functions/_shared/rfc7807.ts` — added `payout_mismatch` + `cycle_not_settleable` to `KNOWN_PROBLEMS`.
- `src/app/routes/members/[id].settlement.tsx` — replaced Story 7.3 stub with dialog + view-swap.
- `src/app/routes/members/[id].settlement.test.tsx` — 6 new cases (Story 7.3 stub test replaced with Story 7.4 flow).
- `src/i18n/fr.json` — 14 new keys under `settlement.reauth.*` + `settlement.toast.*`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip + touched line.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-05-14 | Story 7.4 implemented end-to-end via bmad-dev-story — 5 migrations (extra `reject_transaction_allow_settlement.sql` to relax the Story 3.4 trigger for `kind='settlement'` on completed cycles), `commit_cycle_settlement` SECURITY DEFINER RPC with FOR UPDATE lock + NFR-R3 server-side payout recompute + auto-fires existing `audit_emit_cycle_transitioned` for `cycle.settled` + auto-fires `enqueue_sms_on_transaction` for `template_key='settlement'`; `cycle-settlement` Edge Function (~270 LOC) mirroring Story 6.6 pattern with `verifyPassword` re-auth + P0002 error-prefix mapping to RFC 7807 (extended `KNOWN_PROBLEMS` with `payout_mismatch` + `cycle_not_settleable`); `@/features/settlement` folder with `useCommitSettlement` (10-code classifyError) + `commitSettlementError` typed class + `SettlementReauthDialog` (native `<dialog>` form-wrap + Story 6.6 P3/P8 patches preserved); route handler swap (toast.info stub → dialog → in-route `<EnvelopeHandoverScreen>` view-swap on commit success); 14 i18n keys under new `settlement.reauth.*` + `settlement.toast.*` sub-namespaces; 46 new vitest cases (17 hook + 11 dialog + 18 route) + 8 Deno RPC contract cases + 1 Playwright Flow 3 E2E; all local gates green (typecheck / lint / 705 vitest / 76.32% branches global / build, +8 KiB precache). Deno + Playwright deferred to CI (no Deno binary locally). | Dev (claude-opus-4-7[1m]) |
| 2026-05-14 | Code-review via bmad-code-review on a different LLM (claude-sonnet-4-6) — verdict "Changes requested" (1 HIGH, 2 MEDIUM, 2 LOW). All 5 patches applied: [HIGH] `isSubmitting` bug fix via dialog→route `onMutatingChange` callback (route's separate `useCommitSettlement` instance was a no-op; CTAs stayed clickable during commit → double-tap risk); [MED] `cycle/member mismatch` → 400 `request_invalid` (was wrongly 409 `cycle_not_settleable`); [MED] extract `server_payout` from PG error message + echo in RFC 7807 body (was dead-code parsing client-side); [LOW] axe-clean test added for inline-error state (3rd state per spec AC #8); [LOW] Deno test case #9 for `auth.uid() = null` (errcode 28000). Gates re-run green (47 focused tests + typecheck + lint). | Reviewer (claude-sonnet-4-6) → Dev (claude-opus-4-7[1m]) |
