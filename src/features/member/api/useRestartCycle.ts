// Story 2.7 — useRestartCycle hook.
//
// TanStack mutation wrapping the SECURITY DEFINER RPC `restart_member_cycle`
// (migration 0018). Mirrors useUpdateMember (Story 2.5) — same in-flight
// ref guard, same error-classifier shape — with one extra error code:
// `not_restartable` (the cycle status changed server-side between the user
// opening the profile and tapping Confirm — a race the advisory lock makes
// observable).
//
// On success the hook invalidates BOTH the member list (displayStatus may
// flip back to 'actif') AND the per-member profile read (currentCycle +
// previousCycles both change). The audit `cycle.started` event fires
// automatically via the audit_cycles trigger (migration 0007 + the actor
// JWT fix from migration 0017) — no manual emission.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";

import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "../types";

export type RestartCycleErrorCode =
  | "unauthorized"
  | "not_restartable"
  | "not_found"
  | "network"
  | "unknown";

export class RestartCycleError extends Error {
  public readonly code: RestartCycleErrorCode;
  constructor(code: RestartCycleErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "RestartCycleError";
  }
}

function classifyError(err: PostgrestError | { message?: string } | null): RestartCycleErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  if (msg.includes("not_restartable")) return "not_restartable";
  if ("code" in err && err.code === "22000") return "not_restartable";
  if (msg.includes("not_found")) return "not_found";
  if ("code" in err && (err.code === "P0002" || err.code === "PGRST116")) return "not_found";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export type UseRestartCycleReturn = UseMutationResult<string, RestartCycleError, string>;

export function useRestartCycle(): UseRestartCycleReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<string, RestartCycleError, string>({
    mutationFn: async (memberId): Promise<string> => {
      if (inFlightRef.current) {
        throw new RestartCycleError("unknown", "restart already in flight");
      }
      inFlightRef.current = true;
      try {
        const { data, error } = await supabase.rpc("restart_member_cycle", {
          p_member_id: memberId,
        });
        if (error) {
          const code = classifyError(error);
          throw new RestartCycleError(code, error.message);
        }
        if (typeof data !== "string") {
          throw new RestartCycleError("unknown", "RPC returned no cycle id");
        }
        return data;
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: (_newCycleId, memberId) => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] });
    },
  });
}
