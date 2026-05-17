// Story 2.2 — /members/new route host.
//
// Mounts <MemberForm> and owns post-submit navigation. The form carries
// its own full-bleed topbar (with the cancel/back action), so the route
// is a thin wrapper — no separate header.

import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { MemberForm, isContactPickerSupported, useCreateMember } from "@/features/member";
import { useT } from "@/i18n/useT";

export default function MembersNewRoute() {
  const navigate = useNavigate();
  const t = useT();
  // Story 2.3 — secondary CTA only when the browser supports the picker.
  const canImport = isContactPickerSupported();
  const createMember = useCreateMember();

  return (
    <div className="flex flex-col">
      <MemberForm
        mode="create"
        isPending={createMember.isPending}
        errorCode={createMember.error?.code ?? null}
        onSubmit={async (values) => {
          await createMember.mutateAsync(values);
          toast.success(t("members.create.success_toast", { name: values.name }));
          navigate("/members", { replace: true });
        }}
        onCancel={() => navigate("/members")}
      />

      {canImport ? (
        <div className="mx-auto w-full max-w-2xl px-4 pb-4">
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link to="/members/import">{t("members.import.import_cta")}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
