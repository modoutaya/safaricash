// Story 5.1 / FR24 — pure presentation component for the advance simulation.
//
// 4-row card driven by Story 3.2's cycle-engine primitives. Computes the
// state once at the top (empty / valid / over-limit) and renders three
// branches off it. No internal state, no hooks, no side effects — every
// output derives synchronously from props.
//
// See: epics.md:888-903 (Story 5.1 BDD), prd.md (FR24),
// ux-design-specification.md:1033-1061 (component anatomy + states),
// ux-design-specification.md:509-510 (warning + destructive palettes),
// docs/ADR/004-cycle-invariants.md (INV-1 — projection independent of cycleDay).

import { canAcceptAdvance, commission } from "@/domain/cycle";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

export interface AdvanceSimulationPanelProps {
  /** FCFA integer; expected positive. */
  dailyAmount: number;
  /** FCFA integers; each positive. Empty array = no prior advances. */
  existingAdvances: ReadonlyArray<number>;
  /** FCFA integer. 0 when the input is empty (caller normalises). */
  candidateAmount: number;
  /** Inclusive day count of the member's current cycle (Story 11.2 —
   *  variable length). Drives both the row-1 projected total AND the
   *  capacity cap (2026-06-19 — projected-monthly-contribution rule). */
  cycleLength: number;
  /** Story 12.3 — carry-over of unpaid debt from the previous unsettled
   *  cycle. Defaults to 0 for backward compatibility. Subtracted from
   *  both the capacity cap and the projected-balance display. */
  openingBalance?: number;
  /** Caller-side spacing/sizing tweaks. */
  className?: string;
}

type SimulationState = "empty" | "valid" | "over-limit";

function deriveState(
  dailyAmount: number,
  cycleLength: number,
  existingAdvances: ReadonlyArray<number>,
  candidateAmount: number,
  openingBalance: number,
): SimulationState {
  if (candidateAmount === 0) return "empty";
  // 2026-06-19 — capacity = projected monthly contribution
  // (dailyAmount × cycleLength) − advances − carry-over. The candidate is
  // over-limit once it exceeds what the saver is planned to cotise.
  return canAcceptAdvance(
    dailyAmount,
    cycleLength,
    existingAdvances,
    candidateAmount,
    openingBalance,
  )
    ? "valid"
    : "over-limit";
}

function sumAdvances(existingAdvances: ReadonlyArray<number>, candidateAmount: number): number {
  let total = candidateAmount;
  for (const a of existingAdvances) total += a;
  return total;
}

export function AdvanceSimulationPanel({
  dailyAmount,
  existingAdvances,
  candidateAmount,
  cycleLength,
  openingBalance = 0,
  className,
}: AdvanceSimulationPanelProps): JSX.Element {
  const t = useT();
  const state = deriveState(
    dailyAmount,
    cycleLength,
    existingAdvances,
    candidateAmount,
    openingBalance,
  );

  const totalProjected = dailyAmount * cycleLength;
  const commissionAmount = commission(dailyAmount);
  // 2026-06-19 — projected final balance = projected total minus the
  // (flat 1-day) commission, all advances and any carry-over. Consistent
  // with the displayed rows (projected − commission − advance) and with
  // the projected-monthly-contribution cap. Clamped at 0: the saver-facing
  // amount can't be < 0 (borrowing the full projection silently absorbs
  // the commission, which then carries over as next cycle's opening_balance).
  const finalRaw =
    totalProjected -
    commissionAmount -
    sumAdvances(existingAdvances, candidateAmount) -
    openingBalance;
  const finalBalance = Math.max(0, finalRaw);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border-2 border-primary-500 bg-gradient-to-br from-primary-100 to-primary-50 p-5",
        className,
      )}
      data-state={state}
    >
      <p className="text-body-2 font-semibold text-primary-700">{t("advance.simulation.title")}</p>

      {/* Row 1 — Total cycle projected. */}
      <div className="flex items-baseline justify-between">
        <span className="text-body-2 text-text-secondary">{t("advance.simulation.row_total")}</span>
        <span
          className="text-body-1 text-text-primary"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatFcfaAmount(totalProjected)} FCFA
        </span>
      </div>

      {/* Row 2 — Commission (subtraction). */}
      <div className="flex items-baseline justify-between">
        <span className="text-body-2 text-text-secondary">
          {t("advance.simulation.row_commission")}
        </span>
        <span
          className="text-body-1 text-text-primary"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          − {formatFcfaAmount(commissionAmount)} FCFA
        </span>
      </div>

      {/* Row 3 — Advance candidate (destructive when valid; warning when over-limit). */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span
            className={cn(
              "text-body-2",
              state === "over-limit" ? "text-warning-text" : "text-text-secondary",
            )}
          >
            {t("advance.simulation.row_advance")}
          </span>
          <span
            className={cn(
              "text-body-1",
              state === "empty"
                ? "text-text-tertiary"
                : state === "over-limit"
                  ? "text-warning-text"
                  : "text-destructive",
            )}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {state === "empty"
              ? t("advance.simulation.amount_placeholder")
              : `− ${formatFcfaAmount(candidateAmount)} FCFA`}
          </span>
        </div>
        {state === "over-limit" ? (
          <p className="text-body-2 text-warning-text">{t("advance.simulation.over_limit_row")}</p>
        ) : null}
      </div>

      {/* Row 4 — Projected final balance (large + primary green; aria-live for SR). */}
      <div
        aria-live="polite"
        className={cn(
          "mt-1 flex flex-col gap-1 border-t border-primary-100 pt-2",
          state === "empty" ? "opacity-50" : null,
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-body-1 font-semibold",
              state === "empty" ? "text-text-secondary" : "text-text-primary",
            )}
          >
            {t("advance.simulation.row_final_balance")}
          </span>
          <span
            className={cn(
              "shrink-0 text-amount-large",
              state === "empty"
                ? "text-text-secondary"
                : state === "over-limit"
                  ? "text-text-primary"
                  : "text-primary",
            )}
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {formatFcfaAmount(finalBalance)} FCFA
          </span>
        </div>
        {state === "over-limit" ? (
          <p className="text-body-2 text-warning-text">{t("advance.simulation.over_limit_note")}</p>
        ) : null}
      </div>
    </div>
  );
}
