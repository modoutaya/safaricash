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

| Script               | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Vite dev server with HMR                      |
| `npm run build`      | Type-check + production build (emits `dist/`) |
| `npm run preview`    | Preview the production build locally          |
| `npm run test`       | Vitest unit + component tests (single run)    |
| `npm run test:watch` | Vitest in watch mode                          |
| `npm run test:e2e`   | Playwright end-to-end tests                   |
| `npm run lint`       | ESLint over `.ts` / `.tsx`                    |
| `npm run typecheck`  | TypeScript strict check (`tsc --noEmit`)      |
| `npm run format`     | Prettier write across the repo                |

## Stack

- **Frontend:** React 18 + TypeScript 5 + Vite 5 + Tailwind 3 + shadcn/ui + Radix
- **PWA:** vite-plugin-pwa (service worker + manifest)
- **State:** TanStack Query (server) + React Context (client)
- **Forms:** react-hook-form + zod
- **Animation:** framer-motion (purposeful only)
- **Routing:** react-router-dom v7
- **Backend (Story 1.2+):** Supabase (Postgres + Auth + Edge Functions + Vault)
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
- **Locale.** App is French-first (NFR-L1). Strings will land under `src/i18n/fr.json` from Story 1.5 onward.
