// Story 9.1 / FR34 — the dashboard's "recent activity" list (5 newest).
//
// Pure presentation. `now` is a ms timestamp the caller supplies (the
// dashboard query's dataUpdatedAt) so relative-time labels stay
// react-hooks-pure — no Date.now() / new Date() during render.

import type { MemberWithMeta } from "@/features/member";
import { formatFcfaAmount } from "@/features/member/api/formatAmount";
import { useT } from "@/i18n/useT";

import type { DashboardActivity } from "../api/deriveDashboardStats";

export interface RecentActivityProps {
  activity: DashboardActivity[];
  members: MemberWithMeta[];
  /** ms timestamp used as the "now" reference for relative-time labels. */
  now: number;
}

function kindKey(kind: string): string {
  switch (kind) {
    case "contribution":
      return "dashboard.activity.kind_contribution";
    case "advance":
      return "dashboard.activity.kind_advance";
    case "rattrapage":
      return "dashboard.activity.kind_rattrapage";
    default:
      return "dashboard.activity.kind_other";
  }
}

export function RecentActivity({ activity, members, now }: RecentActivityProps): JSX.Element {
  const t = useT();

  const memberName = (memberId: string): string =>
    members.find((m) => m.id === memberId)?.name ?? t("dashboard.activity.member_fallback");

  const recordedLabel = (createdAt: string): string => {
    if (now === 0) return t("dashboard.activity.time_just_now");
    const minutes = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60000));
    if (minutes < 1) return t("dashboard.activity.time_just_now");
    if (minutes < 60) return t("dashboard.activity.time_minutes", { minutes });
    if (minutes < 1440)
      return t("dashboard.activity.time_hours", { hours: Math.floor(minutes / 60) });
    return t("dashboard.activity.time_days", { days: Math.floor(minutes / 1440) });
  };

  return (
    <section className="flex flex-col gap-2" aria-labelledby="dashboard-activity-title">
      <h2 id="dashboard-activity-title" className="text-headline-2 text-text-primary">
        {t("dashboard.activity.title")}
      </h2>
      {activity.length === 0 ? (
        <p className="text-body-2 text-text-secondary">{t("dashboard.activity.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline">
          {activity.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body-2 font-medium text-text-primary">
                  {t(kindKey(a.kind) as Parameters<typeof t>[0])} — {memberName(a.memberId)}
                </span>
                <span className="text-caption text-text-secondary">
                  {recordedLabel(a.createdAt)}
                </span>
              </span>
              <span
                className="shrink-0 text-body-2 font-medium text-text-primary"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatFcfaAmount(a.amount)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
