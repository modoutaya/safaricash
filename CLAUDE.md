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

## Anti-patterns (do NOT do)

- Install state-management libraries (Redux/Zustand/Jotai). TanStack Query + React Context is the decision.
- Install UI kits (MUI/Ant/Chakra). shadcn/ui + Radix only.
- Wire Supabase client outside `src/infrastructure/supabase/` (Story 1.2 owns the singleton).
- Default shadcn components to neutral greys — re-skin to SafariCash primary-green.

## TODO

- Pattern summary distilled from `architecture.md § Implementation Patterns & Consistency Rules`.
- Worked examples for: a feature hook, a domain function, an Edge Function.
- Snippets for common Supabase + Zod + TanStack Query wiring.
