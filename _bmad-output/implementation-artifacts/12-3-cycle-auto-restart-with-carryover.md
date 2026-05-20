# Story 12.3: Cycle auto-restart on the 1st of each month + advance carry-over

Status: draft (spec only — pre-implementation review required)

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

## Open product questions (need user input BEFORE implementation)

### Q1 — Opening balance and settlement interaction (CRITICAL)

The carry-over creates a double-counting risk. Concrete trace:

> Previous cycle: contributions=10×500=5000, advances=7000.
> Final balance = 5000 − 7000 − 500(commission) = **−2500** (saver owes collector 2500).
> Auto-restart on 1st → new cycle's `opening_balance = 2500`.
> New cycle's projected payout = 500×29 − 0 − **2500** = 12 000 (was 14 000 without carry-over).
>
> Later, collector manually settles the previous cycle: saver pays back 2500 F CFA cash → settlement transaction records this.
> Previous cycle is now "settled" (balance=0).
>
> But new cycle's `opening_balance` is still 2500 → new cycle projected payout still subtracts 2500 → **saver is charged twice for the same debt**.

Two viable paths to resolve:

**Path A — Dynamic computation (no stored opening_balance)**
- `opening_balance` is **computed at query time** as `previous_cycle.unpaid_balance IF previous_cycle.status IN ('completed', 'active', 'with_advance') ELSE 0`. Once previous cycle is `settled`, opening_balance for the next cycle becomes 0.
- ✅ No double-counting by construction.
- ❌ Every projected-balance computation requires joining the previous cycle row.
- ❌ Adds an SQL JOIN in every RPC that touches cycle math (record_advance, commit_cycle_settlement, format_sms_body, get_receipt_payload).

**Path B — Stored opening_balance, cleared on previous-cycle settlement**
- Add `cycles.opening_balance int default 0` column. Set at restart-time. Cleared via trigger when previous cycle flips to `settled`.
- ✅ Simple read path (no JOIN).
- ❌ Adds a trigger; harder to audit; settlement RPC must know "which cycle is the next one".
- ❌ Existing cycles (legacy data) don't get a backfill — but opening_balance defaults to 0, so they stay correct.

**Recommendation**: Path B is simpler operationally but adds a trigger. Path A is purer but slower. **Need user direction before implementation.**

### Q2 — What if `opening_balance > daily × contributionDays`?

If a saver had a huge advance + few contributions in cycle N, their carry-over could exceed the new cycle's max possible payout. In that case:
- The new cycle's projected balance is **negative even with full contributions**.
- `record_advance` capacity check would reject any new advance.
- `commit_cycle_settlement` payout could be negative (collector should collect from saver, not pay them).

Options:
- **A**: Block auto-restart for that member; require manual handling.
- **B**: Cap carry-over at `daily × contributionDays`; the excess is "forgiven" (recorded as an audit event).
- **C**: Allow negative projected balance; the saver pays the collector at end of cycle to clear it.

**Recommendation**: B (cap with audit) for safety. Excess is rare and should be flagged for operator review.

### Q3 — Members whose first cycle is mid-month — do they participate in the 1st-of-month restart?

A member added on May 15 has cycle May 15-30 (cap-30, length 16). On June 1, do we restart them too?

**Recommendation**: Yes — uniform behavior. June 1 → close May 15-30 cycle (status='completed'), open June 1-30 cycle (length 30). This means a saver added mid-month has one "partial" cycle, then full months thereafter.

### Q4 — Members on `paused` status?

`paused` means the collector temporarily disabled the member. Should they get a new cycle on the 1st?

**Recommendation**: No — skip `paused`. Only `active` members participate in auto-restart. When they're un-paused, a manual restart is required (existing Story 2.7 flow).

## Acceptance Criteria

> The 12 ACs below are the FROZEN contract for the implementation PR. The 4 open questions (Q1-Q4) above must be resolved before this section is locked.

