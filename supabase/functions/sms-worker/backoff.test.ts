// Story 6.2 — backoff schedule unit tests.
//
// architecture.md:643 — "Exponential backoff 10 s → max 10 min".
// Schedule: [10s, 30s, 60s, 120s, 300s, 600s] capped at 600 for retry_count >= 5.

import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { backoffDelaySeconds } from "./backoff.ts";

Deno.test("backoff(0) === 10 — first retry waits 10s", () => {
  assertEquals(backoffDelaySeconds(0), 10);
});

Deno.test("backoff(1) === 30", () => {
  assertEquals(backoffDelaySeconds(1), 30);
});

Deno.test("backoff(2) === 60 — 1 minute", () => {
  assertEquals(backoffDelaySeconds(2), 60);
});

Deno.test("backoff(3) === 120 — 2 minutes", () => {
  assertEquals(backoffDelaySeconds(3), 120);
});

Deno.test("backoff(4) === 300 — 5 minutes", () => {
  assertEquals(backoffDelaySeconds(4), 300);
});

Deno.test("backoff(5) === 600 — 10 minutes (cap)", () => {
  assertEquals(backoffDelaySeconds(5), 600);
});

Deno.test("backoff(50) === 600 — capped, monotonic non-decreasing", () => {
  assertEquals(backoffDelaySeconds(50), 600);
});

Deno.test("backoff(-1) throws — negative count is a programming error", () => {
  assertThrows(() => backoffDelaySeconds(-1), Error, "retry_count must be >= 0");
});
