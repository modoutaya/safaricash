// Story 1.5 — /login route. Hosts <LoginForm>. Purely public.

import { useNavigate } from "react-router-dom";

import { LoginForm } from "@/features/auth/ui/LoginForm";

export default function LoginRoute() {
  const navigate = useNavigate();
  return (
    <main className="flex min-h-screen items-center justify-center bg-background py-8">
      <LoginForm
        onNonRegistered={(phone) => {
          navigate("/non-registered", { state: { phone } });
        }}
        onSignedIn={({ memberCount }) => {
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
