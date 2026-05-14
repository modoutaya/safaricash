// Story 7.3 / FR21 — /members/:id/settlement route host.
//
// Loads member + current cycle + transactions, derives the advances
// array, mounts Story 7.1's <SettlementSummaryCard>. Precondition gate:
// cycle.status === "completed" (otherwise redirect to the profile).
// onConfirm is a Story 7.4 stub — see TODO below. NFR-R3 zero-tolerance
// compliance: route NEVER recomputes the payout; the card calls settle()
// from @/domain/cycle internally (Story 3.2 / 7.1).
//
// See: epics.md:1121-1133 (Story 7.3 BDD), prd.md:501 (FR21), prd.md:565
// (NFR-R3), ux-design-specification.md:793-823 (Flow 3 diagram + critical
// UX detail "trust ceremony over speed").

import { ChevronLeft } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { ProfileError, ProfileSkeleton } from "@/components/domain/MemberProfileStates";
import { SettlementSummaryCard } from "@/components/domain/SettlementSummaryCard";
import { useMemberProfile } from "@/features/member";
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
  if (!data || !data.currentCycle || data.currentCycle.status !== "completed") {
    return <Navigate to={`/members/${memberId}`} replace />;
  }

  // Derive the advances array — newest-first per UX line 1107. The caller
  // owns ordering per Story 7.1 AC #1.3; the card renders array order as-is.
  const advances = data.transactions
    .filter((tx) => tx.kind === "advance")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((tx) => tx.amount);

  // The card calls onVerifyTransactions(memberId, cycleId) and
  // onConfirm(memberId, cycleId), but the route already owns both values
  // via closure — we intentionally drop them on the floor. Story 7.4's
  // replacement handler may choose to use them if its mutation signature
  // needs them.

  // TODO Story 7.4: replace this stub with the password re-auth dialog +
  // /functions/v1/cycle-settlement Edge Function commit RPC. Checklist:
  //   1. Swap `handleConfirm` for the re-auth-trigger + commit mutation.
  //   2. Drive `isSubmitting` prop on <SettlementSummaryCard> from the
  //      mutation's `isPending` state — without it, both CTAs stay
  //      clickable during the RPC and the user can double-fire commit.
  //   3. After RPC success, route the user to the post-commit envelope
  //      handover (Story 7.4 wires <EnvelopeHandoverScreen> from Story 7.2).
  // DO NOT REMOVE THIS COMMENT UNTIL STORY 7.4 LANDS.
  const handleConfirm = () => {
    toast.info(t("settlement.flow.confirm_pending_toast"));
  };

  const handleVerifyTransactions = () => {
    navigate(`/members/${memberId}`);
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
        onVerifyTransactions={handleVerifyTransactions}
        onConfirm={handleConfirm}
      />
    </section>
  );
}
