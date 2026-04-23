// Story 2.5 — useUpdateMember hook.
//
// TanStack mutation wrapping the SECURITY DEFINER RPC `update_member` from
// migration 0016. Mirrors useCreateMember (Story 2.2) — same in-flight ref
// guard, same error-classifier shape — with one extra error code:
// `not_found` (the row was deleted by another tab between load and save).
//
// On success the hook invalidates BOTH the member list (daily_amount shows
// on cards) AND the per-member profile read (Story 2.4 header datapoints
// depend on it). The audit `member.updated` event fires automatically via
// the audit_members trigger (migration 0007) — no manual emission.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";

import {
  MEMBERS_QUERY_KEY,
  MEMBER_PROFILE_QUERY_KEY,
  updateMemberInputSchema,
  type UpdateMemberInput,
} from "../types";

export type UpdateMemberErrorCode =
  | "unauthorized"
  | "duplicate_phone"
  | "validation"
  | "network"
  | "not_found"
  | "unknown";

export class UpdateMemberError extends Error {
  public readonly code: UpdateMemberErrorCode;
  constructor(code: UpdateMemberErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "UpdateMemberError";
  }
}

function classifyError(err: PostgrestError | { message?: string } | null): UpdateMemberErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("auth_required")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized";
  if ("code" in err && err.code === "23505") return "duplicate_phone";
  if (msg.includes("invalid_name") || msg.includes("invalid_amount")) return "validation";
  // P0002 (raised by the RPC) AND PGRST116 (PostgREST "no rows") both map to not_found.
  if (msg.includes("not_found")) return "not_found";
  if ("code" in err && (err.code === "P0002" || err.code === "PGRST116")) return "not_found";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export interface UpdateMemberArgs {
  id: string;
  values: UpdateMemberInput;
}

export type UseUpdateMemberReturn = UseMutationResult<void, UpdateMemberError, UpdateMemberArgs>;

export function useUpdateMember(): UseUpdateMemberReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<void, UpdateMemberError, UpdateMemberArgs>({
    mutationFn: async ({ id, values }): Promise<void> => {
      if (inFlightRef.current) {
        throw new UpdateMemberError("unknown", "update already in flight");
      }
      const parsed = updateMemberInputSchema.parse(values);
      inFlightRef.current = true;
      try {
        const { error } = await supabase.rpc("update_member", {
          p_id: id,
          p_name: parsed.name,
          p_phone_number: parsed.phoneNumber,
          p_daily_amount: parsed.dailyAmount,
        });
        if (error) {
          const code = classifyError(error);
          throw new UpdateMemberError(code, error.message);
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: (_void, { id }) => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, id] });
    },
  });
}
