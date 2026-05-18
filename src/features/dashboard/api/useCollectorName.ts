// Story 4.6 follow-up — the signed-in collector's display name.
//
// Reads public.users.name for the current collector. The users_self_all
// RLS policy (migration 0002) scopes the row to auth.uid(), so a plain
// select returns only the caller's own row. Drives the dashboard
// "Bonjour {prénom}" greeting; returns null until resolved, on error,
// or when the collector has no name set — the greeting then falls back
// to a generic label.

import { useQuery } from "@tanstack/react-query";

import { useCollectorId } from "@/features/auth/api/useCollectorId";
import { supabase } from "@/infrastructure/supabase/client";

export function useCollectorName(): string | null {
  const collectorId = useCollectorId();

  const { data } = useQuery<string | null>({
    queryKey: ["collector-name", collectorId],
    enabled: collectorId !== null,
    staleTime: Infinity,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from("users")
        .select("name")
        .eq("id", collectorId as string)
        .maybeSingle();
      if (error) throw error;
      return data?.name ?? null;
    },
  });

  return data ?? null;
}
