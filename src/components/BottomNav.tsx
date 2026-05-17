// Bottom navigation — the app-shell tab bar deferred by Story 1.7's
// router note ("the 4-tab nav is deferred to a dedicated UI story").
//
// Rendered by AppLayout under every protected route. Sticky to the
// viewport bottom; the active tab carries a green top-border + green
// icon/label (semantic-colour active state, never a red alarm).
//
// Visual reference: 03-mockups.html .bnav / .bt.

import { LayoutGrid, MoreHorizontal, Users } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { NavLink } from "react-router-dom";

import type { TranslationKey } from "@/i18n/keys";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  labelKey: TranslationKey;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { to: "/dashboard", labelKey: "nav.dashboard", Icon: LayoutGrid },
  { to: "/members", labelKey: "nav.members", Icon: Users },
  { to: "/settings", labelKey: "nav.more", Icon: MoreHorizontal },
];

export function BottomNav(): JSX.Element {
  const t = useT();
  return (
    <nav
      aria-label={t("nav.label")}
      className="sticky bottom-0 z-10 flex border-t border-hairline bg-surface-1 pb-2"
    >
      {NAV_ITEMS.map(({ to, labelKey, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "flex flex-1 flex-col items-center gap-1 border-t-[3px] px-1 pb-2 pt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500",
              isActive
                ? "border-primary-500 text-primary-500"
                : "border-transparent text-text-tertiary",
            )
          }
        >
          <Icon aria-hidden className="h-5 w-5 shrink-0" />
          <span className="text-overline">{t(labelKey)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
