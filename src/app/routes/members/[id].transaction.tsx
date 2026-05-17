// Story 4.6 — /members/:id/transaction route host.
//
// Replaces the Story 4.1 MemberActionSheet modal: tapping a member card
// navigates here. Owns the contribution + rattrapage mutations (toasts /
// 5-s undo / offline / typed-error handling — ported verbatim from the
// old MemberList wiring) and renders the pure-presentation
// NewTransactionForm. The "Prêt" type navigates to /members/:id/advance.
//
// Reads the member from useMembers() — the SAME persisted list query the
// old MemberActionSheet consumed via MemberList — so the offline
// contribution path keeps working (a cold useMemberProfile would fail
// offline). Mirrors [id].advance.tsx for the route/component split.

import { useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CYCLE_TOTAL_DAYS } from "@/domain/cycle";
import { useMembers } from "@/features/member";
import {
  showContributionToast,
  showRattrapageToast,
} from "@/features/transaction/api/showContributionToast";
import { showOfflineToast } from "@/features/transaction/api/showOfflineToast";
import { undoTransaction } from "@/features/transaction/api/undoTransaction";
import { UndoTransactionError } from "@/features/transaction/api/undoTransactionError";
import {
  RecordContributionError,
  useRecordContribution,
} from "@/features/transaction/api/useRecordContribution";
import {
  RecordRattrapageError,
  useRecordRattrapage,
} from "@/features/transaction/api/useRecordRattrapage";
import { NewTransactionForm } from "@/features/transaction/ui/NewTransactionForm";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberTransactionRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";

  if (!UUID_REGEX.test(id)) {
    return <Navigate to="/members" replace />;
  }
  return <TransactionRouteBody memberId={id} />;
}

function TransactionRouteBody({ memberId }: { memberId: string }): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: members, isLoading, isError } = useMembers();
  const recordContribution = useRecordContribution();
  const recordRattrapage = useRecordRattrapage();

  if (isLoading) {
    return <></>;
  }
  if (isError) {
    return (
      <section
        role="alert"
        aria-live="polite"
        className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
      >
        <p className="text-body-1 text-destructive">{t("members.load_error")}</p>
        <Button asChild variant="outline">
          <Link to="/members">{t("transaction.new.back_label")}</Link>
        </Button>
      </section>
    );
  }

  const member = (members ?? []).find((m) => m.id === memberId);
  if (member === undefined) {
    return <Navigate to="/members" replace />;
  }
  // No active cycle — OR a member flagged terminé even with a stale active
  // cycle row (the data-inconsistency case the old MemberActionSheet wiring
  // guarded via displayStatus → isCycleClosedForTransactions). Either way,
  // no transaction is possible; the profile is the destination.
  if (member.currentCycle === null || member.displayStatus === "termine") {
    return <Navigate to={`/members/${memberId}`} replace />;
  }

  const cycle = member.currentCycle;
  const cycleDay = cycle.dayNumber;
  const daysRemaining = Math.max(0, CYCLE_TOTAL_DAYS - cycleDay);

  const undoHandler = (txId: string) => async (): Promise<void> => {
    try {
      await undoTransaction(txId, queryClient);
    } catch (err) {
      if (err instanceof UndoTransactionError) {
        toast.error(t(`transaction.error.${err.code}`));
      } else {
        toast.error(t("transaction.error.unknown"));
      }
    }
  };

  const handleContribution = async (amount: number): Promise<void> => {
    try {
      const result = await recordContribution.mutateAsync({
        memberId,
        cycleId: cycle.id,
        amount,
        cycleDay,
      });
      if (result.wasOffline) {
        showOfflineToast({ memberName: member.name });
      } else {
        showContributionToast({ memberName: member.name, onUndo: undoHandler(result.txId) });
      }
      navigate("/members");
    } catch (err) {
      // Surface every failure — a silent dead-end on a full page is worse
      // than the old dismissable sheet.
      if (err instanceof RecordContributionError) {
        toast.error(t(`transaction.error.${err.code}`));
      } else {
        toast.error(t("transaction.error.unknown"));
      }
    }
  };

  const handleRattrapage = async (daysCovered: number): Promise<void> => {
    try {
      const result = await recordRattrapage.mutateAsync({
        memberId,
        cycleId: cycle.id,
        dailyAmount: member.dailyAmount,
        cycleDay,
        daysCovered,
      });
      if (result.wasOffline) {
        showOfflineToast({ memberName: member.name });
      } else {
        showRattrapageToast({
          memberName: member.name,
          daysCovered,
          onUndo: undoHandler(result.txId),
        });
      }
      navigate("/members");
    } catch (err) {
      if (err instanceof RecordRattrapageError) {
        toast.error(t(`transaction.error.${err.code}`));
      } else {
        toast.error(t("transaction.error.unknown"));
      }
    }
  };

  // The member <select> only offers members a transaction can target —
  // an active cycle, not flagged terminé (same gate as the redirect above).
  const eligibleMembers = (members ?? [])
    .filter((m) => m.currentCycle !== null && m.displayStatus !== "termine")
    .map((m) => ({ id: m.id, name: m.name, dailyAmount: m.dailyAmount }));

  return (
    <NewTransactionForm
      key={memberId}
      members={eligibleMembers}
      selectedMemberId={memberId}
      dailyAmount={member.dailyAmount}
      daysRemaining={daysRemaining}
      isPending={recordContribution.isPending || recordRattrapage.isPending}
      onBack={() => navigate("/members")}
      onSelectMember={(id) => navigate(`/members/${id}/transaction`)}
      onViewProfile={() => navigate(`/members/${memberId}`)}
      onSubmitContribution={(amount) => void handleContribution(amount)}
      onSubmitRattrapage={(days) => void handleRattrapage(days)}
      onGoToAdvance={() => navigate(`/members/${memberId}/advance`)}
    />
  );
}
