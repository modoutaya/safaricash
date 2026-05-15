// Story 8.6 / FR40 — "data viewed offline" indicator.
//
// A subtle, calm note shown on the member list + profile while the device
// is offline: the data on screen comes from the persisted local cache, not
// a live server read. Consistent with the UX "offline-as-empowerment" /
// "never a red alarm" invariant — secondary text, no colour alarm.
//
// Renders nothing while online (the data IS live then).
//
// See: epics.md:1253-1265 (Story 8.6 BDD — "data viewed offline carries a
// subtle 'Données locales — synchronisation en attente' note").

import { useConnectivityState } from "@/features/connectivity/api/useConnectivityState";
import { useT } from "@/i18n/useT";

export function LocalDataNote(): JSX.Element | null {
  const { online } = useConnectivityState();
  const t = useT();

  if (online) return null;

  return (
    <p role="status" aria-live="polite" className="text-caption text-text-secondary">
      {t("members.local_data_note")}
    </p>
  );
}
