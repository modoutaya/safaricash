# Story 2.3: Bulk-import members via device contacts (opt-in)

Status: ready-for-dev

## Story

As a **collector (Ibrahim) onboarding 50+ savers on his first day**,
I want **to import multiple members from my phone's contacts in a single flow with explicit consent**,
so that **I don't retype 50 names that already live in my contact book — and I never expose those contacts to the server until I've explicitly confirmed the import (FR8, FR9)**.

## Acceptance Criteria

1. **Entry point — secondary "Importer depuis les contacts" CTA on `/members/new`.** Below the existing manual-entry form (Story 2.2), add a secondary CTA *"Importer depuis les contacts"* (`outline` variant). Tapping navigates to `/members/import`. The CTA is rendered ONLY when the browser supports the Contact Picker API (`navigator.contacts && typeof navigator.contacts.select === "function"`); on unsupported browsers (iOS Safari, Firefox, desktop) the CTA is hidden and only manual entry is offered. Detection lives in `src/features/member/api/contactsPickerSupport.ts` as a pure `isContactPickerSupported(): boolean` helper so it's testable + mockable. The spec entry hint from epics.md ("from the member list") is **superseded** here — the import affordance lives next to the manual form for visual consistency, not on `/members` (the list already toggles header/FAB CTAs per Story 2.2 AC #1).

