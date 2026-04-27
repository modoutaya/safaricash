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

import {
  CYCLE_TOTAL_DAYS,
  canAcceptAdvance,
  commission,
  computeProjectedFinalBalance,
} from "@/domain/cycle";
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
  /** Caller-side spacing/sizing tweaks. */
  className?: string;
}

type SimulationState = "empty" | "valid" | "over-limit";

function deriveState(
  dailyAmount: number,
  existingAdvances: ReadonlyArray<number>,
  candidateAmount: number,
): SimulationState {
  if (candidateAmount === 0) return "empty";
  return canAcceptAdvance(dailyAmount, existingAdvances, candidateAmount) ? "valid" : "over-limit";
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
  className,
}: AdvanceSimulationPanelProps): JSX.Element {
  const t = useT();
  const state = deriveState(dailyAmount, existingAdvances, candidateAmount);

  const totalProjected = dailyAmount * CYCLE_TOTAL_DAYS;
  const commissionAmount = commission(dailyAmount);
  // Projected final balance = engine's raw value, except clamped to 0
  // for the over-limit display (BDD line 903 — "row 4 shows 0 FCFA").
  const projectedRaw = computeProjectedFinalBalance(
    dailyAmount,
    sumAdvances(existingAdvances, candidateAmount),
  );
  const finalBalance = state === "over-limit" ? 0 : projectedRaw;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-primary-200 bg-card p-4",
        className,
      )}
      data-state={state}
    >
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
              "text-body-1 font-semibold",
              state === "empty" ? "text-text-secondary" : "text-text-primary",
            )}
          >
            {t("advance.simulation.row_final_balance")}
          </span>
          <span
            className={cn(
              "text-amount-large",
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
