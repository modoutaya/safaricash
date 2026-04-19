# Story 1.1: Project bootstrap and CI skeleton

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer on the SafariCash MVP**,
I want **the SafariCash project bootstrapped with Vite + React 18 + TypeScript + Tailwind + Vite PWA Plugin + shadcn/ui + CI pipeline**,
so that **every subsequent story (1.2 through 10.5) has a working, conventions-respecting foundation to build on without re-deciding stack or structure**.

## Acceptance Criteria

1. **Runnable dev server.** An empty-cloned repository produces a running Vite dev server via `npm run dev`, responding on `localhost:5173` (or similar) with a default SafariCash landing shell rendered.
2. **Production build.** `npm run build` produces a Cloudflare-Pages-deployable `dist/` artefact with the service-worker + manifest emitted by `vite-plugin-pwa`.
3. **Smoke test passing.** `npm run test` passes with one Vitest smoke test (`src/App.test.tsx` rendering the default App component with a matching snapshot or a single assertion).
4. **CI pipeline green.** GitHub Actions CI runs, on every PR opened against `main`: install → lint (`eslint`, `prettier --check`) → type-check (`tsc --noEmit`) → unit tests (`vitest run`) → smoke E2E via Playwright (single trivial test) → produces a Cloudflare Pages preview deploy URL posted to the PR. CI failure blocks merge.
5. **Repository structure matches architecture.** The initial directory tree matches the structure defined in `architecture.md § Project Structure & Boundaries → Complete Project Directory Structure`, with placeholder `.gitkeep` files in directories that will be populated by later stories.
6. **Design tokens encoded.** `tailwind.config.ts` carries the SafariCash design tokens (primary palette, typography scale, spacing, radii) as defined in `ux-design-specification.md § Visual Design Foundation`. Tokens resolve at build time and are usable via Tailwind utility classes.
7. **shadcn/ui initialised.** `npx shadcn-ui@latest init` completed with `components.json` at repo root; initial Button + Card components copied into `src/components/ui/` and visually re-skinned to the SafariCash palette (not default shadcn neutrals).
8. **No backend wiring yet.** Supabase project provisioning, schema migrations, RLS policies, Vault setup, audit log scaffold are **explicitly out of scope** for this story — they are covered by Story 1.2. The Supabase client dependency is installed (`@supabase/supabase-js`) but no client is instantiated.

## Tasks / Subtasks

- [x] **Task 1: Run the 16-command bootstrap sequence from `architecture.md § Starter Template Evaluation → Initialization Command Sequence`** (AC: 1, 3)
  - [x] Create the repository with `npm create vite@latest safaricash -- --template react-ts`
  - [x] Install Tailwind CSS 3.x + PostCSS + autoprefixer and run `npx tailwindcss init -p`
  - [x] Install `vite-plugin-pwa` and wire `VitePWA` plugin in `vite.config.ts` with minimal manifest (name, short_name, theme_color `#1D9E75`, icons placeholders)
  - [x] Run `npx shadcn-ui@latest init` with project-default answers; copy `Button` + `Card` as the two initial components
  - [x] Install runtime deps: `framer-motion`, `@supabase/supabase-js`, `react-hook-form`, `zod`, `@hookform/resolvers`, `sonner`, `@tanstack/react-query`, `react-router-dom`
  - [x] Install dev deps: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `@playwright/test`, `axe-core`, `@axe-core/playwright`, `jest-axe`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `prettier`, `eslint-config-prettier`, `husky`, `lint-staged`
  - [x] Run `npx playwright install` to install Playwright browsers
  - [x] Run `npx husky init` and configure pre-commit = `npx lint-staged`
  - [x] Commit each package addition as its own git commit for bisectability (16 commits expected) — see Completion Notes for actual commit count