2. **`/members/import` route — consent screen (step 1 of 3).** New protected route `/members/import` registered in `src/app/router.tsx`. Renders the consent screen FIRST, before any API call:
   - h1: *"Importer depuis vos contacts"*
   - Plain-language consent body matching architecture line 367 + PRD § Mobile FR8: *"Nous lisons vos contacts uniquement pour vous permettre d'en choisir. Aucune donnée ne quitte votre téléphone avant que vous ne validiez la liste finale. SafariCash ne stocke jamais votre carnet d'adresses."*
   - Bullet list of what we read: nom, numéro de téléphone (if present). What we do NOT read: email, adresse, photo, notes, anniversaire.
   - Primary CTA *"Continuer"* — invokes `navigator.contacts.select(["name", "tel"], { multiple: true })`. Browser then shows the OS-native picker (we don't render that ourselves).
   - Secondary CTA *"Annuler"* → `navigate("/members")`.
   - The CTA is **disabled until the user explicitly checks** an *"J'accepte que SafariCash lise mes contacts pour cette session"* checkbox (PRD UX § "no marketing, explicit consent" pattern).

3. **Picker step (step 2 of 3) — assign daily amount per contact.** After the OS picker resolves with the selected contacts, render a list-based UI with one row per contact. Each row:
   - Avatar (initials, reusing `memberInitials.ts` from Story 2.1).
   - Read-only name from the contact (trimmed, capped at 80 chars per the `createMemberInputSchema` constraint).
   - Read-only phone (the FIRST phone if the contact has multiple — common case is 1; documented anti-pattern below). Empty if the contact had no phone.
   - **Per-row daily amount input** — same shadcn `<Input type="number">` shape as Story 2.2, with a *"Appliquer à tous"* button at the top of the list that copies the value from the first row's input to every row (one-tap bulk fill). Default value: empty (collector must enter at least one).
   - **Per-row remove (×) button** — drops the row from the import set. Useful if the OS picker returned a contact that's not actually a saver.
   - Bottom-fixed bar: *"Confirmer l'import ({n})"* primary CTA + *"Annuler"* secondary. CTA disabled until **every remaining row** has a valid amount (100-100 000 FCFA, integer) AND a non-empty name.

4. **Confirm step (step 3 of 3) — N parallel `create_member_with_cycle` calls.** On submit:
   - Iterate the N validated rows. For each row, call `useCreateMember.mutateAsync({ name, phoneNumber, dailyAmount })` with `created_via: "contacts_import"` — Story 2.2's RPC supports the optional `p_created_via` arg (default `'manual'`), so a thin wrapper hook `useImportMembers` chains the param through.
   - Issue them in parallel via `Promise.allSettled` (NOT `Promise.all` — partial failure must be visible, not aborted on first error). Cap concurrency at 5 to avoid hammering the rate limiter (NFR-S9: 100 req/min/collector); a future story can lift the cap if needed.
   - Render a per-row inline status (✓ created / ⚠ failed) once each promise settles. The bottom bar updates: *"{successCount} membres ajoutés, {failCount} échoués"*.
   - On `successCount === total`: full success → `toast.success` + `navigate("/members", { replace: true })`. On partial: stay on the screen, show the "Réessayer les échoués" CTA which re-fires only the failed rows. On total failure: show the same retry CTA + a generic banner.

5. **Per-row error mapping.** Each `useCreateMember` error code surfaces inline next to the failed row, using the existing `members.create.error.*` i18n keys from Story 2.2. No new i18n surface for error copy — the import-specific copy is the bottom-bar progress string only.

6. **`useImportMembers` hook — `src/features/member/api/useImportMembers.ts`.** Exposes:
   ```typescript
   const importer = useImportMembers();
   importer.start(rows: ImportRow[]); // Promise.allSettled with 5-concurrency limiter
   importer.results: Map<rowIndex, { status: "pending" | "ok" | { error: CreateMemberErrorCode }, memberId?: string }>;
   importer.summary: { total: number; pending: number; ok: number; failed: number };
   importer.retryFailed(): void; // re-fires only failed rows
   ```
   Internally calls `supabase.rpc("create_member_with_cycle", { p_name, p_phone_number, p_daily_amount, p_created_via: "contacts_import" })`. Invalidates `MEMBERS_QUERY_KEY` on each success (so the list view picks up new rows incrementally if the user navigates away mid-import).

7. **Revoke flow — Settings page.** Add a section to `src/app/routes/settings.tsx` (Story 1.7's stub):
   - Title: *"Accès à vos contacts"*
   - Status line: *"Accès accordé"* (with a green check) OR *"Aucun accès accordé"*.
   - Button: *"Révoquer l'accès"* — visible only when `localStorage.getItem("safaricash_contacts_consent") === "granted"`. Tapping clears the localStorage flag + shows a toast *"Accès révoqué. SafariCash ne lira plus vos contacts."*
   - **Implementation note**: the Contact Picker API does NOT expose a "revoke" hook — `navigator.permissions.revoke()` is deprecated. Our revoke is at the **app level**: it clears our consent flag, which gates whether `navigator.contacts.select(...)` is ever invoked. The OS-level permission (if any persists) becomes irrelevant because we never trigger the picker until the user re-consents.
   - Also delete `localStorage["safaricash_contacts_consent"]` if the value isn't `"granted"` (data hygiene on stale states).

8. **Consent persistence model.** A single localStorage key: `safaricash_contacts_consent` with value `"granted"` (no other states). Set when the consent checkbox in step 2 of AC #2 is checked AND the user taps "Continuer". Cleared by the Settings revoke action OR by `supabase.auth.signOut()` (added to `src/features/auth/api/signOut.ts`'s cleanup list — single line addition). The flag IS NOT a security boundary (the user can DevTools-edit it); it's a UX commitment: we promise not to invoke the picker without it set.

9. **iOS / unsupported-browser handling.** If a user lands on `/members/import` directly (deep link, copy-pasted URL) on an unsupported browser, render a small fallback screen: *"L'import depuis les contacts n'est pas disponible sur ce navigateur."* + body text mentioning Chrome/Edge for Android works, iOS Safari does not + a primary CTA *"Ajouter manuellement"* navigating to `/members/new`. The `isContactPickerSupported()` check is performed inside the route component on first render — no network call, no UI flash on supported browsers.

10. **No new migration needed.** Story 2.2's migration 0014 already added `members_created_via_enum` with `'contacts_import'` value AND the `create_member_with_cycle` RPC's optional `p_created_via` param. Story 2.3 only **consumes** these — zero schema change. This is the value of having added the column ahead of time.

11. **i18n keys (French) — added under `members.import.*`.** `src/i18n/fr.json`:
    - `members.import.title` ("Importer depuis vos contacts")
    - `members.import.consent_body` (the long text from AC #2)
    - `members.import.consent_reads` ("Nous lisons : nom, numéro de téléphone")
    - `members.import.consent_does_not_read` ("Nous ne lisons PAS : email, adresse, photo, anniversaire, notes")
    - `members.import.consent_checkbox` ("J'accepte que SafariCash lise mes contacts pour cette session")
    - `members.import.cta_continue` ("Continuer")
    - `members.import.cta_cancel` ("Annuler")
    - `members.import.picker_subtitle` ("{n} contact(s) sélectionné(s). Saisissez la cotisation quotidienne pour chacun.")
    - `members.import.bulk_apply_label` ("Appliquer à tous")
    - `members.import.row_remove_label` ("Retirer ce contact")
    - `members.import.cta_confirm` ("Confirmer l'import ({n})")
    - `members.import.cta_retry_failed` ("Réessayer les échoués ({n})")
    - `members.import.summary_progress` ("{ok} membres ajoutés, {failed} échoués sur {total}")
    - `members.import.summary_all_ok` ("{n} membres ajoutés ✓")
    - `members.import.unsupported_title` ("Import des contacts non disponible")
    - `members.import.unsupported_body` ("Cette fonctionnalité requiert Chrome ou Edge sur Android. Sur iOS et autres navigateurs, ajoutez vos membres un par un.")
    - `members.import.unsupported_cta_manual` ("Ajouter manuellement")
    - `members.import.import_cta` ("Importer depuis les contacts") — the secondary CTA on `/members/new`
    - `settings.contacts.title` ("Accès à vos contacts")
    - `settings.contacts.granted` ("Accès accordé")
    - `settings.contacts.not_granted` ("Aucun accès accordé")
    - `settings.contacts.revoke_cta` ("Révoquer l'accès")
    - `settings.contacts.revoke_toast` ("Accès révoqué. SafariCash ne lira plus vos contacts.")

12. **Tests.**
    - **Vitest unit (`isContactPickerSupported.test.ts`):** stub `navigator.contacts` (presence/absence) → assert true/false.
    - **Vitest unit (`useImportMembers.test.tsx`):** mock `supabase.rpc`. Cover (a) all-success path → all rows ok, query invalidated N times; (b) partial-failure → settles with mixed states, `retryFailed()` re-fires only failed rows; (c) concurrency cap = 5 (assert that 6 simultaneous requests are batched into 2 waves — verifiable via mock call timing OR via inspecting the in-flight count at any moment, easier: write a mock that captures the max parallel-in-flight count and assert it stays ≤ 5).
    - **Vitest component (`ConsentScreen.test.tsx`):** RTL + jest-axe. Renders consent body + checkbox; CTA disabled until checkbox checked; "Continuer" calls the picker invocation prop; "Annuler" calls cancel prop; axe-clean.
    - **Vitest component (`ContactsPickerStep.test.tsx`):** renders N rows, per-row remove drops the row from state, "Appliquer à tous" copies the first row's amount to all, CTA disabled until every row valid, submit calls the `onConfirm` prop with the validated payload.
    - **Vitest component (`ImportRoute.test.tsx`):** smoke — renders consent screen first; on `isContactPickerSupported() === false`, renders the unsupported-browser fallback instead.
    - **Vitest component (`SettingsContacts.test.tsx`):** renders the right state based on localStorage; revoke clears the key + fires toast.
    - **Playwright E2E (`tests/e2e/flow-2-contacts-import.spec.ts`):** env-gated via `SUPABASE_TEST_SEED_READY`. Mock `navigator.contacts.select` via `page.addInitScript` to return 3 fake contacts → drive the consent + picker + confirm flow → assert the 3 members appear in `/members`. Cleanup deletes them in teardown via the seedCollector cascade.
    - **Coverage gate:** `src/domain/` stays at 100 %; overall floor 80 %.

13. **Out of scope (do NOT expand this story).**
    - Picking which phone when a contact has multiple (use the first; document below).
    - Recurring import (re-importing the same contact creates a duplicate member; no dedup at MVP — accepted because phones aren't unique-constrained yet, per Story 2.2 AC #13).
    - Editing the imported name in the picker (Story 2.5 covers edit).
    - Importing > 100 contacts at once (the OS picker scales but our 5-concurrency RPC pipeline would take ~30s for 100 — acceptable; no progress-bar polish at MVP).
    - Server-side de-duplication of the consent flag (it's a localStorage UX flag, not a security boundary — see AC #8).
    - iOS support beyond the fallback screen — when iOS Safari ships the Contact Picker API or when the app moves to Capacitor / React Native (Vision phase), revisit.

## Tasks / Subtasks

- [ ] **Task 1: Browser-support helper.** `src/features/member/api/contactsPickerSupport.ts` — pure `isContactPickerSupported(): boolean` checking both `navigator.contacts` and `typeof navigator.contacts.select === "function"`. Vitest unit covers presence + absence.

- [ ] **Task 2: `useImportMembers` hook (AC #6).** Wraps the existing `supabase.rpc("create_member_with_cycle")` in a `Promise.allSettled` orchestrator with a 5-slot concurrency limiter. State exposed per-row + summary. `retryFailed()` re-fires only `status: "error"` rows. Invalidates `MEMBERS_QUERY_KEY` on each success.

- [ ] **Task 3: Consent storage helper.** `src/features/member/api/contactsConsent.ts`:
  - [ ] `hasContactsConsent(): boolean` reads `localStorage["safaricash_contacts_consent"] === "granted"`.
  - [ ] `grantContactsConsent(): void` sets the key.
  - [ ] `revokeContactsConsent(): void` removes the key.
  - [ ] Add to `signOut.ts` cleanup list (single import + 1-line call alongside whatever it already clears).

- [ ] **Task 4: `ConsentScreen` component.** `src/features/member/ui/ConsentScreen.tsx`:
  - [ ] Pure presentation: renders title + body + bullet lists (reads / does not read) + checkbox + 2 CTAs.
  - [ ] Props: `{ onContinue: () => void; onCancel: () => void }`. CTA disabled until `acknowledged` local state is true.

- [ ] **Task 5: `ContactsPickerStep` component.** `src/features/member/ui/ContactsPickerStep.tsx`:
  - [ ] Receives the OS picker's `ContactInfo[]` result + amount-per-row state internally.
  - [ ] Renders avatar (initials), name, phone, per-row amount input + remove button.
  - [ ] Top toolbar: "Appliquer à tous" + remaining-count badge.
  - [ ] Bottom bar: confirm CTA (disabled until all rows valid) + cancel.
  - [ ] Props: `{ contacts: ContactInfo[]; onConfirm: (rows: ImportRow[]) => void; onCancel: () => void }`.

- [ ] **Task 6: `ImportProgressStep` component.** `src/features/member/ui/ImportProgressStep.tsx`:
  - [ ] Receives `useImportMembers` results map.
  - [ ] Renders per-row status (✓ / ⚠ / spinner) + summary string.
  - [ ] Bottom bar: "Réessayer les échoués" CTA on partial; nothing on full success (the route navigates away).

- [ ] **Task 7: `/members/import` route.** `src/app/routes/members/import.tsx`:
  - [ ] On mount: if `!isContactPickerSupported()`, render the `UnsupportedFallback` component (inline at the top of the file or extract).
  - [ ] State machine: `consent` → `picker` → `progress` → exit.
  - [ ] Owns navigation between steps; the components themselves don't navigate.
  - [ ] Wire to `useImportMembers` for the progress step.
  - [ ] Register the route in `src/app/router.tsx` under the protected tree.

- [ ] **Task 8: Add the "Importer depuis les contacts" CTA on `/members/new`.** Below the existing `<MemberForm>`:
  - [ ] If `isContactPickerSupported()`: render the secondary CTA `<Button asChild variant="outline" size="lg" className="w-full"><Link to="/members/import">{t("members.import.import_cta")}</Link></Button>`.
  - [ ] If not supported: render nothing (the unsupported fallback only fires if the user lands on `/members/import` directly).

- [ ] **Task 9: Settings — revoke section.** `src/app/routes/settings.tsx` adds the contacts-access section per AC #7. New i18n keys `settings.contacts.*`.

- [ ] **Task 10: i18n keys.** Add the `members.import.*` + `settings.contacts.*` blocks from AC #11 to `src/i18n/fr.json`. Run `npm run typecheck` — `TranslationKey` will catch missing references.

- [ ] **Task 11: Tests.** Per AC #12. `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build` all green before marking review.

- [ ] **Task 12: Sprint hygiene.** Update `_bmad-output/implementation-artifacts/sprint-status.yaml`: `2-3-contacts-bulk-import` from `backlog` → `ready-for-dev` (already set when this file is generated) → `in-progress` (when dev starts) → `review` (when complete). Add Completion Notes + File List + Change Log entry to this file.

## Dev Notes

### Browser support reality

The **Contact Picker API** (`navigator.contacts.select`) is **Chromium on Android only** at the time of writing:
- ✅ Chrome / Edge / Samsung Internet on Android (since Chrome 80, May 2020).
- ❌ iOS Safari (no API exposed; Apple has not implemented the spec).
- ❌ Firefox (any platform).
- ❌ Desktop Chromium (the spec gates it to mobile/touch contexts).

This is non-negotiable — there is no polyfill, no shim, no third-party API that gives us cross-browser contacts. iOS users get the manual-entry path (Story 2.2) plus a polite fallback message at `/members/import`.

When the project moves to Capacitor / React Native (Vision phase per architecture line 93), the native `@capacitor-community/contacts` plugin replaces the web API. The state machine and import pipeline (consent → picker → progress) stay the same; only the picker invocation changes.

### Why `Promise.allSettled` + 5-concurrency limiter (not `Promise.all`)

- **Partial failure must be visible.** With `Promise.all`, the first rejection aborts the iteration → the user has no way to see which subset succeeded. `allSettled` waits for all to resolve and gives us the per-row outcome.
- **Concurrency cap of 5** keeps us comfortably under the NFR-S9 rate limit (100 req/min/collector). 50 imports at 5-concurrency = 10 batches × ~200ms RTT each = ~2s total — fast enough that we don't need a fancy progress bar.
- The cap can be lifted later via a `MAX_IMPORT_CONCURRENCY` constant in `src/lib/constants.ts` if pilot data shows the rate limit isn't an issue.

### The "consent" flag is not security

The `safaricash_contacts_consent` localStorage key is **not** a security boundary — any user can edit it via DevTools. Its purpose is a **UX commitment**: we promise to never invoke `navigator.contacts.select()` without it set. The actual authorization is the OS-level Contact Picker permission, which Chrome handles natively (it shows the picker UI; the user picks; we receive only the selected contacts). We never enumerate — we only see what the user explicitly picked.

This is the right model because:
1. The Contact Picker API does not have a `permissions.query()` for "contacts" (the standard Permissions API doesn't list it).
2. There is no `navigator.permissions.revoke({ name: "contacts" })` — that permission name was never registered.
3. Each picker invocation re-prompts the user via the OS UI — there is no persistent "trusted by app" state at the API level.

So the only thing our code can revoke is its **own willingness** to call the API. That's the localStorage flag.

### `created_via` reuse from Story 2.2

Story 2.2's migration 0014 added the optional `p_created_via` parameter to `create_member_with_cycle` precisely so this story would not need a second migration. `useImportMembers` calls the RPC with `{ p_created_via: "contacts_import" }`; everything else is identical to the manual flow. The audit trigger fires `member.created` with the same shape; downstream consumers (Story 9.x dashboard, Story 7.x settlement) don't distinguish between manual and import.

### Phone normalization on import

Contacts from the picker arrive with arbitrary phone formats (raw user input — `+221 77 79 15 898`, `0 77 79 15 898`, `(221) 77-79-15-898`, etc.). Run each picked phone through `formatE164` from `src/features/auth/ui/phoneFormat.ts` before passing to the RPC. If `isValidSenegalPhone()` rejects after normalization, set the row's phone to `""` (empty — same path as a contact with no phone) and **DO NOT** block the import; manual edit can fix it later (Story 2.5). This is a pragmatic choice: a contact with a non-Senegalese phone is still a valid saver — we just can't SMS them yet.

### Layering compliance

- `src/features/member/` is the only feature directory touched (no cross-feature imports except the existing `phoneFormat` import established by Story 2.2).
- The new `/members/import` route lives at `src/app/routes/members/import.tsx` and only imports from `@/features/member` (barrel).
- The `useImportMembers` hook lives in `src/features/member/api/` and exports through the barrel.
- The `ContactInfo` type from the Contact Picker API is wrapped in our own `ImportRow` shape inside the feature — no `lib.dom.d.ts` types leak into the route.

### Anti-patterns to avoid

- **Do NOT** call `navigator.contacts.select()` outside the consent screen. Every other code path that needs a contact list must funnel through the same consent step.
- **Do NOT** persist the contact list to localStorage / IndexedDB at any point — the contacts only exist in component state during the `picker → progress` window. After import completes, the React state is dropped and the contacts are gone from our world.
- **Do NOT** send the FULL OS picker output to the server. Only the selected, amount-assigned, validated rows go through the RPC. Per architecture line 367: "Nothing leaves the device until the collector confirms the final list."
- **Do NOT** add a "select all" affordance in the picker step. The OS picker already handles multi-select; our step is for refining (remove + amount-assign), not for re-selecting. Adding a "select all amount = X" might lead the collector to commit to a default they didn't mean to.
- **Do NOT** skip `Promise.allSettled` in favor of `Promise.all`. Partial failure visibility is the whole reason for the per-row UI.
- **Do NOT** introduce a server-side bulk-insert RPC. Story 2.2's `create_member_with_cycle` per-row pattern is sufficient at MVP scale (≤ 50 contacts) AND keeps the audit trail granular (one event per member).

### Previous-story intelligence (Story 2.2)

- `useCreateMember` already classifies all the failure modes; `useImportMembers` reuses the same `CreateMemberErrorCode` taxonomy.
- `MEMBER_HEADER_CTA_THRESHOLD = 10` (Story 2.2) is unaffected by Story 2.3 — once an import lands, the list re-renders with the new count and the header → FAB switch happens naturally if the count crosses 10.
- `createMemberInputSchema` is the SAME validator used per-row in `ContactsPickerStep` — re-parse each row before submission to keep server expectations aligned.
- The success toast pattern from Story 2.2's `MembersNewRoute` (toast on success + `navigate("/members", { replace: true })`) is replicated for the all-success path here.
- Story 2.2's `MemberForm` `mode: "onChange"` lesson applies to `ContactsPickerStep` rows: validate per-row on every keystroke so the "Confirmer" CTA is reactive.

### Definition-of-done checklist

- All 13 ACs satisfied + all 12 tasks ticked.
- New routes registered in router (`/members/import` + the unsupported fallback render path is the SAME route).
- localStorage consent flag tested + cleared on signOut.
- Manual smoke test (Chrome on Android emulator OR a real Android device): consent → pick 3 contacts → assign amounts → confirm → land on `/members` with 3 new members visible.
- iOS Safari smoke (real device or BrowserStack): land on `/members/import` directly → see the unsupported fallback → "Ajouter manuellement" navigates to `/members/new`.
- `npm run typecheck` / `npm run lint` / `npm run test` / `npm run build` all green.
- Story status set to `review`; sprint-status updated; Change Log entry added.

## References

- **Epic spec:** `_bmad-output/planning-artifacts/epics.md` lines 620-638 (Story 2.3 BDD).
- **PRD:** `_bmad-output/planning-artifacts/prd.md` line 485 (FR8), line 486 (FR9), line 367 (Contacts permission consent), line 401 (Contacts import opt-in flow), line 367 ("nothing leaves the device" guarantee).
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` line 43 (Member Lifecycle: opt-in device contacts, client-only no server transit), line 187 (RHF + Zod required by FR7-14), line 926 (`ContactsImport.tsx` already in the project tree placeholder).
- **UX:** `_bmad-output/planning-artifacts/ux-design-specification.md` line 691 (manual default + contacts import secondary), line 100 (contacts picker opt-in for bulk member import).
- **Consumed RPC (Story 2.2):** `supabase/migrations/20260422000001_create_member_with_cycle.sql` — `create_member_with_cycle(name, phone, daily_amount, [created_via])`.
- **Phone normalisation (Story 1.5/1.5b):** `src/features/auth/ui/phoneFormat.ts`.
- **Pattern: per-row Zod re-validation (Story 2.2):** `src/features/member/api/useCreateMember.ts:55` (`createMemberInputSchema.parse`).
- **Pattern: Promise.allSettled with concurrency limiter:** new for this story; the implementation lives entirely in `useImportMembers.ts`.
- **Browser compat reality:** [MDN Contact Picker API](https://developer.mozilla.org/en-US/docs/Web/API/Contact_Picker_API) — Chromium-Android only.

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
| 2026-04-22 | Winston (architect) | Story 2.3 spec generated by `bmad-create-story`. 13 ACs, 12 tasks. Reuses Story 2.2's `create_member_with_cycle` RPC via the optional `p_created_via` arg — **zero new migration needed**. Three-step state machine (consent → picker → progress) with `Promise.allSettled` + 5-concurrency limiter for the parallel inserts. Browser-compat reality: Contact Picker API is Chromium-Android only — iOS users get a polite fallback to manual entry. Consent flag is a UX commitment (localStorage), not a security boundary; the actual authorization is the OS picker. Status → ready-for-dev. |
