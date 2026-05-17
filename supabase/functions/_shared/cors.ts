// Shared CORS for browser-invoked Edge Functions.
//
// re-auth, cycle-settlement and sms-resend-history are called from the
// React PWA via `supabase.functions.invoke`. When the app is served from
// a different origin than the Supabase project (e.g. the deployed PWA on
// netlify.app vs. *.supabase.co), the browser issues a CORS preflight and
// blocks the call unless the function answers OPTIONS and echoes the
// Access-Control-* headers on every response. Server-to-server callers
// (cron, pg_net, webhooks) never hit this — so CORS is opt-in per
// function via `withCors`, not applied globally.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Wraps an Edge Function handler: answers the OPTIONS preflight with 204
 *  and merges the CORS headers into every response the handler returns. */
export function withCors(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const res = await handler(req);
    for (const [key, value] of Object.entries(corsHeaders)) {
      res.headers.set(key, value);
    }
    return res;
  };
}
