# Story 2.2: Create a member manually

Status: ready-for-dev

## Story

As a **collector (Ibrahim) authenticated on the SafariCash member list**,
I want **to add a new saver to my route by entering their name, optional phone, and daily contribution amount**,
so that **I can start a 30-day cycle for that saver immediately and resume my morning collection without leaving the app (FR7)**.

## Acceptance Criteria

1. **Route + entry points.** `/members/new` renders the manual-entry form. Three entry points wire to it (no UI duplication), one of which is **conditionally rendered** based on list size:
   - (a) The existing `EmptyState` CTA on `/members` (zero-members branch) already navigates to `/members/new` — Story 1.5 wiring stays as-is.
   - (b) **Header CTA** "Ajouter un membre" (primary button, full-width row above the search field) — rendered when `members.length > 0 && members.length <= MEMBER_HEADER_CTA_THRESHOLD` (`= 10`).
   - (c) **Floating Action Button (FAB)** — rendered when `members.length > MEMBER_HEADER_CTA_THRESHOLD`. 56×56 px circular button, fixed `bottom-6 right-6` with `safe-area-inset-bottom` padding for iOS home-indicator clearance, primary-green background, white `+` icon (`lucide-react` `Plus`), `aria-label={t("members.add_cta")}`, `z-50` so it floats above the list. The header CTA is hidden in this branch — exclusive, never both at once. Rationale: at ≤10 members the header CTA is always visible without scrolling and avoids the visual weight of a floating overlay; past 10 the header CTA scrolls out of reach so the FAB takes over the ergonomic load on the collector's thumb. The threshold lives as a named constant in `src/features/member/types.ts` (`export const MEMBER_HEADER_CTA_THRESHOLD = 10`) so a future product tweak is a one-line change.
   - The placeholder route at `src/app/routes/members/new.tsx` (Story 1.5) is replaced by the real form.

2. **Form fields — single screen, single column.** `src/features/member/ui/MemberForm.tsx` renders three labelled fields, in this order:
   - **Nom** (`name`) — text, required, 2-80 chars after trim, no leading/trailing whitespace at submit. shadcn `<Input>`.
   - **Numéro de téléphone** (`phoneNumber`) — `tel` input, **optional**, accepts the same Senegal E.164 normalisation as Story 1.5 login (`formatE164` + `isValidSenegalPhone` from `src/features/auth/ui/phoneFormat.ts`). Placeholder `+221 77 791 58 98`. Empty input is valid (collector may not have the phone yet — common for cash-only savers).
   - **Cotisation quotidienne (FCFA)** (`dailyAmount`) — numeric input, required, positive integer ≥ 100 ≤ 100000 FCFA. `inputMode="numeric"` for mobile keypad. shadcn `<Input type="number" min={100} max={100000} step={1}>`.

3. **Validation — Zod + react-hook-form.** Schemas live in `src/features/member/types.ts` as `createMemberInputSchema` (consumed by both the form via `@hookform/resolvers/zod` and the `useCreateMember` hook for defense-in-depth). Validation rules:
   - `name`: `z.string().trim().min(2, "Au moins 2 caractères").max(80, "Maximum 80 caractères")`
   - `phoneNumber`: `z.union([z.literal(""), z.string().refine(isValidSenegalPhone, "Numéro invalide (format +221XXXXXXXXX)")])` — empty string passes; non-empty must match.
   - `dailyAmount`: `z.coerce.number().int("Montant entier requis").min(100, "Minimum 100 FCFA").max(100000, "Maximum 100 000 FCFA")`
   - Inline error rendering: under each field with `role="alert"`. Error text uses i18n keys `members.create.error.*` (added in Task 7).

4. **Submit gating.** The "Ajouter ce membre" CTA is disabled until `formState.isValid && !mutation.isPending`. Touched-state error display matches Story 1.5 LoginForm pattern (`onBlur` triggers display, change clears stale error). Submitting a second time while pending is a no-op (synchronous `inFlightRef` guard inside `useCreateMember`, mirroring `useLogin.ts:71`).

