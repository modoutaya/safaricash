// Story 1.5 — /login route. Hosts <LoginForm>. Purely public.

import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { LoginForm } from "@/features/auth/ui/LoginForm";
import { useT } from "@/i18n/useT";

export default function LoginRoute() {
  const navigate = useNavigate();
  const t = useT();
  return (
    <main className="flex min-h-screen items-center justify-center bg-background py-8">
      <LoginForm
        onNonRegistered={(phone) => {
          navigate("/non-registered", { state: { phone } });
        }}
        onSignedIn={({ memberCount, warning }) => {
          // Session IS established. If the post-auth member count query
          // failed, surface a toast so the user knows the routing fell
          // back to the dashboard instead of onboarding.
          if (warning === "count_query_failed") {
            toast.error(t("login.members_load_error"));
            navigate("/dashboard", { replace: true });
            return;
          }
          if (memberCount === 0) {
            navigate("/members", { replace: true });
          } else {
            navigate("/dashboard", { replace: true });
          }
        }}
      />
    </main>
  );
}
