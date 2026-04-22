// Story 2.3 — /members/import route smoke tests.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: { rpc: vi.fn() },
}));

import MembersImportRoute from "./import";

const originalContacts = (navigator as { contacts?: unknown }).contacts;

function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/members/import"]}>
        <MembersImportRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MembersImportRoute", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    if (originalContacts === undefined) {
      delete (navigator as { contacts?: unknown }).contacts;
    } else {
      (navigator as { contacts?: unknown }).contacts = originalContacts;
    }
  });

  it("on supported browsers, renders the consent screen first", () => {
    (navigator as { contacts?: unknown }).contacts = {
      select: () => Promise.resolve([]),
    };
    renderRoute();
    expect(
      screen.getByRole("heading", { level: 1, name: /importer depuis vos contacts/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("on unsupported browsers, renders the iOS fallback screen", () => {
    delete (navigator as { contacts?: unknown }).contacts;
    renderRoute();
    expect(
      screen.getByRole("heading", { level: 1, name: /import des contacts non disponible/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ajouter manuellement/i })).toHaveAttribute(
      "href",
      "/members/new",
    );
  });
});
