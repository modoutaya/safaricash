// Story 1.5 — /members route. At this story's scope, only the zero-members
// empty state is wired (Flow 5 step P). Story 2.1 will replace this with
// the real list + search.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/domain/EmptyState";
import { supabase } from "@/infrastructure/supabase/client";
import { useT } from "@/i18n/useT";

export default function MembersRoute() {
  const t = useT();
  const navigate = useNavigate();
  const [memberCount, setMemberCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("members")
      .select("id", { count: "exact", head: true })
      .limit(1)
      .then(({ count }) => {
        if (!cancelled) setMemberCount(count ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (memberCount === null) {
    return null;
  }

  if (memberCount === 0) {
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
        {memberCount} membre{memberCount > 1 ? "s" : ""} — la liste complète arrive avec Story 2.1.
      </p>
    </section>
  );
}