5. **Atomic create — single RPC, member + cycle in one transaction.** New SECURITY DEFINER RPC `public.create_member_with_cycle(p_name text, p_phone_number text, p_daily_amount integer)` defined in migration `supabase/migrations/202604220000xx_create_member_with_cycle.sql`. Behaviour:
   - Resolves `collector_id := auth.uid()`; raises `auth_required` if null.
   - Validates `p_daily_amount > 0`; raises `invalid_amount` if not (defense-in-depth on top of client + Zod).
   - Calls `public.vault_encrypt(p_name)` → `name_secret`; calls `public.vault_encrypt(coalesce(nullif(trim(p_phone_number), ''), ''))` → `phone_secret`. **Empty phone stored as encrypted empty string** (rather than NULL) to keep the column NOT NULL invariant from migration 0005.
   - INSERTs into `public.members`: `(collector_id, name_encrypted, phone_number_encrypted, daily_amount, status='active', created_via='manual')`.
   - INSERTs a sibling row into `public.cycles`: `(collector_id, member_id, cycle_number=1, start_date=current_date, end_date=current_date + interval '29 days', status='active')`. Day-1-of-30 invariant per FR15/FR16; `cycle_number` starts at 1 per Story 3.2's monotonic invariant (placeholder until Story 3.2 introduces the cycle-restart scenario).
   - Both INSERTs share the function's transaction. On any failure (Vault unavailable, RLS reject, constraint violation), the function raises and Postgres rolls back both — no orphan member, no orphan cycle.
   - Returns the new member's `id` (uuid) so the client can navigate / show toast.
   - GRANTs: `revoke all from public, anon`; `grant execute to authenticated`. RLS on the underlying tables is enforced because SECURITY DEFINER reads `auth.uid()` and only writes rows owned by that user.
   - Audit event `member.created` fires automatically via the existing trigger from migration 0007 — no manual emit needed.

6. **`created_via` column on `members`.** Same migration adds `public.members_created_via_enum as enum ('manual', 'contacts_import')` plus `alter table public.members add column created_via members_created_via_enum not null default 'manual'`. The default keeps backward compat with any pre-existing rows (none in production at MVP). Story 2.3 (contacts import) will write `'contacts_import'` via the same RPC pattern (or a sibling RPC). Update `database.types.ts` by hand (matching the Story 1.5b pattern — no `npm run db:types` against cloud at this stage).

7. **`useCreateMember` hook.** `src/features/member/api/useCreateMember.ts` exposes a TanStack `useMutation`:
   ```typescript
   const mutation = useCreateMember();
   mutation.mutate({ name, phoneNumber, dailyAmount });
   ```
   - Calls `supabase.rpc("create_member_with_cycle", { p_name, p_phone_number, p_daily_amount })`.
   - On success: `queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY })` so the list view reflects the new row on return.
   - Error mapping (consumed by the form for translated copy):
     - PostgREST `42501` (insufficient_privilege) or RLS error → `members.create.error.unauthorized`
     - Postgres `unique_violation` on phone (if duplicates added later) → `members.create.error.duplicate_phone` (placeholder; no unique constraint exists today, but reserve the key to avoid churn when added)
     - Network / fetch failure → `members.create.error.network`
     - Anything else → `members.create.error.unknown`
   - Synchronous re-entrancy guard via `useRef<boolean>` mirroring `useLogin.ts:71`.

8. **Post-success behaviour.** On `mutation.onSuccess`:
   - `toast.success(t("members.create.success_toast", { name }))` — *"{name} ajouté à votre route ✓"*.
   - `navigate("/members", { replace: true })` so the back button returns to wherever the collector entered from (not back to the empty form).
   - The list refetches via the invalidated query key. Because the list sorts by `latestInteractionAt` (Story 2.1, falls back to `created_at`), the new member lands at the top of the visible list — verified by AC#9 E2E.

