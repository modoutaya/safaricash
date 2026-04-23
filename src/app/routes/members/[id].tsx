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
import { RestartCycleDialog } from "@/features/member/ui/RestartCycleDialog";
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

  const query = useMemberProfile(isUuid ? id : undefined);

  // Story 2.7 — restart action shows only when the current cycle is
  // completed/settled. Hidden (not disabled) per AC #1.
  const currentCycleStatus = query.data?.currentCycle?.status;
  const canRestart = currentCycleStatus === "completed" || currentCycleStatus === "settled";

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
          {/* Story 2.5 — Modifier is now real; Restart-cycle (2.7) and
              Supprimer (2.6) stay disabled until those stories ship. */}
          <Button asChild variant="outline" size="sm" disabled={!isUuid}>
            <Link to={`/members/${id}/edit`}>{t("members.profile.action_edit")}</Link>
          </Button>
          {canRestart ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setRestartOpen(true)}>
              {t("members.profile.action_restart_cycle")}
            </Button>
          ) : null}
          {isUuid ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setDeleteOpen(true)}
            >
              {t("members.profile.action_delete")}
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
        />
      )}

      {query.data && canRestart ? (
        <RestartCycleDialog
          open={restartOpen}
          onOpenChange={setRestartOpen}
          memberId={id}
          memberName={query.data.member.name}
          onSuccess={() => toast.success(t("members.profile.restart.toast_success"))}
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
