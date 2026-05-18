// /login route. Hosts <LoginForm>. Purely public.
// Story 1.5b: single-screen phone + password (PRD v1.3 auth pivot).

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { InstallAppButton } from "@/components/domain/InstallAppButton";
import { LoginForm } from "@/features/auth/ui/LoginForm";
import { useT } from "@/i18n/useT";

export default function LoginRoute() {
  const navigate = useNavigate();
  const t = useT();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background py-8">
      <LoginForm
        onSignedIn={(result) => {
          // Narrow discriminated union — LoginForm only fires this on
          // kind: "ok"; the guard keeps TS honest and future-proof.
          if (result.kind !== "ok") return;
          // Session IS established. If the post-auth member count query
          // failed, surface a toast so the user knows the routing fell
          // back to the dashboard instead of the empty-state onboarding.
          if (result.warning === "count_query_failed") {
            toast.error(t("login.members_load_error"));
            navigate("/dashboard", { replace: true });
            return;
          }
          if (result.memberCount === 0) {
            navigate("/members", { replace: true });
          } else {
            navigate("/dashboard", { replace: true });
          }
        }}
      />
      <InstallAppButton />
    </main>
  );
}
