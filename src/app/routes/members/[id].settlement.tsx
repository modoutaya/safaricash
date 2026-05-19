// Story 7.3 / FR21 — /members/:id/settlement route host.
// Story 7.4 — replaces the Story 7.3 onConfirm stub with the real password
// re-auth dialog + cycle-settlement Edge Function commit. On success the
// route swaps in-place to Story 7.2's <EnvelopeHandoverScreen>.
//
// Loads member + current cycle + transactions, derives the advances array,
// mounts Story 7.1's <SettlementSummaryCard>. Precondition gate:
// cycle.status === "completed" (otherwise redirect to the profile).
// NFR-R3 zero-tolerance: route NEVER recomputes the payout; the card calls
// settle() from @/domain/cycle internally (Story 3.2 / 7.1), and that same
// value is passed to the Edge Function for the server-side cross-check.
//
// See: epics.md:1121-1133 (Story 7.3 BDD), epics.md:1135-1151 (Story 7.4),
// prd.md:501 (FR21), prd.md:565 (NFR-R3).

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { EnvelopeHandoverScreen } from "@/components/domain/EnvelopeHandoverScreen";
import { ProfileError, ProfileSkeleton } from "@/components/domain/MemberProfileStates";
import { SettlementSummaryCard } from "@/components/domain/SettlementSummaryCard";
import { cycleLengthDays, settle } from "@/domain/cycle";
import { useMemberProfile } from "@/features/member";
import type { CommitSettlementError } from "@/features/settlement/api/commitSettlementError";
import type { CommitSettlementResult } from "@/features/settlement/api/useCommitSettlement";
import { SettlementReauthDialog } from "@/features/settlement/ui/SettlementReauthDialog";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberSettlementRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";

  if (!UUID_REGEX.test(id)) {
    return <Navigate to="/members" replace />;
  }
  return <SettlementRouteBody memberId={id} />;
}

function SettlementRouteBody({ memberId }: { memberId: string }): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const profileQuery = useMemberProfile(memberId);
  const goBackToProfile = () => navigate(`/members/${memberId}`);

  // Story 7.4 — dialog open state + post-success view swap.
  const [reauthOpen, setReauthOpen] = useState(false);
  const [committedResult, setCommittedResult] = useState<CommitSettlementResult | null>(null);
  // Story 7.4 code-review patch #1 — track the dialog's in-flight mutation
  // state directly. Earlier code instantiated useCommitSettlement() here
  // for `isPending` but that was a SECOND, independent mutation that
  // never fired (the dialog has its own instance that does the actual
  // mutateAsync). With this signal, the card's CTAs correctly disable
  // during commit (Story 7.1 AC #4).
  const [isCommitting, setIsCommitting] = useState(false);

  if (profileQuery.isLoading) {
    return (
      <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">
        <ProfileSkeleton ariaLabel={t("settlement.flow.title")} />
      </section>
    );
  }

  if (profileQuery.isError) {
    return (
      <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">
        <ProfileError
          message={t("members.profile.error.load")}
          backLabel={t("settlement.flow.back_label")}
          onBack={goBackToProfile}
        />
      </section>
    );
  }

  const data = profileQuery.data;
  // Precondition guards — only `completed` cycles are settleable.
  // Once Story 7.4 fires the commit and the cache invalidates, the cycle
  // flips to 'settled' and this guard would force a redirect. That's why
  // we capture `committedResult` BEFORE the cache refresh and short-circuit
  // the EnvelopeHandover view above any redirect.
  if (
    !committedResult &&
    (!data || !data.currentCycle || data.currentCycle.status !== "completed")
  ) {
    return <Navigate to={`/members/${memberId}`} replace />;
  }

  // Story 7.4 — post-commit view: mount EnvelopeHandoverScreen.
  if (committedResult && data) {
    return (
      <EnvelopeHandoverScreen
        memberName={data.member.name}
        payoutAmount={committedResult.settled_payout}
        recipientPhone={data.member.phone_number}
        smsState="sent"
        onReturnToMembers={() => navigate("/members")}
      />
    );
  }

  // `data` and `data.currentCycle` are non-null here (preconditions passed).
  // TS doesn't narrow through the `!committedResult` branch above, so assert.
  if (!data || !data.currentCycle) {
    // Defensive — should be unreachable given the guard above.
    return <Navigate to={`/members/${memberId}`} replace />;
  }

  // Derive the advances array — newest-first per UX line 1107. The caller
  // owns ordering per Story 7.1 AC #1.3; the card renders array order as-is.
  const advances = data.transactions
    .filter((tx) => tx.kind === "advance")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((tx) => tx.amount);

  // NFR-R3 cross-check value — Story 7.1's card already calls settle()
  // internally to render the final payout row. We re-call it here to pass
  // the SAME value to the Edge Function (the server recomputes independently
  // and rejects on mismatch). Story 11.2 — contributionDays is derived from
  // THIS cycle's calendar-month length, not a fixed 30.
  const settlementContributionDays =
    cycleLengthDays(data.currentCycle.start_date, data.currentCycle.end_date) - 1;
  const expectedPayout = settle(data.member.daily_amount, advances, settlementContributionDays);

  const handleVerifyTransactions = () => {
    navigate(`/members/${memberId}`);
  };

  const handleConfirm = () => {
    setReauthOpen(true);
  };

  const handleReauthSuccess = (result: CommitSettlementResult) => {
    setCommittedResult(result);
    const firstName = data.member.name.split(" ")[0] ?? data.member.name;
    toast.success(t("settlement.toast.success", { memberFirstName: firstName }));
  };

  const handleReauthError = (err: CommitSettlementError) => {
    const code = err.code;
    if (code === "payout_mismatch") {
      toast.error(t("settlement.reauth.error.payout_mismatch"));
      navigate(`/members/${memberId}`);
      return;
    }
    if (code === "cycle_not_settleable") {
      toast.error(t("settlement.reauth.error.cycle_not_settleable"));
      navigate(`/members/${memberId}`);
      return;
    }
    if (code === "not_found") {
      toast.error(t("settlement.reauth.error.not_found"));
      navigate(`/members/${memberId}`);
      return;
    }
    if (code === "network") {
      toast.error(t("settlement.reauth.error.network"));
      return;
    }
    toast.error(t("settlement.reauth.error.unknown"));
  };

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">
      <header className="flex items-center gap-2 px-4">
        <button
          type="button"
          onClick={goBackToProfile}
          aria-label={t("settlement.flow.back_label")}
          className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
        <h1 className="text-title-1 text-text-primary">{t("settlement.flow.title")}</h1>
      </header>

      <SettlementSummaryCard
        memberId={memberId}
        memberName={data.member.name}
        dailyAmount={data.member.daily_amount}
        contributedTotal={data.stats.contributedTotal}
        advances={advances}
        cycleId={data.currentCycle.id}
        cycleStartDate={data.currentCycle.start_date}
        cycleEndDate={data.currentCycle.end_date}
        isSubmitting={isCommitting}
        onVerifyTransactions={handleVerifyTransactions}
        onConfirm={handleConfirm}
      />

      <SettlementReauthDialog
        open={reauthOpen}
        onOpenChange={setReauthOpen}
        memberId={memberId}
        cycleId={data.currentCycle.id}
        memberName={data.member.name}
        expectedPayout={expectedPayout}
        onSuccess={handleReauthSuccess}
        onError={handleReauthError}
        onMutatingChange={setIsCommitting}
      />
    </section>
  );
}
