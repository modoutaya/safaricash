// Story 2.4 — /members/:id route host.
//
// Reads the :id param, delegates fetch to useMemberProfile, owns the
// loading / error / not-found render branches. Header carries the back
// chevron + an action overflow placeholder for Stories 2.5/2.6/2.7.

import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import {
  ProfileError,
  ProfileNotFound,
  ProfileSkeleton,
} from "@/components/domain/MemberProfileStates";
import { Button } from "@/components/ui/button";
import { MemberProfile, useMemberProfile } from "@/features/member";
import { DeleteMemberDialog } from "@/features/member/ui/DeleteMemberDialog";
import { ResendHistoryDialog } from "@/features/member/ui/ResendHistoryDialog";
import { RestartCycleDialog } from "@/features/member/ui/RestartCycleDialog";
import type {
  ResendHistoryError,
  ResendHistoryResult,
} from "@/features/member/api/useResendHistory";
import type { TransactionRow } from "@/features/member";
import {
  TransactionReceiptSheet,
  shareReceipt,
  useResendTransaction,
  type ResendTransactionResult,
} from "@/features/transaction";
import {
  DisputeDetailSheet,
  useDisputes,
  useResolveDispute,
  type DisputeRow,
} from "@/features/dispute";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberProfileRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const isUuid = UUID_REGEX.test(id);
  const navigate = useNavigate();
  const t = useT();
  const goBack = () => navigate("/members");
  const [restartOpen, setRestartOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resendOpen, setResendOpen] = useState(false);
  // Story 6.7 — selected transaction drives the per-receipt sheet.
  const [selectedTx, setSelectedTx] = useState<TransactionRow | null>(null);
  // Story 10.3 — selected dispute drives the dispute detail sheet.
  const [selectedDispute, setSelectedDispute] = useState<DisputeRow | null>(null);
  const resendTx = useResendTransaction();

  const query = useMemberProfile(isUuid ? id : undefined);
  // Story 10.3 — the member's open disputes drive the banner + the
  // per-transaction dispute icon.
  const disputesQuery = useDisputes(isUuid ? id : undefined);
  const resolveDispute = useResolveDispute(isUuid ? id : "");
  const openDisputes = [...(disputesQuery.data ?? [])].sort((a, b) =>
    a.flagged_at < b.flagged_at ? 1 : -1,
  );
  const disputedTransactionIds = new Set(openDisputes.map((d) => d.transaction_id));

  // Story 2.7 — restart action shows only when the current cycle is
  // completed/settled. Hidden (not disabled) per AC #1.
  const currentCycleStatus = query.data?.currentCycle?.status;
  const canRestart = currentCycleStatus === "completed" || currentCycleStatus === "settled";
  // Story 7.3 — "Clôturer le cycle" is visible iff the current cycle is
  // completed (not yet settled). Tap navigates to /members/:id/settlement.
  const canSettle = currentCycleStatus === "completed";
  // Story 6.6 — Renvoyer l'historique visible when current cycle is active
  // AND member is active. Server enforces opt-out / no-phone / empty-cycle
  // short-circuits.
  const memberStatus = query.data?.member.status;
  const canResendHistory = currentCycleStatus === "active" && memberStatus === "active";

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">
      <header className="flex items-center justify-between gap-2 px-4">
        <button
          type="button"
          onClick={() => navigate("/members")}
          aria-label={t("members.profile.back_label")}
          className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
        <div
          role="group"
          aria-label={t("members.profile.actions_label")}
          className="flex items-center gap-1"
        >
          <Button asChild variant="outline" size="sm" disabled={!isUuid}>
            <Link to={`/members/${id}/edit`}>{t("members.profile.action_edit")}</Link>
          </Button>
          {canRestart ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setRestartOpen(true)}>
              {t("members.profile.action_restart_cycle")}
            </Button>
          ) : null}
          {canSettle ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/members/${id}/settlement`}>{t("members.profile.action_settle")}</Link>
            </Button>
          ) : null}
          {canResendHistory ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setResendOpen(true)}>
              {t("members.profile.resend_history.action_label")}
            </Button>
          ) : null}
        </div>
      </header>

      {!isUuid ? (
        <ProfileNotFound
          message={t("members.profile.error.not_found")}
          backLabel={t("members.profile.error.back_cta")}
          onBack={goBack}
        />
      ) : query.isLoading ? (
        <ProfileSkeleton ariaLabel={t("members.profile.transactions.title")} />
      ) : query.isError ? (
        <ProfileError
          message={t("members.profile.error.load")}
          backLabel={t("members.profile.error.back_cta")}
          onBack={goBack}
        />
      ) : query.data === undefined ? (
        <ProfileNotFound
          message={t("members.profile.error.not_found")}
          backLabel={t("members.profile.error.back_cta")}
          onBack={goBack}
        />
      ) : (
        <MemberProfile
          member={query.data.member}
          currentCycle={query.data.currentCycle}
          previousCycles={query.data.previousCycles}
          transactions={query.data.transactions}
          stats={query.data.stats}
          onTransactionTap={setSelectedTx}
          openDisputeCount={openDisputes.length}
          disputedTransactionIds={disputedTransactionIds}
          onDisputeBannerTap={() => setSelectedDispute(openDisputes[0] ?? null)}
        />
      )}

      {/* Supprimer — a destructive action, kept out of the header action row
          (which overflowed on narrow screens) and placed full-width at the
          bottom of the page, separated, to reduce accidental taps. */}
      {query.data ? (
        <div className="border-t border-hairline px-4 pt-4">
          <Button
            type="button"
            variant="destructive"
            className="w-full"
            onClick={() => setDeleteOpen(true)}
          >
            {t("members.profile.action_delete")}
          </Button>
        </div>
      ) : null}

      {selectedDispute ? (
        <DisputeDetailSheet
          open={!!selectedDispute}
          onOpenChange={(next) => {
            if (!next) setSelectedDispute(null);
          }}
          dispute={selectedDispute}
          isResolving={resolveDispute.isPending}
          onResolve={async () => {
            const disputeId = selectedDispute.id;
            try {
              await resolveDispute.mutateAsync(disputeId);
              toast.success(t("dispute.detail.toast_resolved"));
              setSelectedDispute(null);
            } catch {
              // Keep the sheet open so the collector can retry.
              toast.error(t("dispute.detail.toast_error"));
            }
          }}
        />
      ) : null}

      {(() => {
        // Story 11.4 code-review patch — capture `data` + `cycleLength` in
        // local consts so the async `onShare` closure sees narrowed,
        // non-nullable values. The prior `query.data?.stats.cycleLength ?? 0`
        // fallback could leak a "jour N/0" denominator into the OS share
        // sheet if the closure fired after a refetch nulled `query.data`.
        const data = query.data;
        if (!data || !selectedTx || !data.currentCycle) return null;
        const cycleLength = data.stats.cycleLength;
        const currentCycle = data.currentCycle;
        return (
          <TransactionReceiptSheet
            open={!!selectedTx}
            onOpenChange={(next) => {
              if (!next) setSelectedTx(null);
            }}
            transaction={selectedTx}
            member={{
              phone_number: data.member.phone_number,
              sms_opt_out: data.member.sms_opt_out ?? false,
            }}
            cycle={{
              cycle_number: currentCycle.cycle_number,
              cycle_length: cycleLength,
            }}
            onShare={async () => {
              if (!selectedTx.receipt_token) {
                toast.error(t("transaction.receipt_sheet.share_toast_error"));
                return;
              }
              // Code-review patch (P7): `shareReceipt` can throw if
              // VITE_RECEIPT_URL_BASE is unset in a production build (the
              // helper throws by design — see shareReceipt.ts:34). Catch +
              // surface a generic error toast rather than leaking an
              // unhandled promise rejection to the React event loop.
              try {
                const result = await shareReceipt({
                  amount: selectedTx.amount,
                  cycleDay: selectedTx.cycle_day,
                  cycleLength,
                  receiptToken: selectedTx.receipt_token,
                });
                if (result.ok) {
                  const key =
                    result.via === "native"
                      ? "transaction.receipt_sheet.share_toast_native_success"
                      : "transaction.receipt_sheet.share_toast_clipboard_success";
                  toast.success(t(key));
                  return;
                }
                switch (result.reason) {
                  case "aborted":
                    toast.info(t("transaction.receipt_sheet.share_toast_aborted"));
                    return;
                  case "unsupported":
                    toast.error(
                      t("transaction.receipt_sheet.share_toast_unsupported", { url: result.url }),
                    );
                    return;
                  default:
                    toast.error(t("transaction.receipt_sheet.share_toast_error"));
                }
              } catch {
                toast.error(t("transaction.receipt_sheet.share_toast_error"));
              }
            }}
            onResend={async () => {
              // Capture the member name at handler-creation time so TS narrowing
              // survives the async boundary.
              const memberName = query.data?.member.name ?? "";
              try {
                const result: ResendTransactionResult = await resendTx.mutateAsync({
                  transactionId: selectedTx.id,
                  memberId: id,
                });
                if (result.enqueued > 0) {
                  toast.success(
                    t("transaction.receipt_sheet.resend_toast_success", {
                      memberFirstName: memberName.split(" ")[0] ?? memberName,
                    }),
                  );
                  setSelectedTx(null);
                  return;
                }
                switch (result.reason) {
                  case "opt_out":
                    toast.info(t("transaction.receipt_sheet.resend_toast_opt_out"));
                    return;
                  case "no_phone":
                    toast.info(t("transaction.receipt_sheet.resend_toast_no_phone"));
                    return;
                  case "undone":
                    toast.error(t("transaction.receipt_sheet.resend_toast_undone"));
                    return;
                  case "unsupported_kind":
                    toast.error(t("transaction.receipt_sheet.resend_toast_unsupported_kind"));
                    return;
                  default:
                    toast.error(t("transaction.receipt_sheet.resend_toast_error"));
                }
              } catch (err) {
                const code = (err as { code?: string })?.code;
                if (code === "not_found") {
                  toast.error(t("transaction.receipt_sheet.resend_toast_not_found"));
                } else {
                  toast.error(t("transaction.receipt_sheet.resend_toast_error"));
                }
              }
            }}
          />
        );
      })()}

      {query.data && canRestart ? (
        <RestartCycleDialog
          open={restartOpen}
          onOpenChange={setRestartOpen}
          memberId={id}
          memberName={query.data.member.name}
          onSuccess={() => toast.success(t("members.profile.restart.toast_success"))}
        />
      ) : null}

      {query.data && canResendHistory && query.data.currentCycle ? (
        <ResendHistoryDialog
          open={resendOpen}
          onOpenChange={setResendOpen}
          memberId={id}
          cycleId={query.data.currentCycle.id}
          memberName={query.data.member.name}
          onSuccess={(result: ResendHistoryResult) => {
            if (result.enqueued > 0) {
              const successKey =
                result.enqueued === 1
                  ? "members.profile.resend_history.toast_success_singular"
                  : "members.profile.resend_history.toast_success_plural";
              toast.success(t(successKey, { count: result.enqueued }));
              return;
            }
            switch (result.reason) {
              case "opt_out":
                toast.info(t("members.profile.resend_history.toast_opt_out"));
                return;
              case "no_phone":
                toast.info(t("members.profile.resend_history.toast_no_phone"));
                return;
              case "no_transactions":
                toast.info(t("members.profile.resend_history.toast_no_transactions"));
                return;
              default:
                toast.error(t("members.profile.resend_history.toast_error"));
            }
          }}
          onError={(_err: ResendHistoryError) =>
            toast.error(t("members.profile.resend_history.toast_error"))
          }
        />
      ) : null}

      {query.data
        ? (() => {
            const memberName = query.data.member.name;
            return (
              <DeleteMemberDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                memberId={id}
                memberName={memberName}
                transactionsCount={query.data.totalTransactionsCount}
                cyclesCount={query.data.previousCycles.length + (query.data.currentCycle ? 1 : 0)}
                onSuccess={() => {
                  toast.success(t("members.profile.delete.toast_success", { name: memberName }));
                  navigate("/members", { replace: true });
                }}
                onMutationFailure={() => toast.error(t("members.profile.delete.toast_failure"))}
              />
            );
          })()
        : null}
    </section>
  );
}