1. **Schema migration — `cycles.opening_balance`.**
   New column `opening_balance int not null default 0` on `public.cycles`. CHECK constraint: `opening_balance >= 0` (carry-over is always positive — the COLLECTOR is owed). Default 0 keeps legacy rows valid without backfill (per ADR-004 A1.7 legacy-compat principle).

2. **Schema migration — update `cycles_decrypted` view.**
   Per memory `project_views_after_columns`: explicit projection views are NOT auto-extended when new columns appear on the underlying table. The view must be re-issued to include `opening_balance`.

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
   The cycle row's `opening_balance` is read alongside `start_date`/`end_date` in the existing SELECT (no new round-trip).

6. **RPC — `commit_cycle_settlement` payout update.**
   `v_payout := daily_amount × (cycle_length − 1) − Σ(advances) − opening_balance`. Synthetic settlement transaction's amount stays `v_payout` (signed: positive = collector owes saver; negative = saver owes collector — already supported by the current settlement infrastructure per Story 7.4).

7. **RPC — `format_sms_body` saver-projected-balance update.**
   The SMS template's projected balance subtracts `opening_balance`. Existing receipt SMS templates (first_receipt, subsequent_receipt, settlement) must be reviewed line-by-line.

8. **RPC — `get_receipt_payload` projected balance update.**
   Same as #7 — the receipt URL's displayed projected balance honors `opening_balance`.

9. **NEW RPC — `restart_active_cycles_for_month(p_today date)`.**
   - SECURITY DEFINER, callable by `service_role` only (pg_cron uses service role).
   - For each member with `members.status='active'`:
     - Find the most recent cycle (`active` / `with_advance` / `completed`).
     - Skip if no cycle exists (defensive — shouldn't happen but possible).
     - Mark it `status='completed'` if not already.
     - Compute the unpaid balance: `daily × (cycle_length − 1) − Σ(contributions excluding undone) − Σ(rattrapages excluding undone) + Σ(advances excluding undone)`.
       Wait — that math is wrong. Let me redo:
       `unpaid = Σ(advances) − Σ(contributions) − Σ(rattrapages) − daily × 0 (commission accounted via final balance)`.
       Actually: cycle's final balance = `daily × contribDays − Σ(advances) − previous opening_balance`. The "unpaid" is `max(0, −final_balance)` = how much the saver still owes.
       Cleanest formula: `unpaid = max(0, Σ(advances) + previous_opening_balance − Σ(actual_contributions_value))`.
       Where `Σ(actual_contributions_value) = (Σ contributions kind + Σ rattrapage daily-equivalents) excluding undone`.
     - Cap carry-over at `daily × (cycle_length − 1)` if Q2 = option B.
     - Create new cycle:
       - `start_date = p_today` (must be 1st of month)
       - `end_date = LEAST(last day of month, day 30)` — re-using `derive_cycle_bounds(p_today)`
       - `opening_balance = unpaid` (capped per Q2)
       - `cycle_number = previous.cycle_number + 1`
       - `status = 'active'`
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

### Amended (Story 12.3)

```
projectedFinalBalance = dailyAmount × contributionDays − Σ(advances) − opening_balance
capacity              = dailyAmount × contributionDays − opening_balance
settlementPayout      = dailyAmount × contributionDays − Σ(advances) − opening_balance
```

`opening_balance` defaults to 0 → legacy cycles are mathematically unchanged. New cycles created by auto-restart get a non-zero `opening_balance` IFF the previous cycle ended with an unpaid debt.

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

- [ ] Resolve Q1 (Path A vs Path B) with user
- [ ] Resolve Q2 (cap policy) with user
- [ ] Confirm Q3 (mid-month members auto-restart) with user
- [ ] Confirm Q4 (paused members skipped) with user
- [ ] Confirm Phase A / Phase B split

Once all checkboxes are ticked, the AC section is locked and implementation begins.