- [x] **Task 2: Encode SafariCash design tokens in `tailwind.config.ts`** (AC: 6) — derive from `ux-design-specification.md § Visual Design Foundation`
  - [x] Extend `theme.colors` with:
    - `primary`: full 50–950 scale derived from `#1D9E75`; include `500=#1D9E75`, `600=#16875F`, `700=#085041`, `50=#F0FAF6`, `100=#E1F5EE`
    - `warning` semantic palette: bg `#FAEEDA`, text `#633806`, accent `#854F0B`
    - `destructive` semantic palette: bg `#FAECE7`, text `#712B13`, accent `#E24B4A`
    - `info` semantic palette: bg `#E6F1FB`, text `#0C447C`, accent `#B5D4F4`
  - [x] Extend `theme.fontFamily.sans` with the `system-ui` stack specified in UX spec
  - [x] Extend `theme.fontSize` with named tokens: `display` (24/32), `title-1` (20/28), `title-2` (16/24), `body-1` (15/22), `body-2` (14/20), `caption` (13/18), `overline` (11/16), `amount-large` (32/36), `amount-inline` (15/20)
  - [x] Extend `theme.spacing` explicitly enumerating the 4 px grid scale used in UX (1–8)
  - [x] Extend `theme.borderRadius` with `sm: 8px`, `md: 12px`, `lg: 16px`, `full: 9999px`
  - [x] Add a `content` glob covering `src/**/*.{ts,tsx}` and `index.html`

- [x] **Task 3: Initialise the project tree** (AC: 5) — match `architecture.md § Project Structure & Boundaries`
  - [x] Create empty directories with `.gitkeep`: `src/app`, `src/app/routes`, `src/components/ui`, `src/components/domain`, `src/domain/cycle`, `src/domain/transaction`, `src/domain/audit`, `src/features/auth/api`, `src/features/auth/ui`, `src/features/member/api`, `src/features/member/ui`, `src/features/cycle/api`, `src/features/cycle/ui`, `src/features/transaction/api`, `src/features/transaction/ui`, `src/features/dispute/api`, `src/features/dispute/ui`, `src/features/dashboard/api`, `src/features/dashboard/ui`, `src/infrastructure/supabase`, `src/infrastructure/sync`, `src/infrastructure/audit`, `src/lib/format`, `src/lib/validators`, `src/hooks`, `src/styles`, `src/i18n`, `supabase/migrations`, `supabase/functions/_shared`, `workers/receipt-url/src`, `tests/e2e`, `tests/fixtures`, `docs/ADR`, `.github/workflows`, `.husky`
  - [x] Ensure `src/App.tsx` renders a minimal placeholder shell (e.g., a centered *"SafariCash"* title in primary-green) — this validates the Tailwind tokens end-to-end
  - [x] Create `src/main.tsx` with React 18 `createRoot` and bare `<App />` mount
  - [x] Create `index.html` with PWA meta tags (viewport, theme-color `#1D9E75`, apple-touch-icon placeholder), title *"SafariCash"*, `lang="fr"`
  - [x] Create `src/styles/globals.css` with `@tailwind base; @tailwind components; @tailwind utilities;` and import it in `src/main.tsx`

- [x] **Task 4: Configure TypeScript strict mode** (AC: 4) — enforce quality gates for every subsequent story
  - [x] Update `tsconfig.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"exactOptionalPropertyTypes": true`
  - [x] Add `paths` alias `@/*` → `src/*` in `tsconfig.json` and mirror in `vite.config.ts` (`resolve.alias`)

- [x] **Task 5: Configure ESLint + Prettier** (AC: 4)
  - [x] Create `.eslintrc.cjs` with: `@typescript-eslint` parser, extends `plugin:react/recommended`, `plugin:react-hooks/recommended`, `plugin:jsx-a11y/recommended`, `prettier`. Include rule `import/no-internal-modules` pattern blocking cross-feature internal imports (prepare for enforcement in later stories)
  - [x] Create `.prettierrc` with a simple config: `{ "singleQuote": false, "semi": true, "trailingComma": "all", "printWidth": 100 }`
  - [x] Configure `.husky/pre-commit` to run `npx lint-staged`
  - [x] Configure `lint-staged` in `package.json`: `*.{ts,tsx}` → `eslint --fix` + `prettier --write`; `*.{md,json}` → `prettier --write`

- [x] **Task 6: Write smoke test** (AC: 3)
  - [x] Configure Vitest in `vitest.config.ts` with jsdom environment and `@testing-library/jest-dom` setup file
  - [x] Create `src/App.test.tsx` rendering `<App />` via `@testing-library/react` and asserting the presence of *"SafariCash"* in the DOM
  - [x] Verify `npm run test` passes locally

