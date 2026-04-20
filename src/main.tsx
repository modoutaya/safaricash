import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import "@/styles/globals.css";
import { router } from "@/app/router";
import { RootProviders } from "@/app/providers";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <RootProviders>
      <RouterProvider router={router} />
    </RootProviders>
  </StrictMode>,
);
