// Story 12.1 — /journal route. Per-member transaction history with a
// period selector (2 derniers jours / cycle en cours / cycle précédent),
// name search, lazy-loaded sections, and 20-per-page pagination.
//
// Spec: _bmad-output/implementation-artifacts/12-1-journal-tab.md
//
// The route is a thin wrapper around JournalPage (src/features/journal/ui)
// so the page logic is testable in isolation.

import { JournalPage } from "@/features/journal";

export default function JournalRoute(): JSX.Element {
  return <JournalPage />;
}