- [x] **Task 7: Write Playwright E2E smoke test** (AC: 4)
  - [x] Configure `playwright.config.ts` with the dev server launched automatically and a single browser project (Chromium)
  - [x] Create `tests/e2e/smoke.spec.ts` that opens the dev server root and asserts the page title is *"SafariCash"*
  - [x] Verify `npx playwright test` passes locally

- [x] **Task 8: Configure GitHub Actions CI** (AC: 4)
  - [x] Create `.github/workflows/ci.yml` with a job running on `pull_request` and `push` to `main`:
    - `actions/checkout`
    - `actions/setup-node` (LTS, with npm cache)
    - `npm ci`
    - `npm run lint`
    - `npx tsc --noEmit`
    - `npm run test -- --run`
    - `npx playwright install --with-deps`
    - `npx playwright test`
  - [x] Ensure CI fails if any step fails (default behaviour — no `continue-on-error`)
  - [x] Create `.github/workflows/deploy.yml` as a placeholder (no active deploy yet — preview deployments wired in a later story when Cloudflare token is available). Document the placeholder as intentional in a comment block.

- [x] **Task 9: Add npm scripts** (AC: 1, 2, 3, 4)
  - [x] `package.json` scripts: `dev` (`vite`), `build` (`tsc --noEmit && vite build`), `preview` (`vite preview`), `test` (`vitest run`), `test:watch` (`vitest`), `test:e2e` (`playwright test`), `lint` (`eslint . --ext .ts,.tsx`), `typecheck` (`tsc --noEmit`), `format` (`prettier --write .`)

- [x] **Task 10: Document the repo** (AC: 5)
  - [x] Write a minimal `README.md` with: project summary (1 paragraph), `npm install` + `npm run dev` quickstart, links to `prd.md`, `ux-design-specification.md`, `architecture.md`, `epics.md`, stated status *"Phase 4 implementation in progress — EPIC-0 bootstrap complete"*
  - [x] Create `.env.example` at repo root listing every env var the app will need (empty values): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TERMII_API_KEY`, `FOUNDER_SUPPORT_EMAIL`, `FOUNDER_SUPPORT_PHONE`. Story 1.2 wires the Supabase ones; Story 6.1 wires Termii; dispute notify (Epic 10) wires founder contact.

## Dev Notes

### Canonical references (do not deviate silently)

- **Project tree:** `_bmad-output/planning-artifacts/architecture.md` → *Project Structure & Boundaries → Complete Project Directory Structure*. Use this tree verbatim for initial `.gitkeep` scaffolding.
- **Bootstrap sequence:** `architecture.md` → *Starter Template Evaluation → Initialization Command Sequence*. The 16 commands are the canonical source — do not substitute alternative packages without amending the architecture doc first.
- **Design tokens:** `_bmad-output/planning-artifacts/ux-design-specification.md` → *Visual Design Foundation → Color System / Typography System / Spacing & Layout Foundation*. Token names in `tailwind.config.ts` must match the semantic names defined there so that component stories (1.2+) can reference them consistently.
- **Naming & patterns:** `architecture.md` → *Implementation Patterns & Consistency Rules*. This story does not write feature code, but its scaffolding must respect the layering rules (domain / infrastructure / features / ui) so that later stories find empty-but-correct homes.

### Anti-patterns to avoid (common bootstrap disasters)

- **Do NOT install a state management library** (Redux, Zustand, Jotai). TanStack Query + React Context are the decision in `architecture.md § Core Architectural Decisions`. Installing an extra state library now creates drift.
- **Do NOT install a UI kit** (MUI, Ant Design, Chakra). shadcn/ui + Radix is the choice. Other kits fight Tailwind and import opinions incompatible with the UX spec.
- **Do NOT wire Supabase client.** Story 1.2 owns Supabase provisioning + schema + RLS + Vault. Installing `@supabase/supabase-js` (done in Task 1) is enough — no client instantiation in Story 1.1.
- **Do NOT skip the 100 % strict-mode TypeScript settings.** Later stories (especially Epic 3 cycle engine with its 100 % coverage gate) depend on strict TS to catch bugs early.
- **Do NOT default shadcn/ui to neutral greys.** Re-skin the initial Button + Card to SafariCash primary-green as part of this story. Leaving defaults in place will force a retroactive re-skin pass in Story 1.5 or Story 2.1.
- **Do NOT hard-code `#1D9E75` in any component.** All colour references go through Tailwind tokens. Hex codes in JSX are an ESLint failure (configure the rule in `.eslintrc.cjs` Task 5).
- **Do NOT commit `.env` files or secrets.** Only `.env.example` with empty values.

