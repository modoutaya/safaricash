// KV-backed sliding-window-by-minute counter (Story 1.4 AC #4).
//
// Bucket key shape: `rl:{collectorId}:{ISO8601 minute}`.
// TTL 90s = 60s window + 30s clock-skew margin. Each request: read current
// count for the bucket, increment, write back. The increment is NOT atomic
// across CF edge POPs — Workers KV writes are eventually consistent
// (~60s global propagation). Documented trade-off in the story spec; at
// MVP scale (≤10 collectors per the free-tier cap, see workers/rate-limit/
// README §Trade-offs) the burst-bypass exposure is bounded by the same
// 100/min cap once consistency converges. Migration path to Cloudflare
// Durable Objects (strong consistency, $5/mo Workers Paid plan) documented
// in deferred-work.md if the MVP needs to grow past the cap.

const KV_TTL_SECONDS = 90;

export type CheckResult = {
  /** True if the request is within the per-minute cap. */
  allowed: boolean;
  /** Count AFTER the (attempted) increment, including the current request. */
  count: number;
  /** Seconds until the current bucket rolls over (1..60). */
  bucketSecondsRemaining: number;
  /** Bucket minute string (for logging — collector_id is logged separately). */
  bucketMinute: string;
};

function bucketMinuteIso(now: Date): string {
  // Truncate to minute: 2026-04-19T10:23 (no seconds). Stable across CF POPs.
  // iso = 2026-04-19T10:23:45.123Z → 2026-04-19T10:23
  return now.toISOString().slice(0, 16);
}

function bucketKey(collectorId: string, minute: string): string {
  return `rl:${collectorId}:${minute}`;
}

/**
 * Best-effort (eventual-consistency caveat) increment of the per-(collector,
 * minute) counter and check against `threshold`. Returns whether the request
 * should proceed plus diagnostics.
 *
 * Failure mode: if KV throws (rare — degraded CF region OR daily write quota
 * exceeded), the caller MUST fail open per Story 1.4 AC anti-pattern guidance.
 * This function does not catch — it propagates so the handler can decide.
 */
export async function incrementAndCheck(
  kv: KVNamespace,
  collectorId: string,
  threshold: number,
  now: Date,
): Promise<CheckResult> {
  const minute = bucketMinuteIso(now);
  const key = bucketKey(collectorId, minute);

  const current = await kv.get(key);
  const previousCount = current === null ? 0 : Number.parseInt(current, 10);
  const safePrevious = Number.isFinite(previousCount) && previousCount >= 0 ? previousCount : 0;
  const nextCount = safePrevious + 1;

  // Await the write so the handler doesn't return before the increment lands.
  // Workers' subrequest budget allows this.
  await kv.put(key, String(nextCount), { expirationTtl: KV_TTL_SECONDS });

  const seconds = now.getUTCSeconds();
  const bucketSecondsRemaining = 60 - seconds;

  return {
    allowed: nextCount <= threshold,
    count: nextCount,
    bucketSecondsRemaining: Math.max(1, bucketSecondsRemaining),
    bucketMinute: minute,
  };
}
