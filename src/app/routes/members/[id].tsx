// Story 2.4 — /members/:id route host.
//
// Reads the :id param, delegates fetch to useMemberProfile, owns the
// loading / error / not-found render branches. Header carries the back
// chevron + an action overflow placeholder for Stories 2.5/2.6/2.7.

import { ChevronLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { MemberProfile, useMemberProfile } from "@/features/member";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ProfileNotFound({ onBack, t }: { onBack: () => void; t: ReturnType<typeof useT> }) {
  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
      role="alert"
      aria-live="polite"
    >
      <p className="text-body-1 text-text-secondary">{t("members.profile.error.not_found")}</p>
      <Button type="button" variant="outline" size="lg" onClick={onBack} className="w-full">
        {t("members.profile.error.back_cta")}
      </Button>
    </section>
  );
}

function ProfileError({ onBack, t }: { onBack: () => void; t: ReturnType<typeof useT> }) {
  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
      role="alert"
      aria-live="polite"
    >
      <p className="text-body-1 text-destructive">{t("members.profile.error.load")}</p>
      <Button type="button" variant="outline" size="lg" onClick={onBack} className="w-full">
        {t("members.profile.error.back_cta")}
      </Button>
    </section>
  );
}

function ProfileSkeleton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={ariaLabel}
      className="mx-auto flex w-full max-w-md flex-col gap-4 p-4"
    >
      <div className="h-32 animate-pulse rounded-lg bg-neutral-100" />
      <div className="h-12 animate-pulse rounded-lg bg-neutral-100" />
      <div className="h-12 animate-pulse rounded-lg bg-neutral-100" />
      <div className="h-12 animate-pulse rounded-lg bg-neutral-100" />
    </div>
  );
}

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
        {/* Story 2.4 — action menu placeholder. Stories 2.5/2.6/2.7 will
            replace these inline disabled buttons with a real dropdown when
            the first action is wired. Inline-disabled buttons keep the
            dep surface zero at MVP. */}
        <div
          role="group"
          aria-label={t("members.profile.actions_label")}
          className="flex items-center gap-1"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            title={t("members.profile.action_disabled_tooltip")}
          >
            {t("members.profile.action_edit")}
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
        <ProfileNotFound onBack={goBack} t={t} />
      ) : query.isLoading ? (
        <ProfileSkeleton ariaLabel={t("members.profile.transactions.title")} />
      ) : query.isError ? (
        <ProfileError onBack={goBack} t={t} />
      ) : query.data === undefined ? (
        <ProfileNotFound onBack={goBack} t={t} />
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
