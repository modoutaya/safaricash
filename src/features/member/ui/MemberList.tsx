// Story 2.1 — /members list UI.
//
// State machine:
//   loading  → render null (no skeleton at MVP; pages come in fast enough
//              that a skeleton flash would be more distracting than empty).
//   error    → load_error copy.
//   success + 0 members        → EmptyState ("ajouter mon premier membre").
//   success + search no match  → no_search_match_headline / subtext.
//   success + ≥1 member        → search box + filter chips + card list.
//
// Story 4.6 — tapping a member card navigates to the full-page
// /members/:id/transaction flow (replaced the MemberActionSheet modal).
// When the list is opened with `?intent=advance` (the dashboard's "Prêt
// Express" shortcut), the tap lands on /members/:id/advance instead.

import { Plus, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { EmptyState } from "@/components/domain/EmptyState";
import { Button } from "@/components/ui/button";
import { DEFAULT_CYCLE_ENDING_WINDOW_DAYS, isCycleInUpcomingEndWindow } from "@/domain/cycle";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

import { normalizeForSearch } from "../api/normalizeForSearch";
import { useMembers } from "../api/useMembers";
import { MEMBER_HEADER_CTA_THRESHOLD, type DisplayStatus, type MemberWithMeta } from "../types";
import { LocalDataNote } from "./LocalDataNote";
import { MemberCard } from "./MemberCard";

const CYCLES_ENDING_FILTER = "cycles-ending";

/** Story 12.4 — virtual chip value for "À régler". Not a DisplayStatus
 *  (a member can simultaneously be 'actif' AND have a cycle awaiting
 *  settlement post-Phase-B cron). Treated as an additional OR term in
 *  the chip filter. */
const TO_SETTLE_CHIP = "a_regler" as const;
/** 2026-05-23 — "Déjà payés" virtual chip. Same shape as TO_SETTLE_CHIP
 *  (not a displayStatus): matches members with a non-null lastSettlementAt
 *  AND no awaiting cycle. Sits next to TO_SETTLE so the action-required /
 *  done pair reads together. */
const SETTLED_CHIP = "deja_paye" as const;
type ChipValue = DisplayStatus | typeof TO_SETTLE_CHIP | typeof SETTLED_CHIP;

const ALL_CHIPS: readonly ChipValue[] = [
  "actif",
  "avance",
  TO_SETTLE_CHIP,
  SETTLED_CHIP,
  "termine",
] as const;

const CHIP_I18N_KEY: Record<
  ChipValue,
  | "members.filter_actif"
  | "members.filter_avance"
  | "members.filter_termine"
  | "members.filter_a_regler"
  | "members.filter_deja_paye"
> = {
  actif: "members.filter_actif",
  avance: "members.filter_avance",
  termine: "members.filter_termine",
  [TO_SETTLE_CHIP]: "members.filter_a_regler",
  [SETTLED_CHIP]: "members.filter_deja_paye",
};

function useFilteredMembers(
  members: readonly MemberWithMeta[],
  query: string,
  selectedChips: ReadonlySet<ChipValue>,
  cyclesEndingFilterActive: boolean,
): MemberWithMeta[] {
  return useMemo(() => {
    const normalizedQuery = normalizeForSearch(query.trim());
    return members.filter((m) => {
      if (selectedChips.size > 0) {
        // OR-logic across chips. "À régler" matches awaitingSettlement!=null;
        // "Déjà payés" matches lastSettlementAt!=null AND awaitingSettlement==null
        // (mirrors the MemberCard badge condition — a member who was paid
        // last cycle but now has a new pending cycle counts as "À régler",
        // not "Déjà payés"); the others match displayStatus equality.
        const matches =
          // Loose `!= null` catches BOTH null AND undefined. The latter
          // shows up on stale TanStack-persisted MemberWithMeta objects
          // from before Story 12.4 (Story 8.6 IndexedDB cache rehydrates
          // the pre-12.4 shape on first paint, which is missing this
          // field). Crash repro 2026-05-21.
          (selectedChips.has(TO_SETTLE_CHIP) && m.awaitingSettlement != null) ||
          (selectedChips.has(SETTLED_CHIP) &&
            m.lastSettlementAt != null &&
            m.awaitingSettlement == null) ||
          selectedChips.has(m.displayStatus);
        if (!matches) return false;
      }
      if (cyclesEndingFilterActive) {
        // Story 3.5 — keep only members whose cycle is in the upcoming-end
        // window. Members without an active cycle are excluded.
        if (m.currentCycle === null) return false;
        if (
          !isCycleInUpcomingEndWindow(
            m.currentCycle.dayNumber,
            DEFAULT_CYCLE_ENDING_WINDOW_DAYS,
            m.currentCycle.cycleLength,
          )
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
  const [selectedChips, setSelectedChips] = useState<ReadonlySet<ChipValue>>(
    () => new Set<ChipValue>(),
  );
  // Story 3.5 — URL-driven cycles-ending filter (entry point: dashboard alert
  // CTA). When set, filters the list to members whose cycle ends within the
  // default window. Composes with the chip filters via AND.
  const [searchParams, setSearchParams] = useSearchParams();
  const cyclesEndingFilterActive = searchParams.get("filter") === CYCLES_ENDING_FILTER;
  // `?intent=advance` (dashboard "Prêt Express" shortcut) routes the
  // member tap to the advance page; otherwise the transaction page.
  const memberTapTarget = searchParams.get("intent") === "advance" ? "advance" : "transaction";

  const filtered = useFilteredMembers(
    members ?? [],
    deferredQuery,
    selectedChips,
    cyclesEndingFilterActive,
  );

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

  const toggleChip = (chip: ChipValue) => {
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
      <LocalDataNote />

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
            const next = new URLSearchParams(searchParams);
            next.delete("filter");
            setSearchParams(next);
          }}
          aria-label={t("members.filter_cycles_ending_dismiss_aria")}
          className="inline-flex items-center gap-1 self-start rounded-full border border-warning bg-warning-bg px-3 py-2 text-body-2 font-medium text-warning-text hover:bg-warning/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <MemberCard
                member={member}
                onSelect={(memberId) => navigate(`/members/${memberId}/${memberTapTarget}`)}
              />
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
    </section>
  );
}
