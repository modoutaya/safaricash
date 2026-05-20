// Story 12.1 — Journal page: per-member transaction history with period
// selector, name search, 20-per-page pagination, lazy-loaded sections.
//
// Spec: _bmad-output/implementation-artifacts/12-1-journal-tab.md

import { useDeferredValue, useState } from "react";

import { useT } from "@/i18n/useT";

import { DEFAULT_JOURNAL_PERIOD, type JournalPeriod } from "../api/period";
import { deriveJournalListView } from "../api/sortFilterPaginate";
import { useJournalMembers } from "../api/useJournalMembers";
import { JournalMemberSection } from "./JournalMemberSection";
import { JournalPeriodSelector } from "./JournalPeriodSelector";

export function JournalPage(): JSX.Element {
  const t = useT();
  const [period, setPeriod] = useState<JournalPeriod>(DEFAULT_JOURNAL_PERIOD);
  const [searchQuery, setSearchQuery] = useState("");
  const [pageCount, setPageCount] = useState(1);
  // Defer the input so each keystroke doesn't re-filter the entire list
  // — matches the MemberList pattern.
  const deferredQuery = useDeferredValue(searchQuery);

  const { data: members, isLoading, error } = useJournalMembers();

  return (
    <main className="mx-auto flex w-full max-w-screen-sm flex-col gap-4 px-4 py-4">
      <header className="flex flex-col gap-3">
        <h1 className="text-headline text-text-primary">{t("journal.title")}</h1>
        <JournalPeriodSelector value={period} onChange={setPeriod} />
        <input
          type="search"
          inputMode="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("journal.search_placeholder")}
          aria-label={t("journal.search_placeholder")}
          className="w-full rounded-lg border border-hairline bg-card px-4 py-3 text-body-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </header>

      {isLoading ? (
        <p className="text-body-2 text-text-secondary">{t("journal.loading_members")}</p>
      ) : error ? (
        <p className="text-body-2 text-warning-text">{t("journal.error_members")}</p>
      ) : !members || members.length === 0 ? (
        <p className="text-body-2 text-text-secondary">{t("journal.empty_no_members")}</p>
      ) : (
        <JournalMemberList
          members={members}
          period={period}
          searchQuery={deferredQuery}
          pageCount={pageCount}
          onLoadMore={() => setPageCount((n) => n + 1)}
        />
      )}
    </main>
  );
}

interface JournalMemberListProps {
  members: ReturnType<typeof useJournalMembers>["data"];
  period: JournalPeriod;
  searchQuery: string;
  pageCount: number;
  onLoadMore: () => void;
}

function JournalMemberList({
  members,
  period,
  searchQuery,
  pageCount,
  onLoadMore,
}: JournalMemberListProps): JSX.Element {
  const t = useT();
  if (!members) return <></>;
  const view = deriveJournalListView(members, searchQuery, pageCount);

  if (view.visible.length === 0) {
    return (
      <p className="text-body-2 text-text-secondary">
        {view.searchActive ? t("journal.no_search_match") : t("journal.empty_no_members")}
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {view.visible.map((member) => (
          <li key={member.id}>
            <JournalMemberSection member={member} period={period} />
          </li>
        ))}
      </ul>
      {view.canLoadMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          className="self-center rounded-full border border-hairline bg-card px-6 py-2 text-body-2 font-medium text-primary-700 hover:bg-primary-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("journal.show_more")}
        </button>
      ) : null}
    </>
  );
}
