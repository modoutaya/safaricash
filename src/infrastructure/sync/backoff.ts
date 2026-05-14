// Story 8.4 — exponential backoff schedule for the reconciler's
// auto-retry timer.
//
// Mirror of the SMS-worker backoff (Story 6.2 — supabase/functions/
// sms-worker/backoff.ts) but in TypeScript for the browser-side
// reconciler. Same curve: 10s → 30s → 60s → 120s → 300s → 600s cap.
// Architecture.md:643 documents the SMS-worker schedule; this story
// reuses the shape so retry telemetry is consistent across surfaces.
//
// attempt is the value BEFORE incrementing — i.e., computeBackoffMs(0)
// is the delay between the first failed attempt and the first retry.

const SCHEDULE_SECONDS: ReadonlyArray<number> = [10, 30, 60, 120, 300, 600];
const CAP_SECONDS = SCHEDULE_SECONDS[SCHEDULE_SECONDS.length - 1] ?? 600;

export function computeBackoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`computeBackoffMs: attempt must be a non-negative integer (got ${attempt})`);
  }
  const seconds = SCHEDULE_SECONDS[attempt] ?? CAP_SECONDS;
  return seconds * 1_000;
}
