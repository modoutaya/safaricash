# Story 2.6: Delete a member with typed "SUPPRIMER" confirmation and re-auth

Status: review

## Story

As a **collector**,
I want **deletion of a member to require a typed "SUPPRIMER" confirmation and a password re-auth**,
so that **accidental or unauthorized deletions are impossible (FR11, consumes FR5 re-auth).**

> **PRD v1.3 carry-over.** The epic BDD (line 686) calls out "the re-auth Edge Function (Story 1.3) for OTP verification". The PRD v1.3 amendment (Story 1.5b) replaced SMS-OTP re-auth with **password re-auth** via `signInWithPassword`. This story consumes the *existing* `re-auth` Edge Function (already wired by Story 1.5b, accepts `operation_intent: "member_delete"`).

## Acceptance Criteria

> Numbered for traceability. Lines beginning with **Given/When/Then** are the BDD source from `epics.md` lines 681-692; the rest are spec-derived constraints required for a flawless implementation.

1. **Entry point.** The "Supprimer" placeholder button on `/members/:id` (currently disabled) becomes a real **destructive-styled** button labelled `Supprimer définitivement` (i18n key `members.profile.action_delete_full`). The button is **always visible** regardless of cycle status — a collector may need to delete a member with an active cycle (e.g., they enrolled the wrong person).

2. **Danger-zone dialog.** **Given** a member profile, **When** the collector taps "Supprimer définitivement", **Then** a centered modal opens showing:
   - The member's **avatar** (initials in primary-100 background, same as the profile header).
   - The member's **name** as the dialog heading.
   - A **summary** of what will be deleted: *"{N} transaction(s) sur {M} cycle(s) seront définitivement supprimés."* (computed from `useMemberProfile`'s data — `transactions.length` for the current cycle + an extra count query for total transactions across all cycles via the RPC's pre-flight stat). For MVP simplicity, derive both counts from the data we already fetched: `M = previousCycles.length + (currentCycle ? 1 : 0)`, `N` = total transactions across all cycles (will need a small query extension; see Task 3).
   - A red banner: *"Cette action est définitive et ne peut pas être annulée."*

3. **Step 1 — typed SUPPRIMER gate.** Below the summary: a labelled text input *"Tapez SUPPRIMER pour confirmer"*. The input accepts free text. The "Continuer" button is enabled iff `input.trim().toUpperCase() === "SUPPRIMER"` (case-insensitive per BDD line 684). On click → reveals the password step (the input + Continuer button get replaced by the step-2 surface; the typed SUPPRIMER input becomes a read-only confirmation badge above).

