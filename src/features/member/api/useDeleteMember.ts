// Story 2.6 — useDeleteMember hook.
//
// TanStack mutation wrapping the SECURITY DEFINER RPC `delete_member`
// (migration 0019). DOES NOT call the re-auth Edge Function — that's the
// dialog's responsibility. The hook only handles the post-re-auth RPC
// call, so a wrong-password attempt never burns a delete RPC roundtrip.
//
// On success the hook invalidates MEMBERS_QUERY_KEY (the list — the
// member is gone) AND removes the per-profile cache entry (the profile
// no longer exists; route navigates away).

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";

import { MEMBERS_QUERY_KEY, MEMBER_PROFILE_QUERY_KEY } from "../types";

export type DeleteMemberErrorCode = "unauthorized" | "not_found" | "network" | "unknown";

export class DeleteMemberError extends Error {
  public readonly code: DeleteMemberErrorCode;
  constructor(code: DeleteMemberErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DeleteMemberError";
  }
}

function classifyError(err: PostgrestError | { message?: string } | null): DeleteMemberErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required") || msg.includes("unauthorized")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  if (msg.includes("not_found")) return "not_found";
  if ("code" in err && (err.code === "P0002" || err.code === "PGRST116")) return "not_found";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export type UseDeleteMemberReturn = UseMutationResult<void, DeleteMemberError, string>;

export function useDeleteMember(): UseDeleteMemberReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<void, DeleteMemberError, string>({
    mutationFn: async (memberId): Promise<void> => {
      if (inFlightRef.current) {
        throw new DeleteMemberError("unknown", "delete already in flight");
      }
      inFlightRef.current = true;
      try {
        const { error } = await supabase.rpc("delete_member", { p_id: memberId });
        if (error) {
          const code = classifyError(error);
          throw new DeleteMemberError(code, error.message);
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: (_void, memberId) => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      // Profile no longer exists — drop the cache entry entirely so a
      // stale entry can't render after the user navigates back via history.
      queryClient.removeQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, memberId] });
    },
  });
}
