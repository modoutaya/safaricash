# ADR-004 — Cycle-engine property-based test invariants

- **Status:** Accepted
- **Date:** 2026-04-23
- **Story:** 3.1 (Cycle-invariants ADR)
- **Authors:** dev pairing on Story 3.1
- **Supersedes:** —
- **Superseded by:** —
- **Amended:** 2026-05-19 — Amendment A1 (Story 11.1), calendar-month variable-length cycles. See `## Amendment A1` at the end of this document.
- **Amended:** 2026-05-20 — Amendment A1.8 (Story 11.5), `MAX_CYCLE_END_DAY = 30` cap (collectors don't work the 31st).

## Context

Architecture follow-up **AR16** (`epics.md:187`) calls out a gap: the architecture commits to 100 % statement + branch + function coverage on the cycle engine module (`src/domain/cycle/cycleEngine.ts`) via property-based testing, but does not enumerate the specific properties to test. The implementation-readiness report (`implementation-readiness-report-2026-04-19.md:539`) flags this as the explicit next step — write `docs/ADR/004-cycle-invariants.md` before EPIC-3 Story 3.2 starts.

The cycle engine is the **arithmetic heart** of SafariCash. It owns:

- **FR15** — initiate a 30-calendar-day cycle on member create / restart.
- **FR16** — track the member's position within the cycle (day 1..30) from `start_date`.
- **FR17** — compute the projected final balance: `(daily_amount × 30) − (1 × daily_amount) − Σ(outstanding advances)`.
- **FR18** — automatic status transitions: `active` ↔ `with_advance` ↔ `completed`.
- **FR19** — reject contributions on a `completed` cycle.
- **FR21** — settle a completed cycle and produce the final payout.

Settlement correctness is **NFR-R3 zero-tolerance**: the settled final balance must equal the projected final balance at day 30 for every fully-paid cycle. Any deviation is a P0 bug. PRD § Goals (`prd.md:85`): _"Zero-tolerance: any deviation is a P0 bug."_

A cycle is concretely:

- **30 calendar days**, day 1 = `start_date`, day 30 = `start_date + 29 days`.
- **29 contribution days** + **1 commission day** (the collector keeps exactly `1 × daily_amount` per cycle).
- **0..N advances** granted to the saver mid-cycle, each interest-free, each deducted from the projected balance.

The state space is `dailyAmount × cycleDay × advances[]`. At MVP scale, `dailyAmount ∈ [100, 100_000]` FCFA, `cycleDay ∈ [1, 30]`, and a member may have anywhere from 0 to ~30 advances per cycle. That's a multi-million-state surface that example-based tests cannot exhaustively enumerate. **Property-based testing via `fast-check`** is the correct verification strategy — it generates random inputs, asserts properties hold across them, and shrinks counterexamples to minimal failing cases.

## Decision

1. **Single source of truth.** `src/domain/cycle/cycleEngine.ts` is the only place cycle math lives. The UI, SMS receipt copy, and settlement Edge Function all consume it. Any divergence between the engine's output and what these surfaces display is a P0 bug.

2. **Property-based testing via `fast-check`.** Story 3.2 installs `fast-check` (latest stable, ≥ 4.x) as a `devDependency` and writes the property tests defined in this ADR's _Property test skeletons_ section.

3. **100 % coverage gate on `src/domain/cycle/`.** Vitest + v8 coverage; statement + branch + function thresholds all 100 %. Enforced by `npm test -- --coverage` in CI.

4. **The four BDD-mandated invariants (INV-1 to INV-4) are the floor.** Story 3.1's BDD (`epics.md:725`) explicitly enumerates them. The four additional invariants (INV-5 to INV-8) defined here carry the **same enforcement weight** — each gets a named property test that must pass before Story 3.2 ships.

5. **Existing prelude `src/features/member/api/computeMemberStats.ts`** carries a `TODO(Story 3.2)` marker noting it will move to `cycleEngine.ts`. Story 3.2 performs that move + replaces the import sites. This ADR pre-empts the move so the new home is unambiguous.

6. **The cycle engine is a pure function library.** No imports from `src/infrastructure/`, `src/features/`, React, or i18n. Inputs are scalars / arrays / records of scalars. Outputs are scalars / records of scalars. Any I/O — Supabase reads, current-time lookups, locale formatting — happens at the boundary, not inside the engine. INV-7 (settlement determinism) makes this contractual.

## Invariants

Each invariant has 5 fields: **statement**, **mathematical formulation**, **boundary conditions**, **counterexample bug-class**, and **property test skeleton name**. Skeleton names are stable contracts — Story 3.2's test file references them verbatim.

---

### INV-1 — Projected-balance time invariance

- **Statement.** The projected final balance depends only on `dailyAmount` and `Σ(advances)`. It does NOT depend on `cycleDay`. Two profile loads on day 5 and day 25 of the same cycle (with no new transactions in between) produce identical projected balances.
- **Mathematical formulation.** For all `cycleDay₁, cycleDay₂ ∈ [1, 30]`:
  ```
  projected(dailyAmount, advances, cycleDay₁) ≡ projected(dailyAmount, advances, cycleDay₂)
  ```
- **Boundary conditions.** Holds at `cycleDay = 1` (no contributions made yet — the formula is _projected_, not _current_ balance), at `cycleDay = 30` (cycle complete), and at every day in between.
- **Counterexample bug-class.** A regression where someone "optimises" the formula to subtract an extra day's worth as the cycle progresses (confusing _projected_ with _contributed-so-far_) breaks this invariant. INV-1 catches it.
- **Property test skeleton name.** `propProjectedBalanceTimeInvariance(dailyAmount, advances, cycleDay1, cycleDay2)`.

### INV-2 — Settled balance ≡ projected balance at day 30 (NFR-R3 gate)

- **Statement.** For a fully-paid cycle (all 29 contribution days recorded, no outstanding advances), the value `settle(...)` returns at day 30 is byte-identical to what `computeProjectedFinalBalance(...)` would have returned at day 30. Zero-tolerance per NFR-R3.
- **Mathematical formulation.** Given `advances = []` and `contributions.length = 29` (each = `dailyAmount`):
  ```
  settle(dailyAmount, contributions, advances) ≡ projected(dailyAmount, advances, 30)
  ≡ dailyAmount × 29
  ```
- **Boundary conditions.** Tested for `dailyAmount` across `[100, 100_000]` FCFA. Always-integer outputs (INV-8 corollary).
- **Counterexample bug-class.** A subtle off-by-one in the commission deduction (e.g., `dailyAmount × 30 − dailyAmount × 2` instead of `× 1`) breaks settlement determinism. NFR-R3 deems this a P0.
- **Property test skeleton name.** `propSettledEqualsProjectedAtDay30(dailyAmount)`.

### INV-3 — Advance capacity bound

- **Statement.** A new advance request `a` MUST be rejected if `Σ(existing_advances) + a > dailyAmount × 29 − Σ(existing_advances)`. Equivalent: the engine cannot accept an advance that would push the projected final balance below 0. This invariant is enforced at the _advance creation_ boundary (Story 4.x); the engine exposes a pure `canAcceptAdvance(...)` predicate this story will name explicitly.
- **Mathematical formulation.**
  ```
  canAcceptAdvance(dailyAmount, existingAdvances, a) ≡ (Σ(existingAdvances) + a) ≤ dailyAmount × 29
  ```
- **Boundary conditions.** Reject when `Σ + a` exactly equals `dailyAmount × 29 + 1` (over by 1 FCFA). Accept when `Σ + a` exactly equals `dailyAmount × 29` (final balance lands at 0). At `existingAdvances = []`, accept any `a ∈ [1, dailyAmount × 29]`.
- **Counterexample bug-class.** Off-by-one at the equality boundary (`<` vs `≤`) leads to a member with 0 FCFA owed at day 30 — fragile but technically valid; the off-by-one in the other direction silently overdraws. INV-3 fixes the inequality once and for all.
- **Property test skeleton name.** `propAdvanceCapacityBound(dailyAmount, existingAdvances, newAdvanceAmount)`.

### INV-4 — Commission invariance (exactly 1 × dailyAmount)

- **Statement.** The commission deducted from the projected balance is **always** exactly `1 × dailyAmount`, regardless of `cycleDay`, regardless of `Σ(advances)`, regardless of whether the cycle has been settled. The collector earns one day's contribution per cycle — never more, never less, never proportional, never tiered.
- **Mathematical formulation.** For all valid inputs:
  ```
  commission(dailyAmount, anything) ≡ dailyAmount
  ```
  And:
  ```
  projected(dailyAmount, advances, day) ≡ dailyAmount × 30 − commission(...) − Σ(advances)
                                       ≡ dailyAmount × 30 − dailyAmount − Σ(advances)
                                       ≡ dailyAmount × 29 − Σ(advances)
  ```
- **Boundary conditions.** Holds when `dailyAmount = 100` (smallest) and `dailyAmount = 100_000` (largest). Holds when `Σ(advances)` exceeds `dailyAmount × 29` (the projected balance goes negative; the commission is still exactly `1 × dailyAmount`).
- **Counterexample bug-class.** A "feature" PR introducing a tiered commission (e.g., 1 day per 30 days, 2 days per 60-day cycle in a future variant) would break NFR-R3 settlement determinism for existing 30-day cycles. INV-4 makes the invariant explicit so any such change forces a deliberate ADR amendment.
- **Property test skeleton name.** `propCommissionInvariance(dailyAmount, advances, cycleDay)`.

---

### INV-5 — Cycle-day clamping

- **Statement.** `cycleDay(start_date, now)` is always in `[1, 30]`. Days before `start_date` clamp to 1. Days after `start_date + 29` clamp to 30 (the engine treats post-day-30 the same as day 30 for projection purposes; FR19 / Story 3.4 owns the post-completion behaviour).
- **Mathematical formulation.**
  ```
  cycleDay(start, now) = min(30, max(1, floor((now − start) / 1 day) + 1))
  ```
- **Boundary conditions.** Tested with `now = start − 1ms`, `now = start`, `now = start + 1ms`, `now = start + 29 days − 1ms`, `now = start + 29 days`, `now = start + 30 days`, `now = start + 100 days`.
- **Counterexample bug-class.** Negative cycle-day from a clock-skew client (`now < start`) causing UI to render "Jour −2 sur 30" or "Jour 0 sur 30". INV-5 makes the clamping contractual.
- **Property test skeleton name.** `propCycleDayClamped(startDate, now)`.

### INV-6 — Cycle-day monotonicity in real time

- **Statement.** For any two timestamps `t₁ < t₂`, `cycleDay(start, t₁) ≤ cycleDay(start, t₂)`. The cycle day never moves backwards as wall-clock time advances.
- **Mathematical formulation.**
  ```
  ∀ start, t₁, t₂: t₁ ≤ t₂ ⇒ cycleDay(start, t₁) ≤ cycleDay(start, t₂)
  ```
- **Boundary conditions.** Holds at the day-29 → day-30 boundary (one of these returns 30, the other returns 30 — the clamp absorbs the transition). Holds across DST transitions (the engine uses UTC internally).
- **Counterexample bug-class.** A clock-correction event on the user's device (e.g., NTP sync moving `Date.now()` backwards) followed by a profile re-load showing an _earlier_ cycle day. INV-6 ensures the engine's read of `now` is monotonic-in-time.
- **Property test skeleton name.** `propCycleDayMonotonic(startDate, t1, t2)`.

### INV-7 — Settlement determinism (no hidden state)

- **Statement.** Given identical inputs (`dailyAmount`, sorted contributions, sorted advances, `start_date`), `settle(...)` returns the same FCFA integer on every call. The engine reads no `Date.now()`-style ambient state, no random sources, no Supabase reads. Pure function in / pure function out.
- **Mathematical formulation.**
  ```
  ∀ inputs: settle(inputs) ≡ settle(inputs)  // referentially transparent
  ```
- **Boundary conditions.** Re-running `settle(...)` 1000 times with the same inputs yields 1000 identical outputs. Holds across process restarts. Holds across machine boundaries (no locale-dependent number formatting inside the engine — INV-8 corollary).
- **Counterexample bug-class.** A "convenience" `Date.now()` call inside the engine to compute "current commission day" turns settlement non-deterministic — running the same cycle twice yields different totals. INV-7 outlaws this from day one.
- **Property test skeleton name.** `propSettlementDeterministic(scenario)`.

### INV-8 — Integer FCFA throughout

- **Statement.** Every public function in `cycleEngine.ts` that returns a monetary amount returns an `integer` FCFA value (no decimals, no fractions). The engine never introduces floating-point intermediaries that could surface as `1234.0000000001`.
- **Mathematical formulation.**
  ```
  ∀ public_function f, ∀ inputs i: Number.isInteger(f(i).amount) === true
  ```
- **Boundary conditions.** Holds for the largest inputs (`dailyAmount = 100_000`, 30 advances of `10_000` each). Holds when the projected balance is negative (still an integer, just `< 0`).
- **Counterexample bug-class.** A future contributor introduces a percentage-based fee that uses `* 0.01`, producing `0.99999...` artefacts. INV-8 catches it before it reaches the SMS receipt copy where "1 234.99 FCFA" looks like a bug.
- **Property test skeleton name.** `propIntegerFcfaOutputs(scenario)`.

## Property test skeletons

The skeletons below are **illustrative** TypeScript pseudocode — Story 3.2 may refactor function signatures (e.g., bundling inputs into a `Scenario` shape). The invariant ID + name + intent are fixed; the function surface is implementation-defined.

### INV-1 — `propProjectedBalanceTimeInvariance`

```ts
// src/domain/cycle/cycleEngine.test.ts (Story 3.2)
import fc from "fast-check";
import { computeProjectedFinalBalance } from "./cycleEngine";

it("INV-1: projected balance is invariant in cycleDay", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }), // dailyAmount
      fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 0, maxLength: 30 }),
      fc.integer({ min: 1, max: 30 }), // cycleDay1
      fc.integer({ min: 1, max: 30 }), // cycleDay2
      (dailyAmount, advances, day1, day2) => {
        const a = computeProjectedFinalBalance(dailyAmount, 0, sum(advances), day1);
        const b = computeProjectedFinalBalance(dailyAmount, 0, sum(advances), day2);
        return a === b;
      },
    ),
  );
});
```

### INV-2 — `propSettledEqualsProjectedAtDay30`

```ts
it("INV-2: settled balance equals projected balance at day 30 (NFR-R3 gate)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }), // dailyAmount
      (dailyAmount) => {
        const contributions = Array.from({ length: 29 }, () => dailyAmount);
        const settled = settle(dailyAmount, contributions, []);
        const projected = computeProjectedFinalBalance(dailyAmount, sum(contributions), 0, 30);
        return settled === projected && settled === dailyAmount * 29;
      },
    ),
  );
});
```

### INV-3 — `propAdvanceCapacityBound`

```ts
it("INV-3: advance request is accepted iff total advances stay within capacity", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }),
      fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 20 }),
      fc.integer({ min: 1, max: 100_000 }),
      (dailyAmount, existing, newAdvance) => {
        const totalIfAccepted = sum(existing) + newAdvance;
        const capacity = dailyAmount * 29;
        const expected = totalIfAccepted <= capacity;
        return canAcceptAdvance(dailyAmount, existing, newAdvance) === expected;
      },
    ),
  );
});
```

### INV-4 — `propCommissionInvariance`

```ts
it("INV-4: commission is exactly 1 × dailyAmount, always", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }),
      fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
      fc.integer({ min: 1, max: 30 }),
      (dailyAmount, advances, cycleDay) => {
        return commission(dailyAmount, advances, cycleDay) === dailyAmount;
      },
    ),
  );
});
```

### INV-5 — `propCycleDayClamped`

```ts
it("INV-5: cycleDay is clamped to [1, 30]", () => {
  fc.assert(
    fc.property(
      fc.date({ min: new Date("2026-01-01"), max: new Date("2026-12-31") }),
      fc.integer({ min: -100, max: 100 }), // days from start_date
      (start, dayOffset) => {
        const now = new Date(start.getTime() + dayOffset * 86_400_000);
        const day = cycleDay(start.toISOString().slice(0, 10), now);
        return day >= 1 && day <= 30;
      },
    ),
  );
});
```

### INV-6 — `propCycleDayMonotonic`

```ts
it("INV-6: cycleDay is monotonic in real time", () => {
  fc.assert(
    fc.property(
      fc.date({ min: new Date("2026-01-01"), max: new Date("2026-12-31") }),
      fc.date(),
      fc.date(),
      (start, t1, t2) => {
        const startDate = start.toISOString().slice(0, 10);
        const [early, late] = t1 < t2 ? [t1, t2] : [t2, t1];
        return cycleDay(startDate, early) <= cycleDay(startDate, late);
      },
    ),
  );
});
```

### INV-7 — `propSettlementDeterministic`

```ts
it("INV-7: settle() is referentially transparent", () => {
  fc.assert(
    fc.property(
      fc.record({
        dailyAmount: fc.integer({ min: 100, max: 100_000 }),
        contributions: fc.array(fc.integer({ min: 1, max: 100_000 }), { maxLength: 30 }),
        advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
      }),
      (s) => {
        const a = settle(s.dailyAmount, s.contributions, s.advances);
        const b = settle(s.dailyAmount, s.contributions, s.advances);
        return a === b;
      },
    ),
  );
});
```

### INV-8 — `propIntegerFcfaOutputs`

```ts
it("INV-8: every monetary output is an integer FCFA", () => {
  fc.assert(
    fc.property(
      fc.record({
        dailyAmount: fc.integer({ min: 100, max: 100_000 }),
        contributions: fc.array(fc.integer({ min: 1, max: 100_000 }), { maxLength: 30 }),
        advances: fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 30 }),
        cycleDay: fc.integer({ min: 1, max: 30 }),
      }),
      (s) => {
        const projected = computeProjectedFinalBalance(
          s.dailyAmount,
          sum(s.contributions),
          sum(s.advances),
          s.cycleDay,
        );
        const settled = settle(s.dailyAmount, s.contributions, s.advances);
        const comm = commission(s.dailyAmount, s.advances, s.cycleDay);
        return [projected, settled, comm].every(Number.isInteger);
      },
    ),
  );
});
```

## Implementation notes

- **`fast-check` version.** Latest stable (≥ 4.x) at the time Story 3.2 is implemented. `devDependencies` only — never imported from `src/`.
- **Counterexample shrinking.** `fast-check` shrinks failures automatically. Story 3.2's tests must NOT add `numRuns` overrides without a documented reason (defaults are fine at MVP scale; 100 runs per property × 8 properties = 800 random scenarios per CI run, well under 1 second).
- **Existing prelude — `src/features/member/api/computeMemberStats.ts`.** Already implements FR17 with a `TODO(Story 3.2)` marker. Story 3.2 moves the function into `cycleEngine.ts`, replaces the import sites (`useMemberProfile.ts`), and deletes the helper. The two computations are byte-equivalent — no behavioural change at the UI layer.
- **Out-of-scope for the engine module.** Anything that touches `src/infrastructure/` (Supabase, fetch), React, i18n, or Date.now()-style ambient state. The engine is a pure function library (INV-7 makes this contractual).
- **Rounding policy.** All amounts are FCFA (whole francs). No fractional FCFA exist in the system. The engine uses plain `number` typed as integer; if a future computation introduces division, round at the boundary using `Math.round(...)` and assert no fractional intermediaries (INV-8 catches drift).
- **What this ADR does NOT specify.** Status-transition rules (Story 3.3 owns FR18), settlement Edge Function (Story 7.x), settlement-day choice for the saver (Story 7.x). This ADR only owns the **arithmetic** of the engine; transitions and orchestration are layered on top in subsequent stories.

## Open questions

Story 3.2 must answer these before coding. Recommended defaults below; Story 3.2 may override with a documented rationale.

- **Q1 — Negative projected balance.** When `Σ(advances) > dailyAmount × 29`, the formula yields a negative number. Should the engine return the negative value (transparency) OR clamp at 0 (UI-friendly)? **Recommendation:** return the raw value. Let the UI decide presentation (e.g., render in red, show 0 with a warning badge). INV-3 prevents this in normal flow, but defensive transparency at the engine level beats silent clamping.
- **Q2 — Settlement timing.** Architecture references both "at day 30" and "after day 30". Recommendation: **`settle(...)` accepts any `now ≥ start_date + 29 days`** so a collector can settle at 23:59 on day 30 if needed. The engine doesn't reject early calls (collectors might preview the settlement amount on day 28 to plan cash withdrawal); a separate `isSettlementReady(...)` predicate gates the actual settlement write at the Edge Function layer.

## References

- **PRD:**
  - `_bmad-output/planning-artifacts/prd.md` lines 493-501 (FR15-FR21 cycle management),
  - line 565 (NFR-R3 zero-tolerance gate),
  - line 85 (Goals — "Zero settlement surprises at day 30").
- **Architecture:**
  - `_bmad-output/planning-artifacts/architecture.md` line 44 (Cycle Management table row),
  - line 1086 (component-source map for FR15-21),
  - line 1102 (NFR-R3 mapped to `cycleEngine.test.ts`),
  - line 1272 (Q-ARCH cycle invariants follow-up — explicit ADR-004 callout),
  - line 1360 (next-step item: write ADR-004),
  - lines 887-892 (`src/domain/cycle/cycleEngine.ts` + `.test.ts` slot in the project tree),
  - line 245 (100 % coverage target on cycle engine).
- **Epics:**
  - `_bmad-output/planning-artifacts/epics.md` line 187 (AR16 follow-up),
  - lines 715-726 (Story 3.1 BDD),
  - lines 728-741 (Story 3.2 BDD — the consumer of this ADR's invariants).
- **Existing prelude:** `src/features/member/api/computeMemberStats.ts` (FR17 implemented with `TODO(Story 3.2)` marker that this ADR formalises).
- **ADR template:** `docs/ADR/001-supabase-vault.md` (front-matter + section conventions).
- **Implementation-readiness report:** `_bmad-output/planning-artifacts/implementation-readiness-report-2026-04-19.md` line 539 (next-step ADR-004).

## Amendment A1 — Calendar-Month Variable-Length Cycles (2026-05-19)

> **Status:** Accepted. **Story:** 11.1. **Amends:** INV-1, INV-2, INV-3, INV-5 (re-parameterized for variable cycle length); adds INV-9. INV-4, INV-6, INV-7, INV-8 are unchanged and re-confirmed below. All Sections above (the fixed 30-day model) are preserved as the record of what Epic 3 shipped; **this amendment takes precedence wherever they conflict.**

### A1.1 — Context

The fixed 30-calendar-day cycle is replaced by a **calendar-month-aligned** cycle. Trigger: founder requirement raised 2026-05-19, processed via `bmad-correct-course`. The canonical decision record is `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` — this amendment encodes its §4.2 into ADR form.

New model:

| Concept                 | Rule                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_date`            | Member registration date (first cycle) or restart date (FR12 restart).                                                                                  |
| `end_date`              | Last calendar day of `month(start_date)`.                                                                                                               |
| Roll-forward            | If `end_date − start_date + 1 < MIN_CYCLE_LENGTH_DAYS`, the cycle rolls to the next month: `start_date` = 1st of next month, `end_date` = its last day. |
| `cycleLength`           | `end_date − start_date + 1` (inclusive, 1-based, always `≥ MIN_CYCLE_LENGTH_DAYS`).                                                                     |
| `contributionDays`      | `cycleLength − 1`.                                                                                                                                      |
| `commission`            | `1 × dailyAmount` — one full day, always (see INV-4).                                                                                                   |
| `projectedFinalBalance` | `dailyAmount × (cycleLength − 1) − Σ(advances)`.                                                                                                        |

**Worked example.** A member registered on the 7th of a 30-day month: `start_date` = the 7th, `end_date` = the 30th, `cycleLength = 30 − 7 + 1 = 24`, `contributionDays = 23`, payout with no advances = `dailyAmount × 23`.

**Steady state.** Once a cycle ends on a month's last day and the next is started on the 1st, every subsequent cycle is a full calendar month (28/29/30/31 days). Only a member's first cycle — or a mid-month FR12 restart — is partial.

**Engine generalization.** Every `30` / `29` / `[1, 30]` in the Sections above becomes a per-cycle value: `cycleLength` replaces the constant 30; `contributionDays = cycleLength − 1` replaces 29. The pure-function contract (INV-7), the zero-infrastructure rule, and the 100 % coverage gate are unchanged. Derived helpers generalize the same way: `daysUntilCycleEnd` and the `daysRemaining` field of `computeMemberStats` become `cycleLength − cycleDay` (was `30 − cycleDay`) — both currently hard-code `CYCLE_TOTAL_DAYS` and Story 11.2 must thread `cycleLength` into them.

### A1.2 — Amended invariants

**INV-1 — Projected-balance time invariance — AMENDED (domain only).**
Still holds: the projected final balance depends only on `dailyAmount` and `Σ(advances)`, never on `cycleDay`. The only change is the `cycleDay` domain — `[1, cycleLength]` instead of `[1, 30]`. The formula is unchanged in shape: `projected = dailyAmount × (cycleLength − 1) − Σ(advances)`, evaluated identically for every `cycleDay`. Skeleton: `propProjectedBalanceTimeInvariance` (name unchanged; arbitraries gain `cycleLength`).

**INV-2 — Settled ≡ projected at cycle end — AMENDED (NFR-R3 gate).**
"Day 30" becomes "the cycle's last day (`end_date`)". For a fully-paid cycle (all `contributionDays` recorded, no outstanding advances):

```
settle(...) ≡ projected(...) ≡ dailyAmount × (cycleLength − 1)
```

NFR-R3 zero-tolerance is reaffirmed for every cycle length. **Skeleton renamed:** `propSettledEqualsProjectedAtDay30` → `propSettledEqualsProjectedAtCycleEnd`. Story 11.2 must rename the test accordingly.

**INV-3 — Advance capacity bound — AMENDED.**
The capacity ceiling `dailyAmount × 29` becomes `dailyAmount × contributionDays` (= `dailyAmount × (cycleLength − 1)`):

```
canAcceptAdvance(...) ≡ (Σ(existingAdvances) + a) ≤ dailyAmount × (cycleLength − 1)
```

The strict `≤` at the equality boundary is preserved (landing at exactly 0 projected balance is allowed). Skeleton: `propAdvanceCapacityBound` (name unchanged; arbitraries gain `cycleLength`).

**INV-5 — Cycle-day clamping — AMENDED.**
The clamp range `[1, 30]` becomes `[1, cycleLength]`. The function takes the cycle's `start_date` and `end_date` and derives the length internally — `cycleLength` is never a separate parameter:

```
cycleLength               = end − start + 1
cycleDay(start, end, now) = min(cycleLength, max(1, floor((now − start) / 1 day) + 1))
```

Any `now` before `start_date` clamps to 1; any `now` after `end_date` clamps to `cycleLength`. Skeleton: `propCycleDayClamped` (name unchanged; the upper bound becomes the derived `cycleLength`, not the literal 30). The A1.6 skeleton constructs `end` from a generated `cycleLength` so the call site matches the `(start, end, now)` signature.

### A1.3 — Unchanged invariants (re-confirmed)

**INV-4 — Commission invariance — UNCHANGED.**
Commission is exactly `1 × dailyAmount`, always — regardless of `cycleDay`, regardless of `Σ(advances)`, regardless of settlement state, **and regardless of cycle length**.

> **Partial-cycle note (founder decision, 2026-05-19).** A partial first cycle — or a mid-month restart — still takes exactly **one full commission day**. The commission is **never prorated** to the cycle length: a 24-day cycle and a 31-day cycle both yield `commission = 1 × dailyAmount`.
>
> This is load-bearing for INV-8. A whole-day commission keeps the formula a whole multiple of `dailyAmount` — no division, no fractional FCFA. **Counterexample bug-class (extended):** a contributor who "fairly" prorates the commission as `dailyAmount × cycleLength / 30` introduces a division → fractional FCFA → INV-8 violation → NFR-R3 P0.

Skeleton: `propCommissionInvariance` (unchanged).

**INV-6 — Cycle-day monotonicity in real time — UNCHANGED.** `t₁ ≤ t₂ ⇒ cycleDay(t₁) ≤ cycleDay(t₂)` still holds; the variable upper clamp (`cycleLength` vs `30`) does not affect monotonicity. Skeleton: `propCycleDayMonotonic`.

**INV-7 — Settlement determinism — UNCHANGED.** `settle(...)` remains a pure function — no `Date.now()` reads, no ambient state. `cycleLength` is derived from the cycle row's caller-supplied `start_date` / `end_date`, not from a clock read, so referential transparency is preserved. Skeleton: `propSettlementDeterministic`.

**INV-8 — Integer FCFA throughout — UNCHANGED.** Every monetary output stays an integer FCFA. The variable-length model introduces **no division**: `cycleLength` and `contributionDays` are integers, and the commission is a whole `1 × dailyAmount` (INV-4), so `dailyAmount × (cycleLength − 1) − Σ(advances)` is integer by construction. Skeleton: `propIntegerFcfaOutputs`.

### A1.4 — INV-9 — Cycle-bounds derivation — NEW

- **Statement.** For any `start_date`, the cycle's `end_date` is the last calendar day of `month(start_date)`. If the resulting length is below `MIN_CYCLE_LENGTH_DAYS`, the cycle rolls forward to the next month (start = 1st, end = its last day). The derived `cycleLength` is always `≥ MIN_CYCLE_LENGTH_DAYS`.
- **Scope — write-path only.** INV-9 constrains what `deriveCycleBounds` produces and what Story 11.3's RPCs (`create_member_with_cycle`, `restart_member_cycle`) write. It is **not** a read-path assertion on existing rows: legacy cycles created before Story 11.3 store `end_date = start_date + 29 days` (not a month-end) and are exempt by design — see A1.7. The engine's read-path functions accept any `(start_date, end_date)` pair and derive `cycleLength` from it; they never assume INV-9 holds for the row they are given.
- **Mathematical formulation.**

  ```
  endOfMonth(d) = last calendar day of month(d)
  rawLen(d)     = endOfMonth(d) − d + 1

  if rawLen(start) ≥ MIN_CYCLE_LENGTH_DAYS:
      (start_date, end_date) = (start, endOfMonth(start))
  else:
      next = first day of (month(start) + 1)         // year-aware: Dec → Jan next year
      (start_date, end_date) = (next, endOfMonth(next))

  cycleLength = end_date − start_date + 1            // always ≥ MIN_CYCLE_LENGTH_DAYS
  ```

- **Boundary conditions.** Registration on the 1st → full month (length 28/29/30/31, no roll-forward). Registration on the last day → `rawLen = 1 < 3` → roll-forward. Registration with exactly `MIN_CYCLE_LENGTH_DAYS` days remaining → **no** roll-forward (the `≥` boundary is inclusive). February (28 or 29 days). A December registration that rolls forward → January of the **next year** (the year boundary must be handled).
- **Counterexample bug-class.** An off-by-one in `endOfMonth` returning the 1st of the next month (length inflated by a day); a roll-forward using `<` in one place and `≤` in another, producing a 2-day cycle where `commission ≥ contributions`; a year-boundary bug rolling December into "month 13" instead of January.
- **Property test skeleton name.** `propCycleBoundsDerivation`.

### A1.5 — `MIN_CYCLE_LENGTH_DAYS` constant

The roll-forward threshold is a single named constant, **`MIN_CYCLE_LENGTH_DAYS`**, default value **3**. Story 11.2 adds it to `src/domain/cycle/cycleEngine.ts` as an exported `const` — a single point of edit, mirroring the existing `DEFAULT_CYCLE_ENDING_WINDOW_DAYS`. It is a **product-tunable** value pending founder sign-off (see A1.9 — A1-Q1). The engine and every test MUST read the constant, never the literal `3`.

### A1.6 — Property-test skeletons (amended + new)

Illustrative `fast-check` pseudocode — Story 11.2 implements these in `src/domain/cycle/cycleEngine.test.ts`. Function signatures are implementation-defined; the invariant ID, skeleton name, and intent are fixed.

```ts
// INV-1 — projected balance is invariant in cycleDay (variable-length)
it("INV-1: projected balance does not depend on cycleDay", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }), // dailyAmount
      fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }), // cycleLength
      fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 31 }), // advances
      (dailyAmount, cycleLength, advances) => {
        const contributionDays = cycleLength - 1;
        // cycleDay is NOT an input to the projection — invariance is structural.
        // Any two evaluations on the same cycle yield the same value.
        const a = computeProjectedFinalBalance(dailyAmount, sum(advances), contributionDays);
        const b = computeProjectedFinalBalance(dailyAmount, sum(advances), contributionDays);
        return a === b;
      },
    ),
  );
});