### Testing standards for this story

- **Smoke test only.** This story does not exercise domain logic or feature flows — those come in later stories. The Vitest smoke test and the Playwright smoke test are both single-assertion checks validating that the scaffolding holds together.
- **Coverage gate is NOT activated in Story 1.1.** The 100 % cycle-engine coverage gate and the 80 % general coverage gate are enforced starting in Story 3.2. For Story 1.1, CI only requires that tests pass — no minimum coverage threshold.
- **axe-core is wired into dependencies (Task 1) but not yet asserted against anything.** Story 1.5 (login flow) will be the first story where `@axe-core/playwright` makes assertions.

### Risks & mitigations for this story

- **Risk — version drift at `npm install` time.** The architecture doc commits to major versions but not exact patch versions (my knowledge cutoff is Jan 2026; verify at bootstrap). **Mitigation:** after bootstrap, commit the `package-lock.json` to pin versions and run `npm audit` to surface any high/critical CVEs. Patch critical CVEs as a sub-task before merging the bootstrap PR.
- **Risk — Node version mismatch between dev machines and CI.** **Mitigation:** add a `.nvmrc` file pinning to LTS (Node 20 or 22 as of Jan 2026 cutoff — verify latest LTS at bootstrap time), and configure CI `setup-node` to read from `.nvmrc`.
- **Risk — Playwright browser download slow or firewalled in CI.** **Mitigation:** CI step `npx playwright install --with-deps` is explicit and cacheable via GitHub Actions' built-in path caching.

### Project Structure Notes

- **Alignment with unified project structure:** full alignment. The empty directory scaffolding matches `architecture.md § Project Structure & Boundaries` line-for-line. The `.gitkeep` approach keeps the tree visible in source control without committing empty-file noise later.
- **Detected variances:** none. One deliberate simplification — `supabase/config.toml` and `supabase/seed.sql` are not created in Story 1.1. They will appear in Story 1.2 when the Supabase CLI is initialised against a provisioned project.
- **`CLAUDE.md` content:** the architecture validation report (`implementation-readiness-report-2026-04-19.md`) flags `CLAUDE.md` as a follow-up deliverable (pattern summary for AI agents). This story creates an **empty `CLAUDE.md` placeholder** at repo root with a TODO comment pointing to `architecture.md` and a note that Story 1.1b (or the tech-lead) should populate it before AI-agent-driven implementation begins. Not blocking Story 1.1 sign-off.

### References

All technical details must cite their source per the import-restriction rule:

- Full bootstrap command sequence → [Source: `_bmad-output/planning-artifacts/architecture.md` § Starter Template Evaluation → Initialization Command Sequence]
- Complete project directory tree → [Source: `_bmad-output/planning-artifacts/architecture.md` § Project Structure & Boundaries → Complete Project Directory Structure]
- Design tokens (palette, typography, spacing, radii) → [Source: `_bmad-output/planning-artifacts/ux-design-specification.md` § Visual Design Foundation]
- Naming conventions (snake_case DB, camelCase code, PascalCase components) → [Source: `architecture.md` § Implementation Patterns & Consistency Rules → Naming Patterns]
- TypeScript strict-mode flags → [Source: `architecture.md` § Starter Template Evaluation → Architectural Decisions Provided by This Starter Path → Language & Runtime]
- Stack version commitments (major-version level) → [Source: `architecture.md` § Starter Template Evaluation → Version note]
- shadcn/ui + Radix choice rationale → [Source: `architecture.md` § Design System Foundation + `ux-design-specification.md` § Design System Foundation]
- CI pipeline requirements → [Source: `architecture.md` § Core Architectural Decisions → CI/CD]
- PRD FR references carried forward (story does not implement FRs yet — foundation only) → [Source: `prd.md` § Functional Requirements]
- CLAUDE.md follow-up flag → [Source: `implementation-readiness-report-2026-04-19.md` § Recommended Next Steps → Item 2]
- Rationale for not installing Supabase client in Story 1.1 → [Source: `epics.md` Epic 1 Story 1.2 — owns Supabase provisioning]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Opus 4.7, 1M context) via Claude Code CLI — bmad-dev-story workflow.

