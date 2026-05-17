// Story 2.5 — /members/:id/edit route host.
//
// Loads the member via useMemberProfile (same hook the profile route uses
// — the cache is shared, so navigating from profile → edit doesn't trigger
// a refetch), seeds MemberForm with the current values, owns the
// useUpdateMember mutation. Renders the in-flight cycle warning banner
// via the form's belowFields render-prop slot.
//
// MemberForm carries its own full-bleed topbar (with the cancel/back
// action), so this route has no separate header.

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
    <div className="flex flex-col">
      {!isUuid ? (
        <div className="p-4">
          <ProfileNotFound
            message={t("members.profile.error.not_found")}
            backLabel={t("members.profile.error.back_cta")}
            onBack={goBackToList}
          />
        </div>
      ) : profileQuery.isLoading ? (
        <div className="p-4">
          <ProfileSkeleton ariaLabel={t("members.edit.title")} />
        </div>
      ) : profileQuery.isError ? (
        <div className="p-4">
          <ProfileError
            message={t("members.profile.error.load")}
            backLabel={t("members.profile.error.back_cta")}
            onBack={goBackToList}
          />
        </div>
      ) : profileQuery.data === undefined ? (
        <div className="p-4">
          <ProfileNotFound
            message={t("members.profile.error.not_found")}
            backLabel={t("members.profile.error.back_cta")}
            onBack={goBackToList}
          />
        </div>
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
                const result = await updateMember.mutateAsync({ id, values });
                // Story 8.6 — offline edits are queued, not applied; the
                // toast must tell the truth about the actual state.
                if (result.wasOffline) {
                  toast(t("members.edit.toast_offline"));
                } else {
                  toast.success(t("members.edit.toast_success"));
                }
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
                    className="rounded-md bg-warning-bg px-3 py-2 text-body-2 text-warning-text"
                  >
                    {t("members.edit.impact_alert.daily_amount")}
                  </div>
                );
              }}
            />
          );
        })()
      )}
    </div>
  );
}