9. **Cancel / back behaviour.** A secondary "Annuler" button + the page-header back chevron both navigate to `/members` (`navigate(-1)` would be wrong — if the user deep-linked to `/members/new`, `-1` exits the app). If the form is dirty, no confirmation prompt at MVP (the data isn't persisted; the cost of accidental loss is one re-typed name).

10. **i18n keys (French) — added under `members.create.*`.** `src/i18n/fr.json`:
    - `members.create.title` ("Nouveau membre")
    - `members.create.subtitle` ("Saisissez les coordonnées du nouveau saver pour démarrer son cycle de 30 jours.")
    - `members.create.field.name_label` ("Nom")
    - `members.create.field.phone_label` ("Numéro de téléphone (optionnel)")
    - `members.create.field.amount_label` ("Cotisation quotidienne (FCFA)")
    - `members.create.field.amount_helper` ("Entre 100 et 100 000 FCFA")
    - `members.create.cta_submit` ("Ajouter ce membre")
    - `members.create.cta_cancel` ("Annuler")
    - `members.create.error.name_required` ("Au moins 2 caractères")
    - `members.create.error.name_too_long` ("Maximum 80 caractères")
    - `members.create.error.phone_invalid` ("Numéro invalide (format +221XXXXXXXXX)")
    - `members.create.error.amount_required` ("Montant requis")
    - `members.create.error.amount_min` ("Minimum 100 FCFA")
    - `members.create.error.amount_max` ("Maximum 100 000 FCFA")
    - `members.create.error.amount_integer` ("Montant entier requis")
    - `members.create.error.unauthorized` ("Vous devez être reconnecté pour ajouter un membre")
    - `members.create.error.duplicate_phone` ("Un membre avec ce numéro existe déjà")
    - `members.create.error.network` ("Pas de réseau — vérifiez votre connexion")
    - `members.create.error.unknown` ("Erreur inattendue — réessayez")
    - `members.create.success_toast` ("{name} ajouté à votre route ✓")
    - `members.add_cta` ("Ajouter un membre") — the list-header CTA (AC#1)

11. **Public surface — barrel export.** `src/features/member/index.ts` adds `export { useCreateMember } from "./api/useCreateMember";` (downstream consumers — Story 2.3 contacts import will reuse the same hook with a different `created_via` later, so the export must be public per the `import/no-internal-modules` ESLint rule).

12. **Tests.**
    - **Vitest unit (`useCreateMember.test.ts`):** mock `supabase.rpc`. Cover happy path (returns id, invalidates query), invalid_amount RPC error → unknown, RLS error → unauthorized, network error → network, re-entrancy guard (second call while pending returns immediately).
    - **Vitest component (`MemberForm.test.tsx`):** RTL + jest-axe. Cover field rendering, CTA disabled by default, validation errors on blur (name too short, phone bad format, amount out of range), CTA enabled when valid, submit calls the `onSubmit` prop with the parsed payload, axe-clean.
    - **Vitest component (`MembersNewRoute.test.tsx`):** smoke test that the route mounts `<MemberForm>` and the success path navigates to `/members`.
    - **Deno contract test (`supabase/functions/_shared/create-member-with-cycle.contract.test.ts`):** new env-gated contract test mirroring the `check_collector_registered` pattern (now removed but file structure remembered). Cover: valid call inserts both rows + audit event; invalid_amount rejects; unauth caller rejected by RLS. Add to `scripts/run-edge-tests.sh`.
    - **Playwright E2E (`tests/e2e/flow-2-member-create.spec.ts`):** uses the existing `seedCollector` fixture (Story 1.8) with `SUPABASE_TEST_SEED_READY=1` gate. Drive: navigate to `/members` → click "Ajouter un membre" → fill form → submit → assert redirect to `/members` → assert new member name appears in the list. Delete the seeded member in teardown.
    - **Coverage gate:** `src/domain/` stays at 100 % (Story 2.2 adds nothing there); overall floor 80 % per Story 1.8.

13. **Out of scope (do NOT expand this story).**
    - Bulk import via contacts (Story 2.3 — separate epic story).
    - Edit member (Story 2.5).
    - Delete member (Story 2.6 — needs FR5 re-auth + Story 1.5b's password re-auth pattern).
    - Phone uniqueness enforcement at the DB level (no `unique` constraint on `members.phone_number_encrypted` exists; deferred until pilot reveals whether duplicates are common).
    - Edit-on-error UX (e.g., re-render the form with the user's input intact when the RPC fails). React Hook Form preserves field values on submit failure by default — leverage that, no extra code needed.
    - Optimistic UI insert into the list (TanStack `optimisticUpdate`). Defer to Story 2.5 / 2.6 when offline-first design lands.
    - "Successive add" mode (form clears + stays open after submit). Defer to a Growth-phase polish if pilot collectors request it.

## Tasks / Subtasks

- [ ] **Task 1: Migration — `created_via` column + atomic RPC.** Create `supabase/migrations/202604220000xx_create_member_with_cycle.sql`:
  - [ ] Add `members_created_via_enum` enum.
  - [ ] `alter table public.members add column created_via members_created_via_enum not null default 'manual';`
  - [ ] Define `public.create_member_with_cycle(p_name, p_phone_number, p_daily_amount)` SECURITY DEFINER per AC #5; return the new member's uuid.
  - [ ] `revoke all` from `public, anon`; `grant execute to authenticated`.
  - [ ] `npm run db:reset` locally; verify via `psql` that an authenticated `auth.uid()` call inserts both rows + audit event.
  - [ ] Hand-update `database.types.ts` to add `members.created_via` column + `members_created_via_enum` + `create_member_with_cycle` RPC signature.

- [ ] **Task 2: Zod schemas in `types.ts`.** Add `createMemberInputSchema` per AC #3. Export from `src/features/member/types.ts`. Add the matching `CreateMemberInput` type. Update `src/features/member/index.ts` barrel.

- [ ] **Task 3: `useCreateMember` hook.** `src/features/member/api/useCreateMember.ts` per AC #7. TanStack `useMutation`, `inFlightRef` guard, error classification → translatable code, query invalidation on success.

- [ ] **Task 4: `MemberForm` component.** `src/features/member/ui/MemberForm.tsx`:
  - [ ] react-hook-form + `@hookform/resolvers/zod`.
  - [ ] Three fields per AC #2, all using existing shadcn `<Input>` + `<Button>`.
  - [ ] Inline errors rendered with `role="alert"`.
  - [ ] Props: `{ onSuccess?: (memberId: string) => void; onCancel: () => void }` so the route owns navigation (mirrors `LoginForm` pattern from Story 1.5b).
  - [ ] No `useNavigate` import inside the form — pure presentation + mutation-call.

- [ ] **Task 5: Rewrite `/members/new` route.** `src/app/routes/members/new.tsx`:
  - [ ] Replace the placeholder with `<main>` hosting `<MemberForm>`.
  - [ ] Wire `onSuccess` → `toast.success` + `navigate("/members", { replace: true })`.
  - [ ] Wire `onCancel` → `navigate("/members")`.
  - [ ] Page header: title "Nouveau membre" (h1) + back chevron (button → `navigate("/members")`).
  - [ ] Use the existing `<AppLayout>` shell (don't duplicate header).

- [ ] **Task 6: Add the "Ajouter un membre" CTA — header OR FAB by list size (AC #1).** `src/features/member/ui/MemberList.tsx`:
  - [ ] Add `MEMBER_HEADER_CTA_THRESHOLD = 10` to `src/features/member/types.ts` and re-export from the barrel.
  - [ ] In `MemberList`, derive `useFab = members.length > MEMBER_HEADER_CTA_THRESHOLD`.
  - [ ] When `!useFab && members.length > 0`: render the **header CTA** above the search box — `<Button asChild size="lg" className="w-full"><Link to="/members/new">{t("members.add_cta")}</Link></Button>`. Match the search-region visual weight from Story 2.1 (verify by reading `MemberList.tsx` lines ~30-60 first).
  - [ ] When `useFab`: render a portal-free **FAB** at the bottom of the list container — `<Link to="/members/new" aria-label={t("members.add_cta")} className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary-500 text-white shadow-lg hover:bg-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 [padding-bottom:env(safe-area-inset-bottom)]"><Plus size={24} aria-hidden /></Link>` (icon from `lucide-react`).
  - [ ] Empty-state branch: neither header CTA nor FAB — the `EmptyState` component (Story 1.5) owns the only CTA in that branch.
  - [ ] Update `MemberList.test.tsx`: 3 render assertions — (i) zero members → no header CTA, no FAB (delegate to EmptyState); (ii) `members.length === 5` → header CTA present, FAB absent; (iii) `members.length === 25` → FAB present, header CTA absent. jest-axe across all three.

- [ ] **Task 7: i18n keys.** Add the `members.create.*` block from AC #10 to `src/i18n/fr.json`. Run `npm run typecheck` — `TranslationKey` is inferred from the JSON so missing-key references will fail compile.

- [ ] **Task 8: Tests.** Per AC #12. Run `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build` — all green before marking review.

- [ ] **Task 9: Sprint hygiene.** Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `2-2-create-member-manual` from `backlog` → `ready-for-dev` (already set when this file is generated) → `in-progress` (when dev starts) → `review` (when complete). Add Completion Notes + File List + Change Log to this file.

## Dev Notes

### Why a SECURITY DEFINER RPC and not an Edge Function

Story 2.6 (delete with re-auth) WILL need an Edge Function for the FR5 re-auth gate. Story 2.2 has no such cross-domain orchestration — it's two INSERTs that must be atomic. A Postgres function:
- Runs in a single transaction natively (Edge Function would need a wrapper or rely on PostgREST `Prefer: tx=...` which isn't widely supported).
- Avoids the Cloudflare-rate-limit-Worker hop that Edge Functions go through (Story 1.4) — purely a UX latency win.
- Keeps the audit trigger fire under the caller's `auth.uid()` (SECURITY DEFINER preserves the JWT claim path used by `audit_emit()`).

### Vault-encryption pattern reuse (Story 1.2 + 2.1)

`members.name_encrypted` and `members.phone_number_encrypted` are `uuid` columns holding Vault `secret_id`. The `vault_encrypt(text)` helper from migration 0005 returns the `secret_id` for a fresh secret; the `members_decrypted` view does the read-side `vault_decrypt`. Story 2.1 verified the view works for SELECT (`useMembers` query). Story 2.2 only writes — directly via `vault_encrypt` inside the new RPC. **Do not** import `vault_encrypt` into the client; it's service-side only and authenticated callers cannot execute it directly (per migration 0005 grants).

### Phone-validation reuse (Story 1.5 / 1.5b)

The `formatE164` + `isValidSenegalPhone` helpers already live in `src/features/auth/ui/phoneFormat.ts`. They are auth-feature-local but the function signatures are pure — Story 2.2 imports them from there. **Do not** duplicate. If a future story moves these to a shared `src/lib/phone/` module, this story's import path updates trivially. Story 1.5b removed the `maskPhone` helper; do not reintroduce.

### React Hook Form v7 — patterns

This story is the **first time** the codebase wires react-hook-form (per `package.json` line 44 — already installed in Story 1.1 but unused until now). Patterns to establish (downstream stories will follow):
- One `useForm<CreateMemberInput>({ resolver: zodResolver(createMemberInputSchema), mode: "onBlur" })` call inside `MemberForm`.
- `register("name")` for each shadcn `<Input>` — react-hook-form v7's `register` returns props that spread directly onto an HTML input.
- `formState.errors.name?.message` in the inline error renderer.
- `formState.isValid` drives the CTA `disabled` prop.
- `handleSubmit(onValid)` wraps the mutation call.
- **Do NOT** use Controller for these inputs — register works because the shadcn `<Input>` forwards refs. Controller is for non-ref-forwarding components only.

### Layering compliance (CLAUDE.md + ESLint)

- `src/features/member/` is the only feature touched. No cross-feature imports except via `src/features/auth/ui/phoneFormat.ts` (which is technically cross-feature — but the function is pure and was used this way in Story 2.1's tests already; if ESLint complains, move the helper to `src/lib/phone.ts` in this story).
- The route `src/app/routes/members/new.tsx` only imports from `@/features/member` (barrel) + `@/components/ui/*` + `@/i18n/useT` + `react-router-dom` + `sonner`. No direct imports from `features/member/api/` or `features/member/ui/`.
- The new RPC migration follows the Story 1.2 / 1.5b naming convention: `YYYYMMDDHHMMSS_short_descriptive_name.sql`.

### Anti-patterns to avoid

- **Do NOT** call `supabase.from("members").insert(...)` directly from the client. RLS would block the insert because the encrypted columns require Vault writes (which only `service_role` and our SECURITY DEFINER RPC have). Use the RPC.
- **Do NOT** create a separate "starter cycle" mutation. The cycle insert is part of the single RPC for atomicity (AC #5).
- **Do NOT** add a "successive add" mode (out-of-scope per AC #13). One submit = one navigate.
- **Do NOT** wire optimistic UI updates. Defer to offline-sync stories (Epic 8).
- **Do NOT** introduce `Controller` from react-hook-form for these inputs — `register()` is sufficient and lighter (per § React Hook Form patterns above).
- **Do NOT** add a unique constraint on `phone_number_encrypted` in this story (deferred per AC #13). The pre-existing `error.duplicate_phone` i18n key is reserved for when the constraint lands.
- **Do NOT** persist form state across navigations. The cost of accidental loss is one re-typed name (AC #9 rationale).

### Previous-story intelligence (Story 2.1 — review status)

- `src/features/member/types.ts` is the single source of truth for the member feature types. Add `createMemberInputSchema` HERE, not in a new file.
- `MEMBERS_QUERY_KEY` (already exported) is what `useCreateMember` invalidates on success.
- `useMembers` runs three parallel queries (members + cycles + transactions) — the cycle insert from this story's RPC will appear in the next refetch automatically.
- Story 2.1 introduced `MemberCard` + `MemberList` patterns; the new "Ajouter un membre" CTA in Task 6 should match the existing list-header visual language (verify by reading `MemberList.tsx` lines ~30-60 for the search/filter region).
- Story 2.1's `useMembers` already handles the `members_decrypted` view's nullable `phone_number` — no client-side change needed when an empty-phone member is inserted by Story 2.2.

### Definition-of-done checklist (mirrors Story 1.5b for consistency)

- All 13 ACs satisfied + all 9 tasks ticked
- Migration applied successfully via `npm run db:reset` (local)
- Manual smoke test: log in (using the Story 1.5b `+221777915898` / `safaricash2026` collector), navigate to `/members` → click "Ajouter un membre" → fill form → submit → land on `/members` with the new member visible
- Test counts: ≥ 6 new Vitest cases for `useCreateMember`, ≥ 5 for `MemberForm`, ≥ 3 for `MembersNewRoute`, 1 Playwright E2E
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` all green
- Story status set to `review`; sprint-status.yaml updated; Change Log entry added

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 602-619 (Story 2.2 BDD)
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 484 (FR7); line 492-495 (FR15-17 cycle invariants)
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` line 43 (Member Lifecycle capability), line 569 (`member.created` audit event), lines 854-921 (project structure for `features/member/`)
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` line 691 (manual entry as default CTA, two paths principle)
- **Schema:** `supabase/migrations/20260419000001_init_schema.sql` lines 80-100 (members table + status enum), lines 105-130 (cycles table)
- **Vault helpers:** `supabase/migrations/20260419000005_vault_setup.sql` lines 60-100 (`vault_encrypt`), lines 160-180 (`members_decrypted` view)
- **Audit trigger:** `supabase/migrations/20260419000007_triggers_audit.sql` (members trigger that fires `member.created`)
- **Phone helpers (reuse, do NOT duplicate):** `src/features/auth/ui/phoneFormat.ts`
- **Previous story patterns:** `_bmad-output/implementation-artifacts/2-1-member-list-search.md` (status: review)
- **Re-entrancy guard pattern:** `src/features/auth/api/useLogin.ts:71` (`inFlightRef`)
- **Form-component pattern (CTA disabled until valid):** `src/features/auth/ui/LoginForm.tsx:38` (`canSubmit` derivation)

## Dev Agent Record

### Implementation Plan
_(populated by dev agent)_

### Completion Notes
_(populated by dev agent)_

### Debug Log
_(populated by dev agent)_

## File List
_(populated by dev agent)_

## Change Log

| Date       | Author              | Change |
|------------|---------------------|--------|
| 2026-04-21 | Winston (architect) | Story 2.2 spec generated by `bmad-create-story`. Comprehensive context engine pass: 13 ACs, 9 tasks, dev notes covering vault-encryption reuse, RHF v7 patterns, layering compliance, anti-patterns, and Story 2.1 intelligence. Status → ready-for-dev. |
| 2026-04-21 | Winston (architect — review pass) | User-reviewed the spec; 3 product decisions confirmed: (Q1) `dailyAmount` bounds 100-100 000 FCFA stay; (Q2) bulk-onboarding goes to Story 2.3 contacts-import — no "successive add" mode in 2.2; (Q3) "Ajouter un membre" CTA toggles **dynamically** between a header button and a FAB based on list size. AC #1 + Task 6 rewritten to specify a `MEMBER_HEADER_CTA_THRESHOLD = 10` constant — header CTA at `≤10` members, FAB at `>10`. FAB pattern (56×56 px, primary-green, lucide `Plus` icon, safe-area-aware) documented inline; test count for `MemberList` bumped from 1 to 3 assertions to cover both branches. Status stays `ready-for-dev`. |