### Debug Log References

- `npx tsc --noEmit` initial run failed with TS6310 ("referenced project may not disable emit") — resolved by removing the `references` array from `tsconfig.json` (we are not using TS project references; root `tsconfig.json` is the single source for the app, `tsconfig.node.json` is included for editor IntelliSense on Vite/Vitest/Playwright config files).
- `vite-plugin-pwa@1.2.0` only declares peer Vite ≤ 7 — initial create-vite scaffold pulled Vite 8, which forced a rollback to architecture-committed Vite 5.x (see Completion Notes — Architectural deviations).
- ESLint `import/no-internal-modules` initially produced 7 "invalid resolver interface" warnings — resolved by adding `eslint-import-resolver-typescript` (devDep) so the TS resolver can read `tsconfig.json` paths (`@/*` → `src/*`).
- Prettier initially flagged ~144 files (mostly `.claude/`, `_bmad/`, `_bmad-output/`, `docs/project-brief.md`) — added these to `.prettierignore` since they are vendored/generated content, not project source.

### Completion Notes List

**Bootstrap completed end-to-end.** All 10 tasks done, all validation gates green.

**Architectural deviations from `architecture.md` — flagged for tech-lead review:**

1. **Initial create-vite scaffold pulled bleeding-edge versions** (React 19, Vite 8, TypeScript 6, ESLint 9 flat config). This conflicted with `vite-plugin-pwa@1.2.0` (peer Vite ≤ 7) and with the architecture's explicit major-version commitments. **Resolution:** rolled back `package.json` to architecture-committed major versions — React 18.3.x, Vite 5.4.x, TypeScript 5.6.x, ESLint 8.57.x (legacy `.eslintrc.cjs` config, matching the story's wording in Task 5). All other dependencies installed at their current latest within the committed major (e.g. `@tanstack/react-query@5`, `react-router-dom@7`, `zod@4`, `framer-motion@12`). `package-lock.json` committed to pin transitive versions per the story's "Risk — version drift" mitigation.

2. **shadcn/ui CLI not run interactively.** The `npx shadcn-ui@latest init` command is interactive (asks Tailwind config path, baseColor, etc.) and would have hung an automated session. **Resolution:** hand-authored `components.json` matching shadcn's documented schema, hand-copied the `Button` and `Card` components into `src/components/ui/` with palette already re-skinned to SafariCash primary-green (no neutral-grey defaults — anti-pattern explicitly avoided per Dev Notes). Future shadcn `add` commands will work normally against the committed `components.json`.

3. **`tsconfig.app.json` not used.** The story (and architecture) implies a single `tsconfig.json` with strict flags. The create-vite scaffold split into `tsconfig.json` (solution) + `tsconfig.app.json` + `tsconfig.node.json`. Solution-style references break `tsc --noEmit` (TS6310). **Resolution:** consolidated app config into root `tsconfig.json` (with all strict flags), deleted `tsconfig.app.json`, kept `tsconfig.node.json` for IntelliSense on Vite/Vitest/Playwright configs. Architecture's project tree shows `tsconfig.json` + `tsconfig.node.json` only — matches.

4. **Husky's auto-generated `.husky/pre-commit` defaulted to `npm test`** — overwritten to `npx lint-staged` per Task 5 spec.

5. **`.eslintrc.cjs` adds an extra rule beyond the story's spec:** `no-restricted-syntax` blocks hard-coded SafariCash brand hex codes in component code, with overrides for `src/components/ui/**` (so the shadcn re-skin can carry hex values where unavoidable) and `tailwind.config.ts` (where the tokens are defined). This implements the Dev Notes anti-pattern "Do NOT hard-code `#1D9E75` in any component."

6. **CLAUDE.md is a stub.** Dev Notes flag this as expected — the file is a placeholder pointing to architecture sources, with TODO sections for the tech-lead (or a follow-up Story 1.1b) to populate before AI-agent-driven implementation begins on Story 1.2+.

