// Story 2.4 — /members/:id route host.
//
// Reads the :id param, delegates fetch to useMemberProfile, owns the
// loading / error / not-found render branches. Header carries the back
// chevron + an action overflow placeholder for Stories 2.5/2.6/2.7.

import { ChevronLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  ProfileError,
  ProfileNotFound,
  ProfileSkeleton,
} from "@/components/domain/MemberProfileStates";
import { Button } from "@/components/ui/button";
import { MemberProfile, useMemberProfile } from "@/features/member";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberProfileRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const isUuid = UUID_REGEX.test(id);
  const navigate = useNavigate();
  const t = useT();
  const goBack = () => navigate("/members");

  const query = useMemberProfile(isUuid ? id : undefined);

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            title={t("members.profile.action_disabled_tooltip")}
          >
            {t("members.profile.action_restart_cycle")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            title={t("members.profile.action_disabled_tooltip")}
          >
            {t("members.profile.action_delete")}
          </Button>
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
          transactions={query.data.transactions}
          stats={query.data.stats}
        />
      )}
    </section>
  );
}
