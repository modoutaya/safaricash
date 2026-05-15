// Story 2.5 — useUpdateMember hook.
// Story 8.6 — offline branch + optimistic UI.
//
// TanStack mutation wrapping the SECURITY DEFINER RPC `update_member`.
// Story 8.6 mirrors Story 8.3's record-* hooks: when offline, the edit is
// queued as a `member.updated` OfflineEvent in the IndexedDB log instead of
// hitting the RPC; `onMutate` patches the member-list + profile caches
// optimistically; `onError` rolls back; `onSuccess` invalidation is GATED
// on `!wasOffline` (an offline edit must keep its optimistic state until
// Story 8.4's reconciler replays it and triggers the refetch).

import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { PostgrestError } from "@supabase/supabase-js";

import { getCurrentCollectorId, isOfflineAtEntry } from "@/features/transaction/api/offlineGuards";
import { appendEvent, OfflineEventLogError } from "@/infrastructure/sync";
import { supabase } from "@/infrastructure/supabase/client";

import {
  MEMBERS_QUERY_KEY,
  MEMBER_PROFILE_QUERY_KEY,
  updateMemberInputSchema,
  type MemberWithMeta,
  type UpdateMemberInput,
} from "../types";
import { buildMemberUpdateEvent } from "./buildMemberUpdateEvent";
import type { MemberProfileData } from "./useMemberProfile";

export type UpdateMemberErrorCode =
  | "unauthorized"
  | "duplicate_phone"
  | "validation"
  | "network"
  | "not_found"
  | "offline_storage"
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

export interface UpdateMemberResult {
  /** True when the edit was queued offline instead of applied online. */
  wasOffline: boolean;
}

/** Optimistic-update snapshot, restored by onError. */
interface UpdateMemberContext {
  previousMembers: MemberWithMeta[] | undefined;
  previousProfile: MemberProfileData | undefined;
}

export type UseUpdateMemberReturn = UseMutationResult<
  UpdateMemberResult,
  UpdateMemberError,
  UpdateMemberArgs,
  UpdateMemberContext
>;

/** Queue the edit as a `member.updated` event in the IndexedDB log. */
async function persistOfflineMemberUpdate(id: string, values: UpdateMemberInput): Promise<void> {
  const collectorId = await getCurrentCollectorId();
  if (!collectorId) {
    throw new UpdateMemberError(
      "unauthorized",
      "no active session — cannot queue offline member edit",
    );
  }
  const event = buildMemberUpdateEvent({
    eventId: crypto.randomUUID(),
    collectorId,
    memberId: id,
    name: values.name,
    phoneNumber: values.phoneNumber,
    dailyAmount: values.dailyAmount,
  });
  try {
    await appendEvent(event);
  } catch (err) {
    if (err instanceof OfflineEventLogError) {
      throw new UpdateMemberError(
        "offline_storage",
        `failed to queue offline member edit (${err.code}): ${err.message}`,
      );
    }
    throw err;
  }
}

export function useUpdateMember(): UseUpdateMemberReturn {
  const queryClient = useQueryClient();
  const inFlightRef = useRef(false);

  return useMutation<UpdateMemberResult, UpdateMemberError, UpdateMemberArgs, UpdateMemberContext>({
    // Story 8.6 — the hook owns offline detection + queueing. The default
    // networkMode 'online' would PAUSE mutationFn while offline, leaving the
    // offline branch unreachable (memory feedback_tanstack_networkmode_offline).
    networkMode: "always",
    mutationFn: async ({ id, values }): Promise<UpdateMemberResult> => {
      if (inFlightRef.current) {
        throw new UpdateMemberError("unknown", "update already in flight");
      }
      const parsed = updateMemberInputSchema.parse(values);
      inFlightRef.current = true;
      try {
        if (isOfflineAtEntry()) {
          await persistOfflineMemberUpdate(id, parsed);
          return { wasOffline: true };
        }
        try {
          const { error } = await supabase.rpc("update_member", {
            p_id: id,
            p_name: parsed.name,
            p_phone_number: parsed.phoneNumber,
            p_daily_amount: parsed.dailyAmount,
          });
          if (error) {
            const code = classifyError(error);
            if (code === "network") {
              await persistOfflineMemberUpdate(id, parsed);
              return { wasOffline: true };
            }
            throw new UpdateMemberError(code, error.message);
          }
          return { wasOffline: false };
        } catch (err) {
          if (err instanceof UpdateMemberError) throw err;
          // A fetch-level network failure (TypeError) → fall back to the
          // offline queue, same as Story 8.3's record-* hooks.
          if (err instanceof TypeError) {
            await persistOfflineMemberUpdate(id, parsed);
            return { wasOffline: true };
          }
          throw err;
        }
      } finally {
        inFlightRef.current = false;
      }
    },

    onMutate: async ({ id, values }): Promise<UpdateMemberContext> => {
      const profileKey = [...MEMBER_PROFILE_QUERY_KEY, id];
      await queryClient.cancelQueries({ queryKey: MEMBERS_QUERY_KEY });
      await queryClient.cancelQueries({ queryKey: profileKey });

      const previousMembers = queryClient.getQueryData<MemberWithMeta[]>(MEMBERS_QUERY_KEY);
      const previousProfile = queryClient.getQueryData<MemberProfileData>(profileKey);

      // Patch the cache from the PARSED values (the schema trims `name` and
      // coerces `dailyAmount`) so the optimistic UI matches what mutationFn
      // / the reconciler actually write. On a parse failure mutationFn will
      // throw + onError rolls back, so the raw-values fallback is harmless.
      const parsed = updateMemberInputSchema.safeParse(values);
      const patch = parsed.success ? parsed.data : values;

      if (previousMembers) {
        queryClient.setQueryData<MemberWithMeta[]>(
          MEMBERS_QUERY_KEY,
          previousMembers.map((m) =>
            m.id === id
              ? {
                  ...m,
                  name: patch.name,
                  phoneNumber: patch.phoneNumber,
                  dailyAmount: patch.dailyAmount,
                }
              : m,
          ),
        );
      }
      if (previousProfile) {
        queryClient.setQueryData<MemberProfileData>(profileKey, {
          ...previousProfile,
          member: {
            ...previousProfile.member,
            name: patch.name,
            phone_number: patch.phoneNumber,
            daily_amount: patch.dailyAmount,
          },
        });
      }
      return { previousMembers, previousProfile };
    },

    onError: (_err, { id }, context) => {
      if (!context) return;
      if (context.previousMembers !== undefined) {
        queryClient.setQueryData(MEMBERS_QUERY_KEY, context.previousMembers);
      }
      if (context.previousProfile !== undefined) {
        queryClient.setQueryData([...MEMBER_PROFILE_QUERY_KEY, id], context.previousProfile);
      }
    },

    onSuccess: (result, { id }) => {
      // Skip invalidation on the offline branch — the server doesn't know
      // about the edit yet; a refetch would wipe the optimistic snapshot.
      // Story 8.4's reconciler triggers the invalidation on successful replay.
      if (result.wasOffline) return;
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [...MEMBER_PROFILE_QUERY_KEY, id] });
    },
  });
}
