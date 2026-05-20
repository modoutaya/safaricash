# Story 12.3: Cycle auto-restart on the 1st of each month + advance carry-over

Status: ready for implementation (Q1-Q4 resolved 2026-05-20)

## Story

As a **collector**,
I want **every active member's cycle to automatically close at end of month and a new cycle to open on the 1st of the next month, with any unpaid balance from the previous cycle carried over as an opening debt**,
so that **I don't have to manually restart 300-500 members one by one every month, and the saver's running debt remains visible across cycles.**

## Context

After Epic 11 (variable-length calendar-month cycles) + Story 11.5 (cap end_date at day 30), cycles are already month-aligned in shape. But the *transition* between cycles is still manual — Story 2.7 added a `restart_member_cycle` RPC + UI button that the collector invokes per-member. At pilot scale (300-500 members per collector) this is operationally infeasible.

The pilot collector requested (2026-05-20):
1. Auto-restart on the 1st of each month
2. Carry-over of unpaid balance from previous cycle as opening debt on the new cycle

Decision #2 is the heavy one — it introduces a new "opening_balance" concept that touches NFR-R3 (zero-tolerance settlement correctness) math at multiple layers (TS engine, SQL RPCs, SMS templates, receipt URLs).

## Decisions locked in chat (2026-05-20)

| Decision | Value |
|---|---|
| Previous cycle status after auto-restart | `completed`, awaits **manual** settlement (consistent with existing Story 7.x flow) |
| Outstanding advances treatment | **Carry-over to new cycle as opening debt** (`opening_balance` field) |
| Restart trigger | All members with `status='active'` on the 1st of each month |

## Resolved product questions (2026-05-20)

### Q1 — Opening balance: dynamic computation (no stored column) ✅

**Resolved: Path A — dynamic computation.**

`opening_balance` is NOT stored. It's a derived quantity computed at query time:

```
opening_balance(member) =
  IF previous_cycle EXISTS AND previous_cycle.status IN ('completed', 'active', 'with_advance')
    THEN max(0, previous_cycle.outstanding_balance)
  ELSE
    0
```

Where `previous_cycle.outstanding_balance = Σ(advances) + previous.opening_balance − daily × actual_contribution_days` (recursive definition — see § "Math model" for the closed form).

**Rationale**: no double-counting risk by construction. When the previous cycle flips to `settled`, the dynamic read naturally returns 0 going forward — no trigger needed, no stored state to drift.

**Cost**: every RPC that computes projected balance now reads the previous-cycle row in addition to the current cycle. One extra SQL fetch per balance read. Acceptable at MVP scale.

### Q2 — Carry-over exceeding capacity: no cap, debt accumulates ✅

**Resolved: Option C — no cap, debt stacks across cycles until fully repaid.**

If `opening_balance > daily × contributionDays`, the new cycle's projected balance stays negative even with full contributions. The saver continues to repay across multiple cycles until the debt is cleared. The auto-restart on the 1st rolls forward the *remaining* debt each month.

**Rationale**: matches the real-world workflow — pilot collector reports they keep tracking debt across months until full repayment ("jusqu'à épuisement complet de la dette").

### Q2bis — Advances while in debt: blocked ✅

`record_advance` keeps its current capacity check: `Σ(existing) + new ≤ daily × contributionDays − opening_balance`.

When `opening_balance ≥ daily × contributionDays`, the right-hand side is ≤ 0 and ALL new advances are rejected. The saver must first repay the carry-over via contributions. Consistent with the "repay before borrow more" semantic locked in Q2.

### Q3 — Mid-month-onboarded members: yes, they participate ✅

**Resolved: uniform behavior.** A member added on May 15 (cycle May 15-30, length 16) will see that cycle closed on June 1 and a fresh June 1-30 cycle opened. All `status='active'` members traverse the same monthly transition; no carve-out for "freshly added".

### Q4 — Members on `paused` status: skipped ✅

**Resolved: paused members are NOT restarted.** Only `members.status='active'` participates in the cron. Paused members keep their current cycle frozen. Reactivation flow (un-pause → manual restart) remains the Story 2.7 path.

## Acceptance Criteria

> The 12 ACs below are the FROZEN contract for the implementation PR. Q1-Q4 are resolved (see above); Q1 = Path A (dynamic) means there is **no `opening_balance` column** — it's a computed quantity.

1. **NO schema migration for `opening_balance`.**
   Per Q1 (Path A — dynamic), `opening_balance` is NOT stored as a column. The math layer derives it from the previous cycle's state. This is a deliberate simplification vs the earlier draft: no migration, no view re-projection, no backfill, no trigger.

2. **New SQL helper — `compute_opening_balance(p_member_id uuid, p_cycle_id uuid)`.**
   Returns `int` (the opening_balance for the cycle identified by `p_cycle_id`, owned by `p_member_id`). Algorithm:
   ```
   IF p_cycle_id IS THE FIRST CYCLE OF THE MEMBER → return 0
   prev := the cycle immediately preceding p_cycle_id (cycle_number − 1)
   IF prev.status = 'settled' → return 0
   prev_balance := daily × (cycle_length(prev) − 1) − Σ(prev.advances) − compute_opening_balance(p_member_id, prev.id)
   IF prev_balance >= 0 → return 0      -- no debt to carry over
   return −prev_balance                  -- positive carry-over (debt amount)
   ```
   STABLE, SECURITY DEFINER, RLS-scoped via member ownership check. Cached per call chain (Postgres will memoize the recursion within a single query).

