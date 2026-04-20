// RFC 7807 Problem Details for the rate-limit Worker.
//
// Mirrors the SHAPE of supabase/functions/_shared/rfc7807.ts (Story 1.3) so
// consumer UIs can switch on `type` uniformly. Code is duplicated — Worker
// runtime cannot import from Deno Edge Function code.
//
// architecture.md mandates RFC 7807 for all custom-edge 4xx/5xx responses
// (lines 356, 543, 627). The 429 inherits this contract.

const PROBLEM_BASE = "https://safaricash.app/problems";

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
};

/**
 * Build a 429 RFC 7807 response with `Retry-After` standard header.
 * `retryAfterSeconds` populates BOTH the header (for HTTP clients) AND the
 * `retry_after_seconds` extension field (for SafariCash consumer UIs that
 * want to render a localised countdown).
 *
 * `instance` MUST be a pathname (no query string) — caller is responsible
 * for stripping query to avoid leaking tokens (signed URLs, OAuth codes,
 * etc.) in echoed error responses.
 */
export function rateLimitedResponse(retryAfterSeconds: number, instance: string): Response {
  const body: ProblemBody = {
    type: `${PROBLEM_BASE}/ratelimit/exceeded`,
    title: "Too many requests",
    status: 429,
    detail: `Rate limit of 100 req/min exceeded. Retry in ${retryAfterSeconds} seconds.`,
    instance,
    retry_after_seconds: retryAfterSeconds,
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/problem+json",
      "Retry-After": String(retryAfterSeconds),
      // Without no-store, CDN/browser may cache 429 → users locked out
      // beyond intended bucket.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // Echo CORS so the browser doesn't swallow the body in cross-origin
      // contexts (consumer UIs need to read retry_after_seconds).
      "Access-Control-Allow-Origin": "*",
    },
  });
}
