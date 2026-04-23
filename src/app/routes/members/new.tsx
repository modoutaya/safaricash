// Story 2.2 — /members/new route host.
//
// Mounts <MemberForm> and owns post-submit navigation (mirror of
// LoginRoute from Story 1.5b — the form itself is navigation-agnostic).

import { ChevronLeft } from "lucide-react";
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
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-6">
      <header className="flex items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => navigate("/members")}
          aria-label={t("members.create.back_label")}
          className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-neutral-100 hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
        >
          <ChevronLeft size={24} aria-hidden />
        </button>
      </header>

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
        <div className="mx-auto w-full max-w-sm px-4">
          <Button asChild variant="outline" size="lg" className="w-full">
            <Link to="/members/import">{t("members.import.import_cta")}</Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