3. **TS engine — `cycleEngine.ts` update.**
   - `computeProjectedFinalBalance(dailyAmount, outstandingAdvances, contributionDays, openingBalance = 0)` — new optional last param.
     New formula: `dailyAmount × contributionDays − outstandingAdvances − openingBalance`.
   - `settle(dailyAmount, advances, contributionDays, openingBalance = 0)` — same.
   - `canAcceptAdvance(dailyAmount, existing, newAdvance, contributionDays, openingBalance = 0)` — same.
   - `MemberStats.openingBalance: number` — added to the derived stats shape.

4. **Property test update — `cycleEngine.test.ts`.**
   - INV-1 (projected balance time invariance) — re-stated with `openingBalance` in the input vector; invariance holds for any fixed openingBalance.
   - INV-3 (advance capacity bound) — capacity becomes `dailyAmount × contributionDays − openingBalance`; tested at the equality boundary.
   - New property: `propOpeningBalanceMonotonic` — for `openingBalance₁ ≤ openingBalance₂`, the projected balance with the larger openingBalance is ≤ the projected balance with the smaller (i.e. monotonically decreasing in openingBalance).

5. **RPC — `record_advance` capacity check update.**
   New capacity formula: `Σ(existing advances) + new_advance ≤ daily_amount × (cycle_length − 1) − opening_balance`.
   `opening_balance` is fetched via `compute_opening_balance(p_member_id, p_cycle_id)` (Q1 Path A) — one extra SELECT in the RPC body. When `opening_balance ≥ daily × (cycle_length − 1)`, the right-hand side is ≤ 0 and any positive new_advance is rejected (Q2bis).

6. **RPC — `commit_cycle_settlement` payout update.**
   `v_payout := daily_amount × (cycle_length − 1) − Σ(advances) − opening_balance`. Synthetic settlement transaction's amount stays `v_payout` (signed: positive = collector owes saver; negative = saver owes collector — already supported by the current settlement infrastructure per Story 7.4).

7. **RPC — `format_sms_body` saver-projected-balance update.**
   The SMS template's projected balance subtracts `opening_balance`. Existing receipt SMS templates (first_receipt, subsequent_receipt, settlement) must be reviewed line-by-line.

8. **RPC — `get_receipt_payload` projected balance update.**
   Same as #7 — the receipt URL's displayed projected balance honors `opening_balance`.