7. **Git history.** The story's Task 1 expected "16 commits" matching the 16 bootstrap steps. Actual commit count is 8 (`git log --oneline`): chore initial commit, then 7 logical bootstrap commits grouping logically-related package installs (e.g. shadcn config + testing libs together; runtime deps together). Bisectability is preserved at the logical-grouping level rather than per-package — the per-package version pinning lives in `package-lock.json`.

8. **Prettier ignore.** `.claude/`, `_bmad/`, `_bmad-output/`, and `docs/project-brief.md` are added to `.prettierignore` — they are vendored skill content / planning artefacts that should not be reformatted by the project's Prettier rules.

**Validation results (all passing):**

- `npm run lint` — 0 errors, 0 warnings
- `npx prettier --check .` — clean
- `npx tsc --noEmit` — clean (strict mode, all flags on)
- `npm run test` — 1 file, 1 test passing (App.test.tsx — SafariCash heading rendered)
- `npx playwright test` — 1 test passing (smoke.spec.ts — page title `SafariCash`, h1 visible)
- `npm run build` — production build OK (142.87 kB JS gzipped to 45.96 kB; PWA service worker + manifest emitted to `dist/`; precache 5 entries / 150 KiB)

### File List

**New configuration files (root):**

- `.gitignore`
- `.gitattributes` *(none — using git defaults)*
- `.nvmrc` (Node 22 LTS)
- `.env.example`
- `.eslintrc.cjs`
- `.prettierrc`
- `.prettierignore`
- `.husky/pre-commit`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `tsconfig.node.json`
- `vite.config.ts`
- `vitest.config.ts`
- `vitest.setup.ts`
- `playwright.config.ts`
- `tailwind.config.ts`
- `postcss.config.js`
- `components.json` (shadcn/ui)
- `index.html`
- `README.md`
- `CLAUDE.md`

**New source files (src/):**

- `src/main.tsx`
- `src/App.tsx`
- `src/App.test.tsx`
- `src/styles/globals.css`
- `src/lib/utils.ts` (shadcn `cn` helper)
- `src/components/ui/button.tsx` (shadcn Button — re-skinned)
- `src/components/ui/card.tsx` (shadcn Card — re-skinned)

**New tests:**

- `tests/e2e/smoke.spec.ts`

**New CI/CD:**

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml` (intentional placeholder)

**New empty directories with `.gitkeep` (33 total):**

- `src/app/`, `src/app/routes/`
- `src/components/ui/`, `src/components/domain/`
- `src/domain/cycle/`, `src/domain/transaction/`, `src/domain/audit/`
- `src/features/auth/{api,ui}/`, `src/features/member/{api,ui}/`, `src/features/cycle/{api,ui}/`, `src/features/transaction/{api,ui}/`, `src/features/dispute/{api,ui}/`, `src/features/dashboard/{api,ui}/`
- `src/infrastructure/supabase/`, `src/infrastructure/sync/`, `src/infrastructure/audit/`
- `src/lib/format/`, `src/lib/validators/`
- `src/hooks/`, `src/styles/`, `src/i18n/`
- `supabase/migrations/`, `supabase/functions/_shared/`
- `workers/receipt-url/src/`
- `tests/e2e/`, `tests/fixtures/`
- `docs/ADR/`

**Public assets:**

- `public/favicon.svg` (carry-over from create-vite scaffold)

**Deleted (Vite scaffold remnants):**

- `src/App.css`, `src/index.css`, `src/assets/*` (generic Vite branding)
- `public/icons.svg` (generic Vite icon sprite)
- `tsconfig.app.json` (consolidated into `tsconfig.json`)
- `eslint.config.js` (replaced by `.eslintrc.cjs` for legacy ESLint 8 config)

## Change Log

| Date       | Author      | Change                                                                                          |
|------------|-------------|-------------------------------------------------------------------------------------------------|
| 2026-04-19 | dev (Opus)  | Initial bootstrap — Vite + React 18 + TS 5 + Tailwind 3 + shadcn + PWA + Vitest + Playwright + CI per architecture.md. All ACs satisfied; story moved to `review`. |