// INV-2 (renamed) — settled ≡ projected at the cycle's last day
it("INV-2: settled balance equals projected balance at cycle end (NFR-R3 gate)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }), // dailyAmount
      fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }), // cycleLength
      (dailyAmount, cycleLength) => {
        const contributionDays = cycleLength - 1;
        // The substance of INV-2: settle() and the projection must agree byte-for-byte.
        const settled = settle(dailyAmount, [], contributionDays);
        const projected = computeProjectedFinalBalance(dailyAmount, 0, contributionDays);
        return settled === projected && settled === dailyAmount * contributionDays;
      },
    ),
  );
});

// INV-3 — advance capacity bound, parameterized on cycleLength
it("INV-3: advance accepted iff total advances ≤ dailyAmount × (cycleLength − 1)", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 100, max: 100_000 }),
      fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }),
      fc.array(fc.integer({ min: 1, max: 10_000 }), { maxLength: 20 }),
      fc.integer({ min: 1, max: 100_000 }),
      (dailyAmount, cycleLength, existing, newAdvance) => {
        const capacity = dailyAmount * (cycleLength - 1);
        const expected = sum(existing) + newAdvance <= capacity;
        return canAcceptAdvance(dailyAmount, cycleLength, existing, newAdvance) === expected;
      },
    ),
  );
});

