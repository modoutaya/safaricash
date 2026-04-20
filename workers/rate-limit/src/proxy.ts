// Transparent proxy to Supabase (Story 1.4 AC #2).
//
// Forwards method, path, headers, body to ${SUPABASE_PROJECT_URL}{path}
// and returns the upstream response unchanged. Strips the `host` header so
// CF auto-injects the correct one for the upstream.

/** Hard cap on upstream response time. Worker stays responsive even if
 * Supabase hangs (e.g., under regional outage). 504 surfaces as RFC 7807. */
const PROXY_TIMEOUT_MS = 10_000;

export async function proxyToSupabase(
  request: Request,
  supabaseProjectUrl: string,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  // Forward path + query — drop the worker's own host.
  const upstreamUrl = `${supabaseProjectUrl.replace(/\/$/, "")}${incomingUrl.pathname}${incomingUrl.search}`;

  // Clone headers, strip host (CF will set the right one).
  const headers = new Headers(request.headers);
  headers.delete("host");

  // Don't try to be clever with the body — re-construct via Request to let
  // the runtime handle streaming + content-length.
  const init: RequestInit = {
    method: request.method,
    headers,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    return await fetch(upstreamUrl, init);
  } catch (err) {
    // AbortError → 504 Gateway Timeout RFC 7807 (do not leak stack to client).
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") {
      return new Response(
        JSON.stringify({
          type: "https://safaricash.app/problems/upstream/timeout",
          title: "Upstream timed out",
          status: 504,
          detail: `Supabase did not respond within ${PROXY_TIMEOUT_MS}ms.`,
        }),
        {
          status: 504,
          headers: {
            "Content-Type": "application/problem+json",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    throw err;
  }
}
