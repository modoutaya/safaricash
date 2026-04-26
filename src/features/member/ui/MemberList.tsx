// Story 2.1 — /members list UI.
//
// State machine:
//   loading  → render null (no skeleton at MVP; pages come in fast enough
//              that a skeleton flash would be more distracting than empty).
//   error    → load_error copy.
//   success + 0 members        → EmptyState ("ajouter mon premier membre").
//   success + search no match  → no_search_match_headline / subtext.
//   success + ≥1 member        → search box + filter chips + card list.

import { Plus, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/domain/EmptyState";
import { MemberActionSheet } from "@/components/domain/MemberActionSheet";
import { DEFAULT_CYCLE_ENDING_WINDOW_DAYS, isCycleInUpcomingEndWindow } from "@/domain/cycle";
import { showContributionToast } from "@/features/transaction/api/showContributionToast";
import { undoTransaction } from "@/features/transaction/api/undoTransaction";
import { useRecordContribution } from "@/features/transaction/api/useRecordContribution";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { normalizeForSearch } from "../api/normalizeForSearch";
import { useMembers } from "../api/useMembers";
import { MEMBER_HEADER_CTA_THRESHOLD, type DisplayStatus, type MemberWithMeta } from "../types";
import { MemberCard } from "./MemberCard";

const CYCLES_ENDING_FILTER = "cycles-ending";

const ALL_CHIPS: readonly DisplayStatus[] = ["actif", "avance", "termine"] as const;

const CHIP_I18N_KEY: Record<
  DisplayStatus,
  "members.filter_actif" | "members.filter_avance" | "members.filter_termine"
> = {
  actif: "members.filter_actif",
  avance: "members.filter_avance",
  termine: "members.filter_termine",
};

function useFilteredMembers(
  members: readonly MemberWithMeta[],
  query: string,
  selectedChips: ReadonlySet<DisplayStatus>,
  cyclesEndingFilterActive: boolean,
): MemberWithMeta[] {
  return useMemo(() => {
    const normalizedQuery = normalizeForSearch(query.trim());
    return members.filter((m) => {
      if (selectedChips.size > 0 && !selectedChips.has(m.displayStatus)) return false;
      if (cyclesEndingFilterActive) {
        // Story 3.5 — keep only members whose cycle is in the upcoming-end
        // window. Members without an active cycle are excluded.
        if (m.currentCycle === null) return false;
        if (
          !isCycleInUpcomingEndWindow(m.currentCycle.dayNumber, DEFAULT_CYCLE_ENDING_WINDOW_DAYS)
        ) {
          return false;
        }
      }
      if (normalizedQuery === "") return true;
      return normalizeForSearch(m.name).includes(normalizedQuery);
    });
  }, [members, query, selectedChips, cyclesEndingFilterActive]);
}

export function MemberList(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { data: members, isLoading, isError } = useMembers();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selectedChips, setSelectedChips] = useState<ReadonlySet<DisplayStatus>>(
    () => new Set<DisplayStatus>(),
  );
  // Story 4.1 — card tap opens the action sheet (was: navigate to profile).
  // Profile access lives inside the sheet via "Voir profil".
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  // Story 4.3 — Flow 1 online commit path.
  const recordContribution = useRecordContribution();
  const queryClient = useQueryClient();
  // Story 3.5 — URL-driven cycles-ending filter (entry point: dashboard alert
  // CTA). When set, filters the list to members whose cycle ends within the
  // default window. Composes with the chip filters via AND.
  const [searchParams, setSearchParams] = useSearchParams();
  const cyclesEndingFilterActive = searchParams.get("filter") === CYCLES_ENDING_FILTER;

  const filtered = useFilteredMembers(
    members ?? [],
    deferredQuery,
    selectedChips,
    cyclesEndingFilterActive,
  );
  const activeMember = activeMemberId
    ? ((members ?? []).find((m) => m.id === activeMemberId) ?? null)
    : null;

  if (isLoading) return <></>;

  if (isError) {
    return (
      <section
        role="alert"
        className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4"
        aria-live="polite"
      >
        <h1 className="text-title-1 text-text-primary">{t("members.title")}</h1>
        <p className="text-body-1 text-destructive">{t("members.load_error")}</p>
      </section>
    );
  }

  if ((members ?? []).length === 0) {
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

  const toggleChip = (chip: DisplayStatus) => {
    setSelectedChips((prev) => {
      const next = new Set(prev);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });
  };

  // Story 2.2 — "Ajouter un membre" CTA placement: header button at ≤10
  // members, FAB at >10. Threshold lives in types.ts for one-line tweaks.
  // Driven by the TOTAL members count (not the filtered/search subset) so
  // the affordance doesn't flicker while the collector types.
  const useFab = (members ?? []).length > MEMBER_HEADER_CTA_THRESHOLD;

  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4"
      aria-label={t("members.title")}
    >
      <h1 className="text-title-1 text-text-primary">{t("members.title")}</h1>

      {!useFab ? (
        <Button asChild size="lg" className="w-full">
          <Link to="/members/new">{t("members.add_cta")}</Link>
        </Button>
      ) : null}

      <input
        type="search"
        inputMode="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("members.search_placeholder")}
        aria-label={t("members.search_placeholder")}
        className="w-full rounded-lg border border-hairline bg-card px-4 py-3 text-body-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      {cyclesEndingFilterActive ? (
        <button
          type="button"
          onClick={() => {
            // Story 3.5 — preserve any other URL params; only strip `filter`.
            // Future stories may add ?sort= / ?search= etc.
            const next = new URLSearchParams(searchParams);
            next.delete("filter");
            setSearchParams(next);
          }}
          aria-label={t("members.filter_cycles_ending_dismiss_aria")}
          className="inline-flex items-center gap-1 self-start rounded-full border border-warning-200 bg-warning-50 px-3 py-2 text-body-2 font-medium text-warning-800 hover:bg-warning-bg/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{t("members.filter_cycles_ending_active")}</span>
          <X size={14} aria-hidden />
        </button>
      ) : null}

      <div role="group" aria-label="Filtres" className="flex flex-wrap gap-2">
        {ALL_CHIPS.map((chip) => {
          const active = selectedChips.has(chip);
          return (
            <button
              key={chip}
              type="button"
              aria-pressed={active}
              data-chip={chip}
              onClick={() => toggleChip(chip)}
              className={cn(
                "inline-flex min-h-[44px] items-center rounded-full border px-4 text-body-2 font-medium transition-colors",
                active
                  ? "border-primary-500 bg-primary-500 text-primary-foreground"
                  : "border-hairline bg-card text-text-primary hover:bg-primary-50",
              )}
            >
              {t(CHIP_I18N_KEY[chip])}
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-2 py-8 text-center">
          <p className="text-title-2 text-text-primary">{t("members.no_search_match_headline")}</p>
          <p className="text-body-2 text-text-secondary">{t("members.no_search_match_subtext")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("members.title")}>
          {filtered.map((member) => (
            <li key={member.id}>
              <MemberCard member={member} onSelect={(memberId) => setActiveMemberId(memberId)} />
            </li>
          ))}
        </ul>
      )}

      {useFab ? (
        <Link
          to="/members/new"
          aria-label={t("members.add_cta")}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary-500 text-primary-foreground shadow-lg hover:bg-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 [padding-bottom:env(safe-area-inset-bottom)]"
        >
          <Plus size={24} aria-hidden />
        </Link>
      ) : null}

      {activeMember ? (
        <MemberActionSheet
          open={true}
          onOpenChange={(next) => {
            if (!next) setActiveMemberId(null);
          }}
          member={{
            id: activeMember.id,
            name: activeMember.name,
            dailyAmount: activeMember.dailyAmount,
          }}
          currentCycle={
            activeMember.currentCycle
              ? {
                  status:
                    activeMember.displayStatus === "avance"
                      ? "with_advance"
                      : activeMember.displayStatus === "termine"
                        ? "completed"
                        : "active",
                }
              : null
          }
          onViewProfile={(id) => {
            setActiveMemberId(null);
            navigate(`/members/${id}`);
          }}
          {...(activeMember.currentCycle
            ? {
                onRecordContribution: async (memberId: string) => {
                  setActiveMemberId(null);
                  const cycle = activeMember.currentCycle!;
                  try {
                    const txId = await recordContribution.mutateAsync({
                      memberId,
                      cycleId: cycle.id,
                      amount: activeMember.dailyAmount,
                      cycleDay: cycle.dayNumber,
                    });
                    showContributionToast({
                      memberName: activeMember.name,
                      onUndo: () => {
                        void undoTransaction(txId, queryClient);
                      },
                    });
                  } catch {
                    // RecordContributionError is surfaced by the hook;
                    // a future PR can wire toast.error() with mapped copy.
                  }
                },
              }
            : {})}
        />
      ) : null}
    </section>
  );
}
