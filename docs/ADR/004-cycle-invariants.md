# ADR-004 — Cycle-engine property-based test invariants

- **Status:** Accepted
- **Date:** 2026-04-23
- **Story:** 3.1 (Cycle-invariants ADR)
- **Authors:** dev pairing on Story 3.1
- **Supersedes:** —
- **Superseded by:** —

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
