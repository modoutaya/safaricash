// Story 2.4 — kind → lucide icon component lookup.
import { ArrowDownToLine, CheckCircle2, Coins, RotateCcw, type LucideIcon } from "lucide-react";

import type { TransactionKind } from "../types";

const ICONS: Record<TransactionKind, LucideIcon> = {
  contribution: ArrowDownToLine,
  rattrapage: RotateCcw,
  advance: Coins,
  // HOTFIX 2026-05-22 — 'settlement' added so the kind enum is exhaustive
  // (otherwise transactionIcon throws for settlement rows when they
  // surface in the profile history list).
  settlement: CheckCircle2,
};

export function transactionIcon(kind: TransactionKind): LucideIcon {
  return ICONS[kind];
}
