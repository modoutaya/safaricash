import { createClient } from "@supabase/supabase-js";

import { env } from "@/infrastructure/supabase/env";
import type { Database } from "@/infrastructure/supabase/database.types";

// Story 1.4 — when the rate-limit Worker gateway URL is set, reroute all
// /functions/v1/* calls through it. The worker proxies to Supabase after
// enforcing per-collector rate limits. Other Supabase surfaces (auth,
// PostgREST CRUD, realtime) continue to hit Supabase directly — Supabase
// Pro's native rate-limiting covers those per architecture.md line 349.
//
// URL normalisation: both URLs have any trailing slash stripped before the
// startsWith check. Without this, a trailing-slash mismatch (one ends with
// "/", the other doesn't) would silently bypass the worker — the rate
// limit becomes non-functional and the bug is invisible until a security
// review notices.
const supabaseUrl = env.VITE_SUPABASE_URL.replace(/\/$/, "");
const gatewayUrl = env.VITE_SUPABASE_FUNCTIONS_GATEWAY_URL?.replace(/\/$/, "");
const functionsPrefix = `${supabaseUrl}/functions/v1/`;

const gatewayRouter: typeof fetch | undefined = gatewayUrl
  ? async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // Only intercept Edge Function calls — leave auth/REST/realtime alone.
      if (url.startsWith(functionsPrefix)) {
        // slice(prefix.length) is safer than replace(): replace() against
        // a URL that happens to contain the prefix substring twice would
        // double-rewrite. slice() rewrites exactly the leading prefix.
        const rerouted = `${gatewayUrl}/functions/v1/${url.slice(functionsPrefix.length)}`;
        return fetch(rerouted, init);
      }
      return fetch(input, init);
    }
  : undefined;

export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  ...(gatewayRouter ? { global: { fetch: gatewayRouter } } : {}),
});
