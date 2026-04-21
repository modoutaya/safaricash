// Story 2.2 — useCreateMember hook.
//
// TanStack mutation wrapping the SECURITY DEFINER RPC
// `create_member_with_cycle(name, phone, daily_amount)`. The RPC inserts
// the member + day-1 cycle in a single transaction (migration 0014), so
// the client never has to orchestrate atomicity. Audit event
// `member.created` fires automatically via the trigger from migration 0007.
//
// Error mapping translates PostgREST + RPC failure modes to typed codes
// the form layer can render via `members.create.error.*` i18n keys.

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { supabase } from "@/infrastructure/supabase/client";

import { MEMBERS_QUERY_KEY, createMemberInputSchema, type CreateMemberInput } from "../types";

export type CreateMemberErrorCode =
  | "unauthorized"
  | "duplicate_phone"
  | "validation"
  | "network"
  | "unknown";

export class CreateMemberError extends Error {
  public readonly code: CreateMemberErrorCode;
  constructor(code: CreateMemberErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CreateMemberError";
  }
}

/** Map a PostgREST / network failure to a translatable code. The PostgREST
 *  client surfaces RPC-thrown exceptions as `{ message, code, details }`. */
function classifyError(err: PostgrestError | { message?: string } | null): CreateMemberErrorCode {
  if (!err) return "unknown";
  const msg = (err.message ?? "").toLowerCase();
  // RLS / SECURITY DEFINER auth check failure (migration 0014: 28000).
  if (msg.includes("auth_required")) return "unauthorized";
  if ("code" in err && err.code === "42501") return "unauthorized"; // insufficient_privilege
  // Reserved for the day a unique constraint on phone lands.
  if ("code" in err && err.code === "23505") return "duplicate_phone";
  // Migration 0014 raises 22000 for invalid_name / invalid_amount — the
  // client + Zod gate against this, but defense-in-depth.
  if (msg.includes("invalid_name") || msg.includes("invalid_amount")) return "validation";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export type UseCreateMemberReturn = UseMutationResult<string, CreateMemberError, CreateMemberInput>;

export function useCreateMember(): UseCreateMemberReturn {
  const queryClient = useQueryClient();
  // Synchronous re-entrancy guard — mirrors useLogin (Story 1.5b). React
  // commits `isPending` after the mutation resolves; without this guard a
  // double-tap on the submit button enqueues two RPC calls.
  const inFlightRef = useRef(false);

  return useMutation<string, CreateMemberError, CreateMemberInput>({
    mutationFn: async (rawInput): Promise<string> => {
      if (inFlightRef.current) {
        throw new CreateMemberError("unknown", "create already in flight");
      }
      // Defense-in-depth re-parse — RHF already validates, but this catches
      // a programmatic caller that bypasses the form.
      const parsed = createMemberInputSchema.parse(rawInput);
      inFlightRef.current = true;
      try {
        const { data, error } = await supabase.rpc("create_member_with_cycle", {
          p_name: parsed.name,
          p_phone_number: parsed.phoneNumber,
          p_daily_amount: parsed.dailyAmount,
        });
        if (error) {
          const code = classifyError(error);
          throw new CreateMemberError(code, error.message);
        }
        if (typeof data !== "string") {
          throw new CreateMemberError("unknown", "RPC returned no member id");
        }
        return data;
      } finally {
        inFlightRef.current = false;
      }
    },
    onSuccess: () => {
      // Refresh the member list so the new row appears on return.
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });
}
