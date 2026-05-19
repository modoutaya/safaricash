# Sprint Change Proposal — Calendar-Month Cycle Model

- **Date:** 2026-05-19
- **Author:** Mamadou (founder) + dev (correct-course workflow)
- **Change scope classification:** **Major** — alters the product's core domain model (cycle definition), NFR-R3 zero-tolerance settlement math, and a foundational PRD assumption.
- **Workflow:** `bmad-correct-course`, incremental mode.

---

## Section 1 — Issue Summary

**Problem statement.** SafariCash currently models a savings cycle as a **fixed 30 calendar days** starting on the member's registration (or restart) date. The business reality of informal tontines is a **calendar-month cycle**. A member enrolled mid-month must have a **partial first cycle** running from their registration date to the last day of that month.

**Trigger.** New business requirement raised by the founder on 2026-05-19, outside sprint execution, after Epic 7 (settlement) shipped. Not a failed story — a model correction.

**Worked example (founder's).** A member registered on the **7th** of a 30-day month contributes **23 days** that month:
- `start_date` = 7th, `end_date` = 30th (last day of month)
- cycle length (inclusive) = `30 − 7 + 1` = **24 calendar days**
- contribution days = `24 − 1` = **23** ✓ (matches the founder's `30 − 7 = 23`)
- commission = **1 full day** (business decision — see below)
- member payout = `dailyAmount × 23`

**Evidence of the conflict in the current codebase.**
- `src/domain/cycle/cycleEngine.ts:14` — `CYCLE_TOTAL_DAYS = 30`, `CONTRIBUTION_DAYS = 29` hardcoded.
- `cycleEngine.ts` — projected balance `dailyAmount × 29 − Σ(advances)`; `cycleDay()` clamped to `[1, 30]`.
- `supabase/migrations/...create_member_with_cycle.sql:136` and `...restart_member_cycle.sql:98` — `end_date = start_date + interval '29 days'`.
- `supabase/migrations/...commit_cycle_settlement.sql:9-11` — server recomputes payout as `daily_amount × 29 − Σ(advances)`.
- `src/features/transaction/api/shareReceipt.ts:50` — `jour ${cycleDay}/30` denominator hardcoded.
- `prd.md:61, 144` — *"fixed 30-day calendar cycles"*; `prd.md:495-497` (FR15/16/17); `prd.md:565` (NFR-R3 *"at day 30"*).
- `docs/ADR/004-cycle-invariants.md` — 8 property-based invariants all built on `× 29` / `[1,30]` constants.

---

## Canonical new model (decisions locked)

A cycle spans `[start_date, end_date]` (inclusive) where:

| Field | Rule |
|---|---|
| `start_date` | Member registration date (first cycle) **or** restart date (FR12 restart). |
| `end_date` | **Last calendar day of the month** containing `start_date`. |
| Roll-forward | If `end_date − start_date + 1 < MIN_CYCLE_LENGTH_DAYS` (tunable, default **3**), the cycle is rattached to the next month: `start_date` = 1st of next month, `end_date` = last day of next month. Prevents an ultra-short cycle where commission ≥ contributions. |
| `cycleLength` | `end_date − start_date + 1` (inclusive, 1-based). |
| `contributionDays` | `cycleLength − 1`. |
| `commission` | `1 × dailyAmount` — **always full, never prorated**, regardless of cycle length (founder decision 2026-05-19; preserves the spirit of INV-4). |
| `projectedFinalBalance` | `dailyAmount × (cycleLength − 1) − Σ(advances)`. |
| `cycleDay(now)` | clamped to `[1, cycleLength]`. |

**Steady state.** Once a cycle ends on the last day of a month and the next is started on the 1st, every subsequent cycle is a full calendar month (1st → last day, 28/29/30/31 days). Only a member's first cycle — or a mid-month restart — is partial.

**Consequence for INV-8 (integer FCFA).** Because commission stays a whole `1 × dailyAmount` (no proration), **no division is introduced** — all amounts remain integers. The "1 full day" decision is what keeps the zero-tolerance math clean.

---

## Section 2 — Impact Analysis

### Epic Impact

| Epic | Status | Impact |
|---|---|---|
| **Epic 3 — Cycle Engine** | done | Goal text (`epics.md:339` *"30-calendar-day cycle"*) + Stories 3.1-3.5 ACs reference day-30. Engine module rewritten. |
| **Epic 7 — Settlement** | done (7.1-7.4 recent) | Story 7.3 AC hardcodes `dailyAmount × 30 − …`. `commit_cycle_settlement` RPC + `SettlementSummaryCard` consume the 30-day formula. **No rollback** — components stay, only the length source changes. |
| **Epic 4 / Epic 5** | done | `MemberActionSheet`, `AdvanceSimulationPanel`, `canAcceptAdvance`, transaction routes consume `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS`. Indirect — recompile against the new engine signature. |
| **Epic 6 — SMS** | done | Receipt copy carries cycle-day position with a `/30` denominator (`shareReceipt.ts:50`, server `format_sms_body`). |
| Epics 1, 2, 8, 9, 10 | — | No impact. No new epic obsoleted; epic order unchanged. |

### Artifact Conflicts

- **PRD** — FR15, FR16, FR17, FR19 + lines 61, 85, 144 + NFR-R3: all assert "30 days". MVP scope unchanged; only the cycle definition is corrected.
- **ADR-004** — the 8 invariants need re-parameterization (`× 29` → `× contributionDays`, `[1,30]` → `[1,cycleLength]`). INV-4 (commission) is **unchanged** — explicitly note partial cycles still take 1 full day.
- **Architecture** — `architecture.md:44` ("monotonic day-N from cycle start date"); `init_schema.sql:121` table comment ("30-day tontine cycle"). Schema itself **needs no change** — `cycles` already has `start_date` + `end_date` columns.
- **UX spec** — `AdvanceSimulationPanel` row "Total cycle projected — `daily_amount × 30`"; settlement card breakdown; any "jour N / 30" copy.

### Technical Impact

- **No DB schema migration** — `cycles.start_date` + `cycles.end_date` already exist (`init_schema.sql:111-112`). Only **RPC logic** changes.
- **Existing data is safe** — old cycles keep their stored `end_date` (`start+29`); the engine reads `end_date` from the row, so legacy 30-day cycles continue to compute correctly. No backfill required.
- **Coverage gate** — `src/domain/cycle/` 100% gate must stay green; property tests re-written.
- **NFR-R3 risk** — high. Engine, `commit_cycle_settlement` server recompute, and SMS projection must all derive length from the **same source** (`end_date`) or settlement drifts from in-cycle receipts.

---

## Section 3 — Recommended Approach

**Selected path: Option 1 — Direct Adjustment** (modify existing artifacts + add a remediation story cluster). No rollback, no MVP scope cut.

- **Effort:** Medium-High.
- **Risk:** High (NFR-R3 zero-tolerance + 100% coverage gate) — mitigated by: single source of truth (`end_date`), property-based re-testing, server/client cross-check already present in `commit_cycle_settlement`.
- **Rationale:** the schema already supports variable-length cycles; the change is concentrated in one pure module + two RPCs + their consumers. Rollback of Epic 7 would discard correct, shippable work for no gain.

### Proposed remediation story cluster — **Epic 11: Calendar-Month Cycle Model**

| Story | Title | Scope |
|---|---|---|
| 11.1 | ADR-004 amendment — variable-length cycle invariants | Re-parameterize INV-1…INV-8; add INV-9 (end-date derivation + roll-forward). |
| 11.2 | `cycleEngine` refactor to variable-length cycles | Remove hardcoded constants; length derived from `start_date`/`end_date`; 100% coverage + property tests re-written. |
| 11.3 | Month-aligned cycle dates in RPCs | New migration: `create_member_with_cycle` + `restart_member_cycle` set `end_date` = month-end (+ roll-forward); rewrite `commit_cycle_settlement` payout recompute. |
| 11.4 | Consumer + copy updates | Transaction routes, `AdvanceSimulationPanel`, `SettlementSummaryCard`, `shareReceipt`, server `format_sms_body` "/N" denominator. |

---

## Section 4 — Detailed Change Proposals

> Incremental mode — review each group: Approve [a] / Edit [e] / Skip [s].

### 4.1 — PRD (`_bmad-output/planning-artifacts/prd.md`)

**FR15** — OLD: *"The system initiates a 30-calendar-day cycle for each member at member creation or on cycle restart."*
NEW: *"The system initiates a calendar-month-aligned cycle for each member at member creation or on cycle restart. The cycle runs from the start date to the last day of that calendar month; a cycle started mid-month is a partial cycle. If fewer than `MIN_CYCLE_LENGTH_DAYS` (default 3) remain in the month, the cycle is rattached to the following month."*

**FR16** — OLD: *"...position within the current cycle (day 1 through day 30)..."*
NEW: *"...position within the current cycle (day 1 through day N, where N is the cycle length in calendar days)..."*

**FR17** — OLD: ``(daily_amount × 30) − (1 × daily_amount) − Σ(outstanding advances)``
NEW: ``(daily_amount × cycle_length_days) − (1 × daily_amount) − Σ(outstanding advances)``, equivalently ``daily_amount × (cycle_length_days − 1) − Σ(advances)``.

**FR19** — OLD: *"...once it has completed (day 30 reached or status = completed)."*
NEW: *"...once it has completed (cycle end_date reached or status = completed)."*

**NFR-R3** — OLD: *"...projected final balance (computed via FR17) at day 30 for every cycle..."*
NEW: *"...projected final balance (computed via FR17) at the cycle end_date for every cycle..."*

**Line 61 / 144 / 85** — replace "fixed 30-day calendar cycles" / "30-day calendar cycle" / "No settlement surprises at day 30" with calendar-month-cycle wording. Add a Change Log entry (PRD v1.4).

**Rationale:** the PRD is the canonical model source; leaving "30 days" creates a permanent doc-vs-code conflict.

### 4.2 — ADR-004 (`docs/ADR/004-cycle-invariants.md`)

Add an **amendment section** (do not supersede — keep history):
- INV-1: holds; `cycleDay` domain `[1, cycleLength]`.
- INV-2: "day 30" → "cycle end_date"; settled ≡ `dailyAmount × (cycleLength − 1)`.
- INV-3: capacity bound `× 29` → `× (cycleLength − 1)`.
- **INV-4: UNCHANGED** — commission is exactly `1 × dailyAmount` on **every** cycle, partial cycles included. Add explicit note: "A partial first cycle still takes one full commission day — never prorated (founder decision 2026-05-19)."
- INV-5: clamp `[1,30]` → `[1, cycleLength]`.
- INV-6, INV-7, INV-8: hold unchanged (INV-8 explicitly safe — no division introduced).
- **NEW INV-9** — *Cycle-bounds derivation*: `end_date` = last day of `month(start_date)`; roll-forward when residual `< MIN_CYCLE_LENGTH_DAYS`; `cycleLength = end_date − start_date + 1 ≥ MIN_CYCLE_LENGTH_DAYS`.

### 4.3 — Epics (`_bmad-output/planning-artifacts/epics.md`)

- Epic 3 goal (`:339`): "30-calendar-day cycle" → "calendar-month-aligned cycle".
- Stories 3.1, 3.2, 3.4, 3.5: update day-30 references in goals/ACs.
- Story 3.2 AC: formula `(dailyAmount × 30) − …` → `(dailyAmount × cycle_length) − …`.
- Story 7.3 AC (`:1132-1133`): formula reference updated; "prior SMS receipts" cross-check wording kept (still NFR-R3).
- Append **Epic 11** section + Stories 11.1-11.4 (per Section 3).

### 4.4 — Architecture (`_bmad-output/planning-artifacts/architecture.md`)

- `:44` — "monotonic day-N computation from cycle start date" → "...bounded by the cycle end date".
- `:889` comment — `cycleEngine.ts` function list note (variable-length).
- No structural / layering / tech-stack change.

### 4.5 — Migration: cycle dates (`supabase/migrations/`)

New migration via `npm run db:migrate:new calendar_month_cycle_dates`:
- `create_member_with_cycle` — `end_date` = `(date_trunc('month', v_today) + interval '1 month - 1 day')::date`; apply roll-forward when `end_date − v_today + 1 < 3`.
- `restart_member_cycle` — same `end_date` logic.
- `commit_cycle_settlement` — replace `daily_amount × 29` with `daily_amount × ((c.end_date − c.start_date + 1) − 1)`; keep the client/server cross-check.
- Per CLAUDE.md: use `db:migrate`, never `db:reset`. Smoke-test the RPCs locally (`feedback_migration_rpc_smoke_test`).

### 4.6 — Engine + consumers (`src/`)

- `cycleEngine.ts` — remove `CYCLE_TOTAL_DAYS` / `CONTRIBUTION_DAYS` constants; add `cycleLengthDays(startDate, endDate)`; thread length into `computeProjectedFinalBalance`, `canAcceptAdvance`, `settle`, `cycleDay`, `daysUntilCycleEnd`, `computeMemberStats`, `isSettlementReady` (now end-date based). `commission()` unchanged.
- Consumers: `[id].transaction.tsx:91`, `[id].advance.tsx`, `AdvanceSimulationPanel`, `SettlementSummaryCard`, `shareReceipt.ts:50` (`/30` → `/${cycleLength}`), server `format_sms_body` denominator.
- Update `members_decrypted` / `transactions_decrypted` views only if a new column is added — none planned (`project_views_after_columns`).

### 4.7 — sprint-status.yaml

Add Epic 11 with Stories 11.1-11.4 at status `backlog`; Epic 11 status `backlog`.

---

## Section 5 — Implementation Handoff

**Scope: Major.** Recommended routing:

1. **Architect** — own Story 11.1 (ADR-004 amendment) first; the re-parameterized invariants gate everything downstream.
2. **Developer** — Stories 11.2 → 11.3 → 11.4 in order (engine → RPCs → consumers). 11.2 must land its 100% coverage + property tests before 11.3 touches the server recompute.
3. **PM/Founder** — approve PRD v1.4 edits (Section 4.1) and the `MIN_CYCLE_LENGTH_DAYS` default (3).

**Success criteria.**
- `npm run test -- --coverage` green; `src/domain/cycle/` at 100%.
- `commit_cycle_settlement` server recompute === engine `settle()` for variable lengths (NFR-R3 cross-check).
- A member registered on the 7th of a 30-day month shows projected balance `dailyAmount × 23`.
- Legacy 30-day cycles (pre-migration rows) still settle correctly.
- SMS receipt denominator reflects the actual cycle length.

**Open item for founder sign-off:** `MIN_CYCLE_LENGTH_DAYS` default = 3 (tunable constant; controls the end-of-month roll-forward threshold).
