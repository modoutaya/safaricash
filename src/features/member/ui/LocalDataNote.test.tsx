// Story 8.6 — LocalDataNote tests.

import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

const useConnectivityStateMock = vi.fn();

vi.mock("@/features/connectivity/api/useConnectivityState", () => ({
  useConnectivityState: () => useConnectivityStateMock(),
}));

import { LocalDataNote } from "./LocalDataNote";

expect.extend(toHaveNoViolations);

describe("LocalDataNote", () => {
  it("renders the 'Données locales' note when offline", () => {
    useConnectivityStateMock.mockReturnValue({ online: false });
    render(<LocalDataNote />);
    expect(screen.getByText(/Données locales — synchronisation en attente/)).toBeInTheDocument();
  });

  it("renders nothing when online", () => {
    useConnectivityStateMock.mockReturnValue({ online: true });
    const { container } = render(<LocalDataNote />);
    expect(container).toBeEmptyDOMElement();
  });

  it("axe-clean when offline", async () => {
    useConnectivityStateMock.mockReturnValue({ online: false });
    const { container } = render(<LocalDataNote />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
