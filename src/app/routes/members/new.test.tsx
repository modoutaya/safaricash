// Story 2.2 — /members/new route smoke test.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/infrastructure/supabase/client", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
  },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import MembersNewRoute from "./new";

function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/members/new"]}>
        <Routes>
          <Route path="/members/new" element={<MembersNewRoute />} />
          <Route path="/members" element={<div data-testid="members-list">Members</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MembersNewRoute", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    toastSuccess.mockReset();
  });

  it("mounts the MemberForm with the Nouveau membre heading", () => {
    renderRoute();
    expect(screen.getByRole("heading", { level: 1, name: /nouveau membre/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Nom")).toBeInTheDocument();
  });

  it("navigates to /members and fires success toast on valid submit", async () => {
    rpcMock.mockResolvedValue({ data: "member-uuid", error: null });
    renderRoute();

    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Aminata Kane" } });
    fireEvent.change(screen.getByLabelText("Numéro de téléphone"), {
      target: { value: "+221777915898" },
    });
    fireEvent.change(screen.getByLabelText("Cotisation quotidienne (FCFA)"), {
      target: { value: "300" },
    });
    const cta = screen.getByRole("button", { name: /ajouter ce membre/i });
    await waitFor(() => expect(cta).toBeEnabled());
    fireEvent.click(cta);

    await waitFor(() => expect(screen.getByTestId("members-list")).toBeInTheDocument());
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Aminata Kane"));
  });

  it("Annuler button navigates to /members without calling RPC", () => {
    renderRoute();
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(screen.getByTestId("members-list")).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
