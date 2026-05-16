// Story 10.3 — useDisputeRealtime: the collector-scoped dispute Realtime
// subscription. The FIRST Supabase Realtime subscription in the app
// (Q-ARCH6 sanctions Realtime for dispute notifications only).
//
// Mounted once in AppLayout. Consumes Story 10.2's dispute-notify
// broadcast: channel `disputes:{collector_id}`, event `dispute_flagged`,
// payload { dispute_id, transaction_id, member_id, flagged_at }. On a
// live event it shows an in-app toast + invalidates the affected member's
// profile + disputes queries so an open profile refreshes its banner.
//
// Best-effort: a failed subscribe is non-fatal — the DB-driven banner
// (useDisputes) is the reliable surface.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";

import { useCollectorId } from "@/features/auth/api/useCollectorId";
import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";

import { DISPUTES_QUERY_KEY } from "../types";

export function useDisputeRealtime(): void {
  const collectorId = useCollectorId();
  const queryClient = useQueryClient();
  const t = useT();

  useEffect(() => {
    if (!collectorId) return;

    const channel = supabase
      .channel(`disputes:${collectorId}`)
      .on("broadcast", { event: "dispute_flagged" }, (message) => {
        const payload = message.payload as { member_id?: unknown } | undefined;
        const memberId = typeof payload?.member_id === "string" ? payload.member_id : null;
        toast(t("dispute.realtime.toast"));
        if (memberId) {
          // The banner + the row icon read from useDisputes — invalidating
          // that key refreshes an open member profile live.
          void queryClient.invalidateQueries({
            queryKey: [...DISPUTES_QUERY_KEY, "member", memberId],
          });
        }
      })
      .subscribe((status) => {
        // Best-effort: a failed subscribe is non-fatal (the DB-driven
        // banner is the reliable surface) but AC #15 requires it logged.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`[dispute-realtime] subscribe failed: ${status}`);
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [collectorId, queryClient, t]);
}