9. **NEW RPC — `restart_active_cycles_for_month(p_today date)`.**
   - SECURITY DEFINER, callable by `service_role` only (pg_cron uses service role).
   - For each member with `members.status='active'` (Q4 — paused/deleted are SKIPPED):
     - Find the most recent cycle (`active` / `with_advance` / `completed`).
     - Skip if no cycle exists (defensive — shouldn't happen but possible).
     - Mark it `status='completed'` if not already.
     - Create the next cycle:
       - `start_date = p_today` (cron passes the 1st of the current month)
       - `end_date = (derive_cycle_bounds(p_today)).end_date` — re-uses the existing cap-30 helper (Story 11.5)
       - `cycle_number = previous.cycle_number + 1`
       - `status = 'active'`
       - **No `opening_balance` column written** — Q1 Path A computes it dynamically from the previous cycle whenever needed.
     - Q3 — mid-month-onboarded members are NOT excluded; the previous (partial) cycle is closed and a new full-month cycle opens.
   - Idempotent: re-running on the same day for the same member produces no duplicate cycles (check existing cycle on `start_date`).
   - Returns: `(members_processed int, cycles_restarted int, cycles_skipped int)` for observability.

10. **pg_cron schedule.**
    `select cron.schedule('safaricash-auto-restart-cycles', '0 0 1 * *', 'select public.restart_active_cycles_for_month(current_date)');`
    Senegal is UTC+0 → 00:00 UTC = 00:00 local Africa/Dakar. Cron timezone is UTC. If we expand beyond Senegal, revisit.

11. **UI surface — opening_balance display.**
    - `MemberCard` (member list): when `currentCycle.openingBalance > 0`, append "· Report : {amount} F CFA" inline after the cycle-day line.
    - `MemberProfile`: dedicated "Solde reporté" field in the cycle stats panel.
    - i18n key: `members.card.opening_balance_inline = "Report : {amount} F CFA"`.

12. **Tests.**
    - **Vitest unit** — `cycleEngine.test.ts` extensions per AC #4.
    - **Vitest unit** — pure function tests for the `restart_active_cycles_for_month` helper (extracted as a JS function if reasonable, or covered via Deno contract).
    - **Deno contract** — `restart-active-cycles-for-month.contract.test.ts`:
      - Seed collector + 3 members with mixed cycle states + advances.
      - Call RPC.
      - Assert: previous cycles `status='completed'`, new cycles created with correct `opening_balance` + `start_date='today'` + `end_date` per cap-30.
      - Idempotency: call twice → same result.
    - **Property test** — INV-9 (cycle bounds derivation) still holds for restarted cycles.
    - **Playwright E2E** — flow-12-auto-restart spec (skipped if pg_cron not testable locally; covered by Deno contract).
    - Coverage gate: branches ≥ 75%.

## Math model — current vs. amended

### Current (post Epic 11 / Story 11.5)

```
contributionDays = cycleLength − 1               (INV-4 commission day excluded)
projectedFinalBalance = dailyAmount × contributionDays − Σ(advances)
capacity              = dailyAmount × contributionDays            (INV-3)
settlementPayout      = dailyAmount × contributionDays − Σ(advances)
```

### Amended (Story 12.3 — Q1 Path A: dynamic opening_balance)

```
opening_balance(cycle) =
  IF cycle is FIRST cycle → 0
  ELSE
    prev_cycle = cycle.previous (cycle_number − 1, same member)
    IF prev_cycle.status = 'settled' → 0
    ELSE
      prev_final_balance = daily × (cycleLength(prev_cycle) − 1)
                           − Σ(prev_cycle.advances excluding undone)
                           − opening_balance(prev_cycle)
      IF prev_final_balance >= 0 → 0     (no debt to carry)
      ELSE → −prev_final_balance         (positive carry-over)

projectedFinalBalance(cycle) = daily × contribDays
                               − Σ(cycle.advances)
                               − opening_balance(cycle)

capacity(cycle)              = daily × contribDays − opening_balance(cycle)

settlementPayout(cycle)      = daily × contribDays
                               − Σ(cycle.advances)
                               − opening_balance(cycle)
```

- **Recursion** is bounded by the chain of unsettled cycles (typically 1, sometimes 2-3, never deep in practice).
- **Settlement of a cycle** terminates the recursion: once `cycle_k.status='settled'`, the cycles after k see `opening_balance = 0` for cycle k+1 onward (the chain restarts).
- **First cycle**: no predecessor → `opening_balance = 0` always. Legacy cycles (from before this story) are unaffected.

### Q2bis enforcement in record_advance

If `opening_balance ≥ daily × contribDays`, the capacity check becomes `Σ(existing) + new ≤ 0`. Since `new > 0` (advances are positive), every advance is rejected. The RPC emits `errcode='22000'` with message `invalid_amount: cycle capacity exhausted by carry-over (opening_balance=…)`.

## Migration strategy

1. **Schema migration** (additive only). No backfill needed (default 0 = legacy-safe).
2. **Math layer** (TS + RPCs) updated to honor the new field. Legacy rows behave identically (`opening_balance=0`).
3. **Auto-restart RPC + cron** added AFTER the math layer is shipped + verified in pilot. Until then, the existing manual restart_member_cycle continues to work; cycles created manually have `opening_balance=0` (no carry-over).
4. **Optional UI** (Story 12.3 includes display; could be deferred to 12.4 if scope is too large).

## Phasing recommendation (re-confirm before code)

- **Phase A (Story 12.3)** — schema + math + RPCs + tests + a MANUAL "restart with carry-over" button. Ship + verify in pilot.
- **Phase B (Story 12.4)** — pg_cron + auto-trigger. Once Phase A is proven correct.

This split is a NFR-R3 safety measure: the math is the highest-risk change; the cron is mechanical. Reviewing them separately catches more bugs.

## Risks

- **Double-counting** if Q1 isn't resolved cleanly. Path A (dynamic) is safer; Path B (stored + trigger) is simpler. Must align before code.
- **Cap-overflow** (Q2) — a single member with a huge advance can break the model if not capped.
- **Cron drift** — if pg_cron fails one month, the restart doesn't happen. Need observability + a manual "rerun" path.
- **Existing data** — current `cycles` rows have no `opening_balance` (defaults to 0). What if a current cycle is "ending" mid-implementation? Spec assumes opening_balance=0 for any cycle created before the migration. Pilot members must be informed of the new behavior.

## Out of scope (defer)

- **Multi-currency / multi-timezone** — Senegal-only, UTC+0.
- **Variable monthly thresholds** (e.g. "restart on the 25th instead of the 1st") — fixed at the 1st for MVP.
- **Per-member opt-out of auto-restart** — global behavior only.
- **Carry-over visibility on SMS receipts** to the saver — defer to a follow-up after pilot feedback (the saver-facing SMS will need new copy explaining the report).

## Open work item before implementation

- [x] Resolve Q1 → Path A (dynamic computation)
- [x] Resolve Q2 → Option C (no cap, debt stacks) + Q2bis (record_advance blocks while in debt)
- [x] Resolve Q3 → uniform: mid-month members do participate
- [x] Resolve Q4 → paused members skipped
- [ ] Confirm Phase A / Phase B split (next step before coding)

Once all checkboxes are ticked, the AC section is locked and implementation begins.
