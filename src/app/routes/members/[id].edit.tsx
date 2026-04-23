// Story 2.5 — /members/:id/edit route host.
//
// Loads the member via useMemberProfile (same hook the profile route uses
// — the cache is shared, so navigating from profile → edit doesn't trigger
// a refetch), seeds MemberForm with the current values, owns the
// useUpdateMember mutation. Renders the in-flight cycle warning banner
// via the form's belowFields render-prop slot.

import { ChevronLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import {
  ProfileError,
  ProfileNotFound,
  ProfileSkeleton,
} from "@/components/domain/MemberProfileStates";
import {
  MemberForm,
  computeEditImpact,
  useMemberProfile,
  useUpdateMember,
  type CreateMemberInput,
} from "@/features/member";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberEditRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const isUuid = UUID_REGEX.test(id);
  const navigate = useNavigate();
  const t = useT();

  const profileQuery = useMemberProfile(isUuid ? id : undefined);
  const updateMember = useUpdateMember();

  const goBackToProfile = () => navigate(isUuid ? `/members/${id}` : "/members");
  const goBackToList = () => navigate("/members");

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">
      <header className="flex items-center gap-2 px-4">
        <button
          type="button"
          onClick={goBackToProfile}
          aria-label={t("members.edit.back_label")}
          className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
      </header>

      {!isUuid ? (
        <ProfileNotFound
          message={t("members.profile.error.not_found")}
          backLabel={t("members.profile.error.back_cta")}
          onBack={goBackToList}
        />
      ) : profileQuery.isLoading ? (
        <ProfileSkeleton ariaLabel={t("members.edit.title")} />
      ) : profileQuery.isError ? (
        <ProfileError
          message={t("members.profile.error.load")}
          backLabel={t("members.profile.error.back_cta")}
          onBack={goBackToList}
        />
      ) : profileQuery.data === undefined ? (
        <ProfileNotFound
          message={t("members.profile.error.not_found")}
          backLabel={t("members.profile.error.back_cta")}
          onBack={goBackToList}
        />
      ) : (
        (() => {
          const initialValues: CreateMemberInput = {
            name: profileQuery.data.member.name,
            phoneNumber: profileQuery.data.member.phone_number ?? "",
            dailyAmount: profileQuery.data.member.daily_amount,
          };
          const currentCycle = profileQuery.data.currentCycle;

          return (
            <MemberForm
              mode="edit"
              initialValues={initialValues}
              isPending={updateMember.isPending}
              errorCode={updateMember.error?.code ?? null}
              onSubmit={async (values) => {
                await updateMember.mutateAsync({ id, values });
                toast.success(t("members.edit.toast_success"));
                navigate(`/members/${id}`, { replace: true });
              }}
              onCancel={goBackToProfile}
              belowFields={({ values }) => {
                const impact = computeEditImpact(initialValues, values, currentCycle);
                if (impact === "none") return null;
                return (
                  <div
                    role="status"
                    aria-live="polite"
                    className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-body-2 text-warning-800"
                  >
                    {t("members.edit.impact_alert.daily_amount")}
                  </div>
                );
              }}
            />
          );
        })()
      )}
    </section>
  );
}
