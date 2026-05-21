// Story 7.2 — EnvelopeHandoverScreen component tests.
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnvelopeHandoverScreen } from "./EnvelopeHandoverScreen";

expect.extend(toHaveNoViolations);

const baseProps = {
  memberName: "Awa Diallo",
  payoutAmount: 87_000,
  recipientPhone: "+221 77 123 45 67",
  onReturnToMembers: vi.fn(),
};

describe("EnvelopeHandoverScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders icon, h2 headline, body, subtext, and CTA — no h1", () => {
    const { container } = render(<EnvelopeHandoverScreen {...baseProps} />);
    // Check icon circle is present + contains an SVG (lucide Check) — AC #1.1
    const iconCircle = container.querySelector(".rounded-full");
    expect(iconCircle).toBeInTheDocument();
    expect(iconCircle?.querySelector("svg")).toBeInTheDocument();
    // h2 headline
    expect(
      screen.getByRole("heading", { level: 2, name: /Paiement effectué/ }),
    ).toBeInTheDocument();
    // body sentence contains amount + name
    expect(screen.getByText(/Remettez/)).toBeInTheDocument();
    expect(screen.getByText(/Awa Diallo/)).toBeInTheDocument();
    // CTA
    expect(screen.getByRole("button", { name: /Retour aux membres/ })).toBeInTheDocument();
    // subtext (sent state by default) — phone interpolated
    expect(screen.getByText(/\+221 77 123 45 67/)).toBeInTheDocument();
    expect(screen.getByText(/récapitulatif final/)).toBeInTheDocument();
    // NO h1 — route owns the page-level heading (AC #7)
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("body interpolation — payoutAmount=87000 + memberName='Awa' → 'Remettez 87 000 FCFA à Awa.'", () => {
    const { container } = render(
      <EnvelopeHandoverScreen {...baseProps} memberName="Awa" payoutAmount={87_000} />,
    );
    // Sentence body — match the full string with NBSP tolerance
    const text = container.textContent ?? "";
    expect(text).toMatch(/Remettez\s87[\s\u00a0]000\sFCFA\sà\sAwa\./);
  });

  it("amount span uses formatFcfaAmount — payoutAmount=87000 → '87 000' (NBSP)", () => {
    render(<EnvelopeHandoverScreen {...baseProps} payoutAmount={87_000} />);
    expect(screen.getByText(/87[\s\u00a0]000/)).toBeInTheDocument();
  });

  it("smsState defaults to 'sent' — subtext renders phone, no spinner", () => {
    const { container } = render(
      <EnvelopeHandoverScreen {...baseProps} recipientPhone="+221 77 000 00 00" />,
    );
    expect(screen.getByText(/\+221 77 000 00 00/)).toBeInTheDocument();
    // No spinner present
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("smsState='pending' — subtext shows 'Envoi du récapitulatif…' + Loader2 spinner, no phone in subtext", () => {
    const { container } = render(<EnvelopeHandoverScreen {...baseProps} smsState="pending" />);
    expect(screen.getByText(/Envoi du récapitulatif…/)).toBeInTheDocument();
    // Loader2 spinner present
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    // Phone not interpolated in pending state
    expect(screen.queryByText(/\+221 77 123 45 67/)).not.toBeInTheDocument();
  });

  it("recipientPhone=null — subtext slot is entirely absent; rest of anatomy still renders", () => {
    render(<EnvelopeHandoverScreen {...baseProps} recipientPhone={null} />);
    // Anatomy renders
    expect(
      screen.getByRole("heading", { level: 2, name: /Paiement effectué/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retour aux membres/ })).toBeInTheDocument();
    // NO subtext copy at all (AC #4 / spec § 6 — no-phone savers must not see a fake SMS claim)
    expect(screen.queryByText(/récapitulatif/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Envoi/)).not.toBeInTheDocument();
  });

  it("CTA callback — clicking 'Retour aux membres' fires onReturnToMembers() with no args", () => {
    const onReturnToMembers = vi.fn();
    render(<EnvelopeHandoverScreen {...baseProps} onReturnToMembers={onReturnToMembers} />);
    fireEvent.click(screen.getByRole("button", { name: /Retour aux membres/ }));
    expect(onReturnToMembers).toHaveBeenCalledTimes(1);
    expect(onReturnToMembers).toHaveBeenCalledWith();
  });

  it("focus lands on the CTA after mount (programmatic focus, not autoFocus)", () => {
    render(<EnvelopeHandoverScreen {...baseProps} />);
    const cta = screen.getByRole("button", { name: /Retour aux membres/ });
    expect(document.activeElement).toBe(cta);
  });

  it("aria-live='polite' is on the subtext container only — never on icon/headline/body/CTA", () => {
    const { container } = render(<EnvelopeHandoverScreen {...baseProps} />);
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]?.textContent ?? "").toMatch(/récapitulatif/);
  });

  it("aria-live container disappears when recipientPhone=null", () => {
    const { container } = render(<EnvelopeHandoverScreen {...baseProps} recipientPhone={null} />);
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
  });

  it("recipientPhone=null + smsState='pending' — null wins over pending; subtext + spinner both absent", () => {
    // AC #4 — `null` overrides every smsState value; no fake SMS claim for no-phone savers.
    const { container } = render(
      <EnvelopeHandoverScreen {...baseProps} recipientPhone={null} smsState="pending" />,
    );
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText(/récapitulatif/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Envoi/)).not.toBeInTheDocument();
  });

  it("axe-clean across 3 subtext configurations: sent+phone / pending+phone / no-phone", async () => {
    const cases = [
      { recipientPhone: "+221 77 123 45 67", smsState: "sent" as const },
      { recipientPhone: "+221 77 123 45 67", smsState: "pending" as const },
      { recipientPhone: null },
    ];
    for (const c of cases) {
      const { container, unmount } = render(<EnvelopeHandoverScreen {...baseProps} {...c} />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
