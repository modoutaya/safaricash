import { createClient } from "@supabase/supabase-js";

import { env } from "@/infrastructure/supabase/env";
import type { Database } from "@/infrastructure/supabase/database.types";

export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