4. **Step 2 — password re-auth gate.** After step 1, the dialog shows:
   - A single password input (`type="password"`, `autoComplete="current-password"`, label *"Confirmez votre mot de passe"*).
   - A **destructive-tinted** "Supprimer définitivement" CTA, enabled iff `password.length > 0 && !isSubmitting`.
   - On click → POST `/functions/v1/re-auth` with `{ password, operation_intent: "member_delete" }` (Story 1.5b's existing function).
   - On 401 (`credentials_invalid`) → render inline `role="alert"` *"Mot de passe invalide. Réessayez."* AND clear the password field. **Stay on step 2** (do NOT close the dialog).
   - On 429 → render inline *"Trop de tentatives. Réessayez dans quelques minutes."*
   - On 200 → immediately call the `delete_member` RPC (AC #6) without a second user tap.

5. **Cancel + ESC handling.** A "Annuler" button is always present at the bottom of the dialog (in both step 1 and step 2). It closes the modal and resets the dialog state to step 1 with empty inputs. ESC also closes (native `<dialog>` behaviour). Cancel is disabled while the re-auth or RPC mutation is in flight (mid-mutation cancel could leave the user with an opaque state — the dialog must commit or fully reject).

6. **Atomic delete via RPC.** A new `SECURITY DEFINER` RPC `delete_member(p_id uuid)` (migration `20260425000001_delete_member.sql`) that:
   - Verifies `auth.uid()` is the member's `collector_id` (raises `28000 unauthorized` otherwise).
   - Per-member advisory lock (class_id `0x5AFC`, distinct from audit `0x5AFA` and cycle restart `0x5AFB`) so concurrent deletes are serialised.
   - Inside the lock, executes the cascade in dependency order:
     1. `DELETE FROM disputes WHERE transaction_id IN (SELECT id FROM transactions WHERE member_id = p_id)`
     2. `DELETE FROM sms_queue WHERE transaction_id IN (SELECT id FROM transactions WHERE member_id = p_id)`
     3. `DELETE FROM transactions WHERE member_id = p_id` — fires `transaction.deleted` audit per row
     4. `DELETE FROM cycles WHERE member_id = p_id` — fires `cycle.deleted` audit per row
     5. `DELETE FROM members WHERE id = p_id` — fires `member.deleted` audit
   - The DELETEs run in one Postgres transaction; any failure rolls all of them back (the user keeps their member intact).
   - Vault secrets (`vault.decrypted_secrets`) are **NOT** touched at MVP — Epic 10's `saver-delete` flow owns vault PII anonymisation. The audit trail still references the secret_ids in `audit_log.payload`, which is the architecture's intent (line 459: "hard-delete with anonymisation [where anonymisation lands in Epic 10]").

7. **Audit emission (preserved chain).** The `member.deleted` event fires automatically via the existing `audit_members` trigger (migration 0007 + Story 2.5's actor-JWT fix in 0017). The cascading `transaction.deleted` + `cycle.deleted` events are part of the architecture's event taxonomy (migration 0007 lines 152-164) and fire on the same chain — the audit walker can reconstruct the full deletion narrative from the cascade.

8. **No double-emit defence-in-depth.** The dialog's mutation guards against React StrictMode double-fire AND user double-tap via the same `useRef<boolean>` pattern as `useUpdateMember` / `useRestartCycle`. The RPC's per-member advisory lock is the second line of defence (a second concurrent call would block on the lock until the first finishes, then find no member and return `not_found`).

9. **Hook surface.** A new `useDeleteMember()` mirrors `useUpdateMember`/`useRestartCycle`:
   ```ts
   type DeleteMemberErrorCode = "unauthorized" | "not_found" | "network" | "unknown";
   ```
   Returns `void` on success. **Does NOT** call the re-auth function — re-auth is the dialog's responsibility, the hook only handles the post-re-auth RPC call. `onSuccess` invalidates `MEMBERS_QUERY_KEY` and **removes** the per-profile cache entry (`queryClient.removeQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, id] })`) since the profile no longer exists. The route handles navigation away.

10. **UI feedback + navigation.** On success: dialog closes → toast `"{name} supprimé ✓"` (`members.profile.delete.toast_success`) → `navigate("/members", { replace: true })` so back-button doesn't return to a phantom profile. On hook failure (rare — re-auth already passed): toast `"Échec de la suppression. Réessayez."` with the dialog still open so the user can retry.

11. **Wrong-word disabled state.** **Given** the collector has typed the wrong word, **When** they look at the Continuer button, **Then** the button stays `disabled` (matches BDD line 692 verbatim — the button never reaches a "click → error" state).

12. **Accessibility.** Dialog has `role="dialog"` (native `<dialog>` provides this) + `aria-labelledby` pointing to the member-name heading + `aria-describedby` pointing to the summary paragraph. Inputs have visible labels. The destructive CTA uses semantic destructive tokens (`bg-destructive text-destructive-foreground`). The dialog passes axe-clean (asserted in the E2E).

13. **i18n.** All copy lives under `members.profile.delete.*`. No hard-coded French strings in JSX.

## Tasks / Subtasks

- [ ] **Task 0 — DB migration (AC #6 #7).** Create `supabase/migrations/20260425000001_delete_member.sql`:
  - SECURITY DEFINER `delete_member(uuid)` returning `void`.
  - Auth check + ownership check + per-member advisory lock (0x5AFC).
  - Five DELETEs in dependency order (disputes → sms_queue → transactions → cycles → members).
  - GRANT EXECUTE TO authenticated.
  - Comment the function; note vault secrets are out-of-scope (Epic 10 owns that).
  - Run `npm run db:reset` locally + verify via `psql` that `audit_log` records the cascade.

- [ ] **Task 1 — Database type (AC #9).** Edit `src/infrastructure/supabase/database.types.ts`:
  - Add `delete_member: { Args: { p_id: string }; Returns: undefined }` under `Functions`.

- [ ] **Task 2 — `useDeleteMember` hook (AC #9 #10).** New file `src/features/member/api/useDeleteMember.ts`:
  - TanStack `useMutation<void, DeleteMemberError, string>` (input = memberId).
  - In-flight ref guard.
  - Calls `supabase.rpc("delete_member", { p_id })`.
  - `classifyError` covers the 4 codes from AC #9.
  - `onSuccess` invalidates `MEMBERS_QUERY_KEY` + REMOVES the per-profile cache entry.
  - Companion test file (RTL `renderHook`) — happy path + each error code (4 tests).

- [ ] **Task 3 — Total-transactions count helper (AC #2).** Edit `src/features/member/api/useMemberProfile.ts` to also return `totalTransactionsCount: number` (across ALL cycles, not just current). The existing `transactions_decrypted` query already pulls all-cycle transactions — just expose `allTransactions.length` alongside the cycle-filtered list. Update `MemberProfileData` type + the existing tests.

- [ ] **Task 4 — `DeleteMemberDialog` component (AC #2 #3 #4 #5 #11 #12).** New file `src/features/member/ui/DeleteMemberDialog.tsx`:
  - Native `<dialog>` shell (same pattern as `RestartCycleDialog` from Story 2.7 — zero new deps).
  - Internal state machine: `"typing-confirmation" | "typing-password"` (single useState).
  - Props: `open`, `onOpenChange`, `memberId`, `memberName`, `transactionsCount`, `cyclesCount`, `onSuccess`.
  - Hosts both `useDeleteMember` and the `fetch("/functions/v1/re-auth", ...)` call (the re-auth POST is local to this component — small surface, doesn't need its own hook).
  - Step 1 → Step 2 → POST re-auth → on 200 → call `useDeleteMember.mutateAsync(memberId)` → on success → call `onSuccess(memberId)` and close.
  - On step-2 401 → clear password, render alert, stay on step 2.
  - Companion test file: 6+ cases (renders step 1, Continuer disabled until SUPPRIMER typed, advances to step 2, password 401 stays on step 2 with alert, 200 → fires hook, rejection paths).

- [ ] **Task 5 — Wire the button on `/members/:id` (AC #1 #10).** Edit `src/app/routes/members/[id].tsx`:
  - Replace the disabled `Supprimer` button with a `<Button variant="destructive">` that opens the dialog state (similar wiring to Story 2.7's RestartCycleDialog).
  - On `onSuccess` callback: toast + `navigate("/members", { replace: true })`.
  - Update the existing route test to assert the button is enabled + has the destructive variant.

- [ ] **Task 6 — i18n (AC #1 #2 #3 #4 #5 #10 #13).** Add to `src/i18n/fr.json` under `members.profile.delete`:
  - `cta` = "Supprimer définitivement"
  - `dialog_summary` = "{n} transaction(s) sur {m} cycle(s) seront définitivement supprimés."
  - `dialog_warning` = "Cette action est définitive et ne peut pas être annulée."
  - `confirmation_input_label` = "Tapez SUPPRIMER pour confirmer"
  - `confirmation_continue` = "Continuer"
  - `password_input_label` = "Confirmez votre mot de passe"
  - `password_invalid` = "Mot de passe invalide. Réessayez."
  - `password_rate_limited` = "Trop de tentatives. Réessayez dans quelques minutes."
  - `password_unexpected` = "Erreur inattendue. Réessayez."
  - `final_cta` = "Supprimer définitivement"
  - `cta_submitting` = "Suppression…"
  - `cancel` = "Annuler"
  - `toast_success` = "{name} supprimé ✓"
  - `toast_failure` = "Échec de la suppression. Réessayez."
  - Replace the existing `action_delete` placeholder usage with `action_delete` = "Supprimer" (icon-only header button) AND introduce `action_delete_full` for the long form used inside the dialog if needed.

- [ ] **Task 7 — Tests (AC #1 #2 #3 #4 #5 #11 #12).**
  - **Unit:** `useDeleteMember.test.tsx` (4 cases), `useMemberProfile.test.tsx` extension (assert `totalTransactionsCount`).
  - **Component:** `DeleteMemberDialog.test.tsx` (6+ cases — see Task 4). Mock `useDeleteMember` AND `global.fetch` for the re-auth call.
  - **Route smoke:** extend `[id].test.tsx` with a "Supprimer button is enabled + opens dialog" case.
  - All vitest tests must pass; coverage gate (75% branches) must hold.

- [ ] **Task 8 — Playwright E2E (AC #2 #3 #4 #6 #7 #10).** New `tests/e2e/flow-2-member-delete.spec.ts`, env-gated on `SUPABASE_TEST_SEED_READY`:
  - Seed 1 member (with the seed's default 1 transaction).
  - Navigate to `/members/:id` → assert "Supprimer définitivement" button visible.
  - Click → dialog opens with name + summary count "1 transaction sur 1 cycle".
  - Type wrong word → assert Continuer disabled.
  - Type "SUPPRIMER" → click Continuer → assert password input visible.
  - Type wrong password → click Supprimer définitivement → assert "Mot de passe invalide" visible AND dialog still open AND member still exists in DB (service-role count check).
  - Type real password (`seededCollector.password`) → click Supprimer définitivement → assert toast + landed on `/members`.
  - Service-role query: assert `members` row count = 0 for this id, `transactions` row count = 0, `cycles` row count = 0.
  - Assert `audit_log` has `member.deleted` row with `actor = collector.userId` (Story 2.5 trigger fix).
  - axe-clean assertion on the dialog.

- [ ] **Task 9 — Local Playwright run BEFORE pushing.** **Hard gate** — Story 2.5's 3 CI failures + Story 2.7's clean run validate this discipline. Run `npx playwright test tests/e2e/flow-2-member-delete.spec.ts` locally first; THEN run the full suite to catch regressions; THEN push.

- [ ] **Task 10 — Hygiene + status flip.**
  - Story file: Completion Notes + File List + Change Log.
  - `sprint-status.yaml`: `2-6-delete-member-confirmation: in-progress` → `review` post-implementation.
  - Run all gates: typecheck / lint / vitest / build / coverage.
  - This is the **last story of Epic 2** — note this in the Completion Notes for the eventual `epic-2-retrospective`.

## Dev Notes

### Architecture compliance

- **Layering:** new code lives in `features/member/{api,ui}` + `app/routes/members/[id].tsx` (small wiring change). No `domain/` work.
- **No new shadcn install.** Reuse `Button`, `Input`, `Toaster`, native `<dialog>`. Same pattern as Story 2.7.
- **Tokens.** Destructive surfaces use `bg-destructive text-destructive-foreground` (already in `tailwind.config.ts`). The danger banner uses `bg-destructive/10 text-destructive border-destructive/20` (semantic, not hex).
- **Strict TS.** No `as` casts. The `operation_intent` is the literal `"member_delete"` (already typed in the re-auth function's enum).
- **Cite sources.** PRD § FR11 line 488; FR5 line 479; PRD v1.3 amendment line 30 (auth pivot — re-auth is now password); Epics § Story 2.6 lines 673-692; Architecture § "hard-delete with anonymisation" line 459 + 571; UX § "consent/deletion as ceremony" line 64.

### RPC pattern

- Mirror `update_member` (migration 0016) + `restart_member_cycle` (migration 0018): SECURITY DEFINER, `set search_path = public, pg_temp`, raise typed sqlstate codes, GRANT EXECUTE TO authenticated.
- Advisory lock class_id `0x5AFC` is reserved for delete ops. Class_ids in use:
  - `0x5AFA` — audit chain (migration 0007)
  - `0x5AFB` — cycle restart (migration 0018)
  - `0x5AFC` — member delete (this story)
- The DELETE chain runs in the same transaction; PostgreSQL's `BEGIN ... COMMIT` semantics give us atomicity for free.

### Re-auth Edge Function (already shipped)

- Function: `supabase/functions/re-auth/index.ts` (Story 1.5b).
- Endpoint: POST `/functions/v1/re-auth`.
- Body: `{ password: string, operation_intent: "member_delete" }`.
- Auth: caller's `Authorization: Bearer <jwt>` header (supabase-js attaches it automatically when called via `supabase.functions.invoke`).
- Uses `supabase.functions.invoke("re-auth", { body: ... })` from the dialog. The function returns `{ ok: true, scope: "member_delete" }` on success or an RFC 7807 problem on failure. The dialog reads the `status` field from the problem to map 401 / 429 / 5xx to inline copy.

### "How many transactions / cycles" count

- The dialog summary uses `transactionsCount` + `cyclesCount` props passed from the route, derived from `useMemberProfile`'s data. Task 3 extends the hook to expose `totalTransactionsCount` (across all cycles) so the dialog doesn't need its own DB query.
- `cyclesCount = previousCycles.length + (currentCycle ? 1 : 0)`.

### Anti-patterns (do NOT do)

- **Do NOT skip the typed SUPPRIMER step** even if the user "clearly knows what they're doing". The two-step gate is the safety net (FR11 explicit).
- **Do NOT call the re-auth Edge Function before the SUPPRIMER step is satisfied.** That would burn re-auth attempts against the per-identifier rate limit (Supabase Auth caps at 30/h). The re-auth fires only after step 1 is confirmed.
- **Do NOT delete the vault secrets** (`vault.decrypted_secrets`). Epic 10 owns that surface. Hard-deleting them now would orphan the audit_log payload.
- **Do NOT navigate away mid-mutation.** The user could double-tap, refresh, etc. — the cancel button is disabled while the mutation is in flight (AC #5).
- **Do NOT show a separate "Are you sure?" prompt before the dialog opens.** The dialog itself is the confirmation surface; an extra prompt would be redundant.
- **Do NOT log the password.** The re-auth function already enforces this server-side; the client must too (no `console.log(password)`, no error toasts that echo it).

### Edge cases worth testing

- **Member with no transactions:** "0 transaction sur 1 cycle". The summary copy should still pluralise correctly (use `n === 1 ? "transaction" : "transactions"`).
- **Member with no current cycle (already deleted via cycles table cleanup elsewhere):** the dialog still works, summary reads "0 transaction sur 0 cycle".
- **Re-auth rate-limited (429):** show inline copy, keep dialog open. The user can wait + retry; the SUPPRIMER step stays satisfied so they don't re-type.
- **Hook 23503 (foreign key violation, e.g., a Settlement row from Epic 7 references the member):** classify as `unknown` for now — a future story will broaden the cascade. Surface the toast failure copy.

### Files to touch (predicted)

**New (5 files):**
- `supabase/migrations/20260425000001_delete_member.sql`
- `src/features/member/api/useDeleteMember.ts` (+ `.test.tsx`)
- `src/features/member/ui/DeleteMemberDialog.tsx` (+ `.test.tsx`)
- `tests/e2e/flow-2-member-delete.spec.ts`

**Modified (~7 files):**
- `src/features/member/api/useMemberProfile.ts` (add `totalTransactionsCount`)
- `src/features/member/api/useMemberProfile.test.tsx` (assert the new field)
- `src/features/member/index.ts` (barrel export `useDeleteMember`)
- `src/app/routes/members/[id].tsx` (Supprimer button enabled + dialog wiring)
- `src/app/routes/members/[id].test.tsx` (button enabled + opens dialog assertion)
- `src/i18n/fr.json` (add `members.profile.delete.*` namespace)
- `src/infrastructure/supabase/database.types.ts` (add `delete_member` RPC type)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip)

### Definition-of-done checklist

- All 13 ACs satisfied + all 10 tasks ticked.
- Supprimer button is destructive-styled, always visible, opens the dialog.
- 2-step gate works: typed SUPPRIMER → password re-auth → RPC delete.
- Coverage gate (75% branches) holds.
- Manual smoke: log in → open a member → tap Supprimer définitivement → type wrong word (Continuer disabled) → type SUPPRIMER → wrong password (alert) → real password → assert toast + navigated to /members + member gone from list.
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` all green.
- **`npx playwright test` (full suite) green LOCALLY before pushing.**
- Story status set to `review`; sprint-status updated; Change Log entry added.
- Note in sprint-status: this is the LAST story of Epic 2.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 673-692 (Story 2.6 BDD).
- **PRD:**
  - `_bmad-output/planning-artifacts/prd.md` line 488 (FR11 — typed SUPPRIMER confirmation),
  - line 479 (FR5 — password re-auth on sensitive operations),
  - line 30 (PRD v1.3 amendment — OTP → password re-auth pivot).
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md` line 459 ("hard-delete with anonymisation"),
  - line 571 (`member.deleted` event spec),
  - line 339 (credential-theft mitigation via password re-auth — accepted MVP risk),
  - line 691 ("Re-auth gate present on every sensitive operation").
- **UX:**
  - `_bmad-output/planning-artifacts/ux-design-specification.md` line 64 (deletion-as-ceremony principle),
  - line 263 ("Re-auth only where PRD requires (FR5: settlement, bulk delete, export)"),
  - line 306 (the SUPPRIMER typed-confirmation dialog is mentioned as an example of design ownership),
  - line 650 (danger-zone pattern with red-tinted card + escalating confirmation).
- **Schema:**
  - `supabase/migrations/20260419000001_init_schema.sql` lines 105-118 (cycles), lines 130-145 (transactions), lines 154-165 (sms_queue), lines 180-195 (disputes).
- **Existing code to reuse:**
  - `supabase/functions/re-auth/index.ts` (already accepts `member_delete` operation_intent — Story 2.6 is the first real consumer),
  - `supabase/migrations/20260424000001_restart_member_cycle.sql` (advisory-lock pattern),
  - `src/features/member/api/useUpdateMember.ts` + `useRestartCycle.ts` (mutation hook shape),
  - `src/features/member/ui/RestartCycleDialog.tsx` (native `<dialog>` shell — model for `DeleteMemberDialog`),
  - `src/features/member/api/useMemberProfile.ts` (extend with `totalTransactionsCount`).
- **Process discipline (Story 2.5 retrospective; Story 2.7 confirmation):** Run Playwright LOCALLY before each push.
- **Layering rules:** `CLAUDE.md` § Operating principles.

## Dev Agent Record

### Completion Notes

- All 13 ACs satisfied. Migration `0019_delete_member.sql` ships the SECURITY DEFINER RPC with per-member advisory lock + 5-table cascade (disputes → sms_queue → transactions → cycles → members) in dependency order. Audit `member.deleted` + cascading `transaction.deleted` / `cycle.deleted` events fire via the existing trigger (Story 2.5's actor-JWT fix carries over).
- The dialog hosts both the re-auth call and the delete RPC. State machine: `typing-confirmation` → `typing-password`. Mounting the body only when `open=true` (key-trick alternative) avoids the `react-hooks/set-state-in-effect` lint rule by getting fresh `useState` defaults each open.
- 18 new tests (5 hook + 9 dialog + 1 profile-hook extension + 1 route assertion + 1 E2E + 1 destructive-button regression catch).
- Coverage: 76.39% branches > 75% gate.
- **Discipline 2.5 applied** — full Playwright suite (18 specs) validated LOCALLY before push.
- This is the **last story of Epic 2** — Member CRUD slice complete. Sprint-status notes Epic 2 as a candidate for retrospective.

### Debug Log

- **Re-auth Edge Function returned 500** in the first E2E iteration. Root cause: the `seedCollectorViaAdmin` fixture created `auth.users` with email only (no phone), but the re-auth function's `signInWithPassword({ phone, ... })` flow needs a phone on `auth.users`. Fixed the fixture to also pass `phone` + `phone_confirm: true` to `auth.admin.createUser`. Side benefit: the seed phone is now guaranteed digits-only (was using `randomUUID()` slice which could include `a-f`).
- **Destructive button axe-fail** (white on `#E24B4A` = 3.93:1, gate is 4.5:1). The destructive token's `text` field is `#712B13` (deep brown — the architecture's "red family" reference per UX line 350). Updated `Button.tsx` destructive variant to use `bg-destructive-text` so white text passes WCAG AA (~10.5:1). The lighter `destructive.DEFAULT` stays available for low-prominence accents (banners, icons).
- **`react-hooks/set-state-in-effect` flagged** the dialog's reset-on-open useEffect. Refactored to extract the stateful body into a child component conditionally mounted on `open=true` — fresh `useState` defaults each open, no setState-in-effect.
- **TS narrowing across closures** — the route's `onSuccess` closure captured `query.data` after a guard, but TS doesn't narrow across closure boundaries. Bound `memberName` to a const inside an IIFE.

## File List

**New (5 files):**
- `supabase/migrations/20260425000001_delete_member.sql`
- `src/features/member/api/useDeleteMember.ts` (+ `.test.tsx`)
- `src/features/member/ui/DeleteMemberDialog.tsx` (+ `.test.tsx`)
- `tests/e2e/flow-2-member-delete.spec.ts`

**Modified (~9 files):**
- `src/features/member/api/useMemberProfile.ts` (added `totalTransactionsCount`)
- `src/features/member/api/useMemberProfile.test.tsx` (assert the new field)
- `src/features/member/index.ts` (barrel export `useDeleteMember`)
- `src/app/routes/members/[id].tsx` (Supprimer button enabled + DeleteMemberDialog wiring)
- `src/app/routes/members/[id].test.tsx` (Supprimer enabled + previousCycles/totalTransactionsCount fixtures)
- `src/components/ui/button.tsx` (destructive variant uses `destructive-text` token for WCAG AA)
- `src/i18n/fr.json` (added `members.profile.delete.*` namespace)
- `src/infrastructure/supabase/database.types.ts` (added `delete_member` RPC type)
- `tests/e2e/fixtures/seed-collector.ts` (auth.users now has phone + phone_confirm; phone format is digits-only)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status flip; Epic 2 candidate for retrospective)

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-23 | Winston (architect) | Story 2.6 spec generated by `bmad-create-story`. 13 ACs, 10 tasks. Typed-`SUPPRIMER` + password re-auth (Story 1.5b's existing Edge Function — first real consumer of `operation_intent: "member_delete"`). New `delete_member` SECURITY DEFINER RPC with advisory lock + 5-table cascade in dependency order. Vault secrets stay untouched (Epic 10 owns saver-PII anonymisation). Audit `member.deleted` + cascading `transaction.deleted`/`cycle.deleted` events fire via the existing trigger. Last story of Epic 2. Status → ready-for-dev. |
| 2026-04-23 | dev agent | Implementation complete. All 13 ACs satisfied, 18 new tests, full gates green (typecheck / lint / 395 vitest / build / coverage 76.39% > 75%). 18 E2E specs validated LOCALLY before push. Two collateral fixes: seed-collector fixture now creates auth.users with phone too (re-auth needs it); destructive Button variant uses `destructive-text` token for WCAG AA contrast. Status → review. |
