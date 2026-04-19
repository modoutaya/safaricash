import { createClient } from "@supabase/supabase-js";

import { env } from "@/infrastructure/supabase/env";
import type { Database } from "@/infrastructure/supabase/database.types";

// Story 1.4 — when the rate-limit Worker gateway URL is set, reroute all
// /functions/v1/* calls through it. The worker proxies to Supabase after
// enforcing per-collector rate limits. Other Supabase surfaces (auth,
// PostgREST CRUD, realtime) continue to hit Supabase directly — Supabase
// Pro's native rate-limiting covers those per architecture.md line 349.
const gatewayUrl = env.VITE_SUPABASE_FUNCTIONS_GATEWAY_URL?.trim();
const gatewayRouter: typeof fetch | undefined = gatewayUrl
  ? async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // Only intercept Edge Function calls — leave auth/REST/realtime alone.
      if (url.startsWith(`${env.VITE_SUPABASE_URL}/functions/v1/`)) {
        const rerouted = url.replace(env.VITE_SUPABASE_URL, gatewayUrl.replace(/\/$/, ""));
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
