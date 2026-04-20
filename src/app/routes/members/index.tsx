// Story 1.5 — /members route. At this story's scope, only the zero-members
// empty state is wired (Flow 5 step P). Story 2.1 will replace this with
// the real list + search.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/domain/EmptyState";
import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";

type LoadState = { status: "loading" } | { status: "error" } | { status: "ready"; count: number };

export default function MembersRoute() {
  const t = useT();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("members")
      .select("id", { count: "exact", head: true })
      .limit(1)
      .then(({ count, error }) => {
        if (cancelled) return;
        // Handle errors explicitly. Silently defaulting `count ?? 0` to 0
        // would render the empty state to a collector who actually has
        // members — a real correctness bug (risk of duplicate creation
        // from the "Ajouter mon premier membre" CTA).
        if (error) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", count: count ?? 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return null;
  }

  if (state.status === "error") {
    return (
      <section role="alert" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
        <h1 className="text-title-1 text-text-primary">Membres</h1>
        <p className="text-body-1 text-destructive">{t("login.members_load_error")}</p>
      </section>
    );
  }

  if (state.count === 0) {
    return (
      <EmptyState
        emoji="🦁"
        headline={t("login.empty_state_headline")}
        subtext={t("login.empty_state_subtext")}
        ctaLabel={t("login.empty_state_cta")}
        onCtaClick={() => navigate("/members/new")}
      />
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-title-1 text-text-primary">Membres</h1>
      <p className="text-body-1 text-text-secondary">
        {state.count} membre{state.count > 1 ? "s" : ""} — la liste complète arrive avec Story 2.1.
      </p>
    </section>
  );
}
