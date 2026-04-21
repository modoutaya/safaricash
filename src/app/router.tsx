// Story 1.5 — React Router v7 data-router config.
//
// Structure:
//   /
//   ├── /login                     (public, LoginRoute)
//   ├── /non-registered            (public, NonRegisteredRoute)
//   └── (ProtectedRoute)
//       └── AppLayout (<Outlet>)
//           ├── /dashboard         (Story 9.1 placeholder)
//           ├── /members           (EmptyState when count=0; Story 2.1 extends)
//           ├── /members/new       (Story 2.2 placeholder)
//           └── /settings          (Plus tab; Story 1.7 sign-out)
//
// React Router v7 data-router (`createBrowserRouter`) is the committed API
// per architecture.md; legacy <BrowserRouter> is an anti-pattern here.

import { createBrowserRouter, Navigate } from "react-router-dom";

import AppLayout from "@/App";
import { ProtectedRoute } from "@/app/guards";
import { RouterRoot } from "@/app/providers";
import DashboardRoute from "@/app/routes/dashboard";
import LoginRoute from "@/app/routes/login";
import MembersRoute from "@/app/routes/members";
import MembersNewRoute from "@/app/routes/members/new";
import NonRegisteredRoute from "@/app/routes/non-registered";
import SettingsRoute from "@/app/routes/settings";

export const router = createBrowserRouter([
  {
    element: <RouterRoot />,
    children: [
      { path: "/login", element: <LoginRoute /> },
      { path: "/non-registered", element: <NonRegisteredRoute /> },
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
              { path: "settings", element: <SettingsRoute /> },
            ],
          },
        ],
      },
      // Catch-all: funnel unknown paths back to login. Session-required
      // routes that don't match a child path would 404 — funneling keeps
      // the UX forgiving at MVP.
      { path: "*", element: <Navigate to="/login" replace /> },
    ],
  },
]);
