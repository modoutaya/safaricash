// Transparent proxy to Supabase (Story 1.4 AC #2).
//
// Forwards method, path, headers, body to ${SUPABASE_PROJECT_URL}{path}
// and returns the upstream response unchanged. Strips the `host` header so
// CF auto-injects the correct one for the upstream.

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
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  return fetch(upstreamUrl, init);
}
