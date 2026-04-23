# CLAUDE.md — AI agent operating notes

> **Status: PLACEHOLDER.** Story 1.1 created this file as a stub.
> The implementation-readiness report (`_bmad-output/planning-artifacts/implementation-readiness-report-2026-04-19.md` § Recommended Next Steps → Item 2) flags a follow-up to populate this file with a pattern summary distilled from `architecture.md`. The tech-lead (or a dedicated Story 1.1b) should expand the sections below before AI-agent-driven implementation of subsequent stories begins.

## Canonical sources of truth

- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` — project tree, layering rules, naming, decisions.
- **UX spec:** `_bmad-output/planning-artifacts/ux-design-specification.md` — design tokens, flows, components.
- **PRD:** `_bmad-output/planning-artifacts/prd.md` — functional + non-functional requirements.
- **Epics:** `_bmad-output/planning-artifacts/epics.md` — story scope and ordering.
- **Sprint status:** `_bmad-output/implementation-artifacts/sprint-status.yaml`.

## Operating principles (to expand)

- **Tokens, not hex.** Brand colours go through `tailwind.config.ts`. ESLint blocks hard-coded SafariCash hex codes in `src/`.
- **Strict TypeScript.** All strict flags are on. Avoid `as` casts; prefer Zod parsing at boundaries.
- **Layering.** `domain/` (pure, zero infra) ← `infrastructure/` ← `features/` ← `components/`. Cross-feature imports go through `index.ts` (ESLint enforced).
- **Cite sources.** Implementation that derives from architecture/UX/PRD must cite the section in the story's Dev Notes.
- **Tests first.** Every story follows red-green-refactor; cycle-engine domain (Story 3.2 onward) has a 100% coverage gate.

## Local-DB workflow (preserve manually-seeded data)

The Postgres data lives in a Docker volume that **survives `npm run db:stop`** (no `--no-backup` flag). Manually-seeded rows (members, cycles, transactions you create via Studio or RPC for exploratory work) persist across machine restarts.

When adding a new migration during story implementation:

- ✅ **Use `npm run db:migrate`** — applies pending migrations only, keeps existing data.
- ❌ **Do NOT use `npm run db:reset`** unless you intentionally want to wipe everything and re-run all migrations from scratch.
- Create a new migration file with `npm run db:migrate:new <slug>` (writes to `supabase/migrations/`).

CI (the GitHub Actions workflow) starts from a clean Supabase stack on every run, so `db:reset` semantics are implicit there. Only the local dev loop benefits from `db:migrate`.

## Anti-patterns (do NOT do)

- Install state-management libraries (Redux/Zustand/Jotai). TanStack Query + React Context is the decision.
- Install UI kits (MUI/Ant/Chakra). shadcn/ui + Radix only.
- Wire Supabase client outside `src/infrastructure/supabase/` (Story 1.2 owns the singleton).
- Default shadcn components to neutral greys — re-skin to SafariCash primary-green.
- Run `npm run db:reset` during normal story dev — it wipes any manually-seeded data. Use `npm run db:migrate` to apply new migrations incrementally.

## TODO

- Pattern summary distilled from `architecture.md § Implementation Patterns & Consistency Rules`.
- Worked examples for: a feature hook, a domain function, an Edge Function.
- Snippets for common Supabase + Zod + TanStack Query wiring.
