// Story 2.1 — public barrel for the cycle feature. Extended by Epic 3
// with the pure domain engine + hooks.
export { CycleProgressBar } from "./ui/CycleProgressBar";
export type { CycleProgressBarProps } from "./ui/CycleProgressBar";

// Story 3.5 / FR20 — dashboard cycles-ending alert.
export { CycleEndingAlert } from "./ui/CycleEndingAlert";
export {
  useCyclesEndingAlert,
  CYCLE_ENDING_ALERT_DISMISS_KEY,
  type UseCyclesEndingAlertResult,
} from "./api/useCyclesEndingAlert";
export { selectMembersWithCycleEndingSoon } from "./api/selectMembersWithCycleEndingSoon";