// INV-5 — cycleDay clamped to [1, cycleLength]
it("INV-5: cycleDay is clamped to [1, cycleLength]", () => {
  fc.assert(
    fc.property(
      fc.date({ min: new Date("2026-01-01"), max: new Date("2026-12-31") }),
      fc.integer({ min: MIN_CYCLE_LENGTH_DAYS, max: 31 }), // cycleLength
      fc.integer({ min: -100, max: 200 }), // day offset from start
      (start, cycleLength, dayOffset) => {
        // cycleDay's signature is (startDate: string, endDate: string, now: Date).
        // Build endDate from the generated cycleLength so the call site matches.
        const startDate = start.toISOString().slice(0, 10);
        const endDate = isoDatePlusDays(startDate, cycleLength - 1);
        const now = new Date(start.getTime() + dayOffset * 86_400_000);
        const day = cycleDay(startDate, endDate, now);
        return day >= 1 && day <= cycleLength;
      },
    ),
  );
});

// INV-9 (new) — cycle-bounds derivation + roll-forward
it("INV-9: end_date is month-end of start; short residual rolls forward; length ≥ MIN", () => {
  fc.assert(
    fc.property(fc.date({ min: new Date("2026-01-01"), max: new Date("2027-12-31") }), (start) => {
      const requested = start.toISOString().slice(0, 10);
      const { startDate, endDate } = deriveCycleBounds(requested);
      const length = daysBetweenInclusive(startDate, endDate);
      return (
        // end_date must be the last day of START's month — not merely some month-end.
        endDate === endOfMonth(startDate) &&
        length >= MIN_CYCLE_LENGTH_DAYS &&
        // startDate is either the requested date (no roll-forward) or the 1st of next month.
        (startDate === requested || startDate === firstDayOfNextMonth(requested))
      );
    }),
  );
});
```

`propProjectedBalanceTimeInvariance` keeps the INV-1 skeleton above; its `cycleDay`-bearing form from the original "Property test skeletons" section is superseded — in the variable-length engine `cycleDay` is not an input to the projection, so the invariance is structural rather than checked across two day values.

### A1.7 — Legacy-cycle compatibility

Cycles created **before** Story 11.3 store `end_date = start_date + 29 days` (the old fixed window). The amended engine derives `cycleLength` from the row's `start_date` / `end_date`, so a legacy row yields `cycleLength = 30` and every invariant degrades exactly to the original 30-day behaviour. **No data backfill is required.** Story 11.2's property tests MUST include an explicit `cycleLength = 30` case to lock this equivalence.

A legacy row's `end_date` is **not** a month-end, so legacy rows do **not** satisfy INV-9 — this is expected and correct: INV-9 is a write-path invariant (see its Scope note) constraining only newly-derived bounds, not a postcondition retroactively asserted on rows already in the table. The read-path invariants (INV-1, INV-2, INV-3, INV-5) hold for legacy rows because they consume the row's stored `start_date` / `end_date` directly.

### A1.8 — `MAX_CYCLE_END_DAY` cap (Story 11.5)

- **Statement.** A cycle's `end_date` is capped at the **30th** of its month, even when the calendar month has 31 days. The cap is inert for 28/29/30-day months. The amended INV-9 formula (see A1.4) becomes:

  ```text
  monthEnd(start_date) = min(lastCalendarDay(month(start_date)), MAX_CYCLE_END_DAY)
  ```

  Both branches of `deriveCycleBounds` use the capped value: the "stay" branch's `end_date`, and the roll-forward branch's `end_date` for the _next_ month.

- **Operational rationale.** The pilot collector does not work the 31st. The cap removes the 31st as a possible cycle-end day so the daily contribution / settlement workflow always lands on a working day. Pre-Epic 11 (fixed 30-day windows) implicitly satisfied this; the amended calendar-month model re-opens it, so the cap restores the operator's invariant.

- **Boundary impact.** For 31-day months (Jan, Mar, May, Jul, Aug, Oct, Dec) the cap shifts the rollover boundary by exactly 1 day: registration on `lastDay − 1` of a 31-day month was previously the inclusive-MIN boundary (length 3, stayed), but is now `rawLen = 2 < MIN` and rolls forward. Operationally inert — pilot collector adds members before the 25th (well below either boundary) — but the rule is encoded in the math so defensive callers (CSV imports, fixture seeds) stay consistent.

- **Constant.** Exported as `MAX_CYCLE_END_DAY` from `src/domain/cycle/cycleEngine.ts`. Mirrored by Story 11.5's migration `20260520183325_cap_cycle_end_day_30.sql` (`LEAST((month_first + interval '1 month - 1 day'), month_first + 29)`). Single point of edit; if raised here, raise the SQL `+ 29` in lockstep.

- **No constraint tightening.** Migration 11.3's `transactions.cycle_day BETWEEN 1 AND 31` check is **kept** at 31 (not narrowed to 30). Reason: legacy 30-day rows from before Story 11.3 had `end_date = start_date + 29 days` → `cycleLength = 30` → max `cycle_day = 30`, but defensive headroom for any operator hand-edit + the legacy-compat principle (A1.7) argue for keeping the wider bound.

### A1.9 — Amendment Open Questions

- **A1-Q1 — `MIN_CYCLE_LENGTH_DAYS` value.** Default **3**, pending founder sign-off. A higher value (e.g. 5–7) makes more end-of-month registrations roll forward; a lower value permits very short partial cycles. Story 11.3 reads the constant — changing it later is a one-line edit, no migration.
- **A1-Q2 — Automatic cycle restart.** The new model makes "the next cycle is the full following month" natural, but cycle restart is still the **manual** FR12 action (Story 2.7). Whether to auto-start the next cycle on the 1st of the month is **out of scope for Epic 11** — noted here only so a future story can pick it up deliberately.

### A1.10 — References

- **Canonical decision record:** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-19.md` (§ "Canonical new model", §4.2).
- **Epic + story:** `_bmad-output/planning-artifacts/epics.md` — Epic 11, Story 11.1.
- **PRD (amended under v1.4):** `_bmad-output/planning-artifacts/prd.md` — FR15-FR17, FR19 (lines 495-499), NFR-R3 (line 565).
- **Engine to refactor (Story 11.2):** `src/domain/cycle/cycleEngine.ts`.
- **RPCs to refactor (Story 11.3):** `supabase/migrations/*create_member_with_cycle*.sql`, `*restart_member_cycle*.sql`, `*commit_cycle_settlement*.sql`.
