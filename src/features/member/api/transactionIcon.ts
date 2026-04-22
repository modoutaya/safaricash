// Story 2.4 — kind → lucide icon component lookup.
import { ArrowDownToLine, Coins, RotateCcw, type LucideIcon } from "lucide-react";

import type { TransactionKind } from "../types";

const ICONS: Record<TransactionKind, LucideIcon> = {
  contribution: ArrowDownToLine,
  rattrapage: RotateCcw,
  advance: Coins,
};

export function transactionIcon(kind: TransactionKind): LucideIcon {
  return ICONS[kind];
}
