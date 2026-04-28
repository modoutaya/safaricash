// Story 6.2 — pure exponential backoff schedule for the sms-worker retries.
//
// Schedule (architecture.md:643): 10s → 30s → 60s → 120s → 300s → 600s cap.
// retry_count is the value BEFORE incrementing — i.e., backoff(0) is the
// delay between the first failed attempt and the first retry.

const SCHEDULE_SECONDS: ReadonlyArray<number> = [10, 30, 60, 120, 300, 600];
const CAP_SECONDS = SCHEDULE_SECONDS[SCHEDULE_SECONDS.length - 1] ?? 600;

export function backoffDelaySeconds(retryCount: number): number {
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error(`backoffDelaySeconds: retry_count must be >= 0 (got ${retryCount})`);
  }
  return SCHEDULE_SECONDS[retryCount] ?? CAP_SECONDS;
}
