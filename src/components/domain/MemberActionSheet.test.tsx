// Story 4.1 — MemberActionSheet component tests.
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemberActionSheet, type MemberActionSheetProps } from "./MemberActionSheet";

expect.extend(toHaveNoViolations);

// jsdom doesn't implement <dialog>'s showModal/close natively. Stub them so
// the open/close useEffect doesn't throw — matches the pattern from
// RestartCycleDialog.test.tsx (Story 2.7).
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const MEMBER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Awa Diallo",
  dailyAmount: 5000,
};

function renderSheet(overrides: Partial<MemberActionSheetProps> = {}) {
  const onOpenChange = vi.fn();
  const onViewProfile = vi.fn();
  // Build props by spreading overrides last so omitted optional handlers
  // truly stay omitted (exactOptionalPropertyTypes rejects explicit undefined).
  const props: MemberActionSheetProps = {
    open: overrides.open ?? true,
    onOpenChange,
    member: overrides.member ?? MEMBER,
    currentCycle: overrides.currentCycle ?? { status: "active" },
    onViewProfile: overrides.onViewProfile ?? onViewProfile,
    ...overrides,
  };
  const utils = render(<MemberActionSheet {...props} />);
  return { ...utils, onOpenChange, onViewProfile };
}

describe("MemberActionSheet", () => {
  it("renders the header (avatar + name) and a primary CTA with the formatted amount", () => {
    renderSheet();
    expect(screen.getByRole("heading", { level: 2, name: /awa diallo/i })).toBeInTheDocument();
    // 5000 → "5 000 FCFA" (NBSP separator from Intl.NumberFormat fr-FR).
    expect(
      screen.getByRole("button", { name: /enregistrer cotisation — 5[\s\u00a0]000 FCFA/i }),
    ).toBeInTheDocument();
  });

  it("renders the 4 secondary CTAs (Rattrapage / Prêt / Montant personnalisé / Voir profil)", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: /^rattrapage$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^prêt$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^montant personnalisé$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^voir profil$/i })).toBeInTheDocument();
  });

  it("primary CTA is disabled when onRecordContribution is omitted (Story 4.1 default)", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: /enregistrer cotisation/i })).toBeDisabled();
  });

  it("primary CTA is enabled + calls onRecordContribution + closes when handler is provided", () => {
    const onRecordContribution = vi.fn();
    const { onOpenChange } = renderSheet({ onRecordContribution });
    const cta = screen.getByRole("button", { name: /enregistrer cotisation/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onRecordContribution).toHaveBeenCalledWith(MEMBER.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Voir profil calls onViewProfile + closes the sheet", () => {
    const { onOpenChange, onViewProfile } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /^voir profil$/i }));
    expect(onViewProfile).toHaveBeenCalledWith(MEMBER.id);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the closed-cycle banner + disables transaction CTAs (Voir profil stays enabled) when status=completed", () => {
    const onRecordContribution = vi.fn();
    renderSheet({
      currentCycle: { status: "completed" },
      onRecordContribution,
      onRattrapage: vi.fn(),
      onAdvance: vi.fn(),
      onCustomAmount: vi.fn(),
    });
    expect(screen.getByText(/le cycle est clôturé/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /enregistrer cotisation/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^rattrapage$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^prêt$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^montant personnalisé$/i })).toBeDisabled();
    // Voir profil MUST stay enabled — user needs to reach the profile to restart.
    expect(screen.getByRole("button", { name: /^voir profil$/i })).toBeEnabled();
  });

  it("closed-cycle banner does NOT render when currentCycle is null", () => {
    renderSheet({ currentCycle: null });
    expect(screen.queryByText(/le cycle est clôturé/i)).not.toBeInTheDocument();
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderSheet({
      onRecordContribution: vi.fn(),
      onRattrapage: vi.fn(),
      onAdvance: vi.fn(),
      onCustomAmount: vi.fn(),
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
