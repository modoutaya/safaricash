// React Router v7 data-router config.
//
// Structure:
//   /
//   ├── /login                     (public, LoginRoute — phone + password)
//   └── (ProtectedRoute)
//       └── AppLayout (<Outlet>)
//           ├── /dashboard         (Story 9.1 placeholder)
//           ├── /members           (EmptyState when count=0; Story 2.1 extends)
//           ├── /members/new       (Story 2.2 placeholder)
//           └── /settings          (Plus tab; Story 1.7 sign-out)
//
// /non-registered was removed in Story 1.5b (PRD v1.3 auth pivot):
// signInWithPassword returns invalid_credentials for both unregistered
// phones and wrong passwords — a stronger property than the prior
// registration-existence oracle. Forgot-password users follow the inline
// "Mot de passe oublié ?" tel: link on /login.

import { createBrowserRouter, Navigate } from "react-router-dom";

import AppLayout from "@/App";
import { ProtectedRoute } from "@/app/guards";
import { RouterRoot } from "@/app/providers";
import DashboardRoute from "@/app/routes/dashboard";
import JournalRoute from "@/app/routes/journal";
import LoginRoute from "@/app/routes/login";
import MembersRoute from "@/app/routes/members";
import MemberProfileRoute from "@/app/routes/members/[id]";
import MemberAdvanceRoute from "@/app/routes/members/[id].advance";
import MemberEditRoute from "@/app/routes/members/[id].edit";
import MemberSettlementRoute from "@/app/routes/members/[id].settlement";
import MemberTransactionRoute from "@/app/routes/members/[id].transaction";
import MembersImportRoute from "@/app/routes/members/import";
import MembersNewRoute from "@/app/routes/members/new";
import SettingsRoute from "@/app/routes/settings";

export const router = createBrowserRouter([
  {
    element: <RouterRoot />,
    children: [
      { path: "/login", element: <LoginRoute /> },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { index: true, element: <Navigate to="/dashboard" replace /> },
              { path: "dashboard", element: <DashboardRoute /> },
              { path: "members", element: <MembersRoute /> },
              { path: "members/new", element: <MembersNewRoute /> },
              { path: "members/import", element: <MembersImportRoute /> },
              // Story 2.4 — :id is registered AFTER the static /new + /import
              // paths so React Router matches the literals first. Story 2.5
              // adds :id/edit AFTER :id; React Router prefers the longer
              // static segment ("edit") over a bare param.
              { path: "members/:id", element: <MemberProfileRoute /> },
              { path: "members/:id/edit", element: <MemberEditRoute /> },
              // Story 5.2 — advance flow lives at /members/:id/advance.
              { path: "members/:id/advance", element: <MemberAdvanceRoute /> },
              // Story 7.3 — settlement preview lives at /members/:id/settlement.
              { path: "members/:id/settlement", element: <MemberSettlementRoute /> },
              // Story 4.6 — full-page transaction flow (replaces MemberActionSheet).
              { path: "members/:id/transaction", element: <MemberTransactionRoute /> },
              // Story 12.1 — Journal tab (4th BottomNav item).
              { path: "journal", element: <JournalRoute /> },
              { path: "settings", element: <SettingsRoute /> },
            ],
          },
        ],
      },
      // Catch-all: funnel unknown paths back to login.
      { path: "*", element: <Navigate to="/login" replace /> },
    ],
  },
]);
