import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";

import { EmptyState } from "@/components/domain/EmptyState";

expect.extend(toHaveNoViolations);

function renderDefault(onCta = vi.fn()) {
  return render(
    <EmptyState
      emoji="🦁"
      headline="Aucun membre pour l'instant"
      subtext="Ajoutez votre premier membre pour démarrer votre cycle."
      ctaLabel="Ajouter mon premier membre"
      onCtaClick={onCta}
    />,
  );
}

describe("EmptyState", () => {
  it("renders a single h1 headline + subtext + CTA", () => {
    renderDefault();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Aucun membre pour l'instant");
    expect(screen.getByText(/démarrer votre cycle/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajouter mon premier membre" })).toBeInTheDocument();
  });

  it("hides the decorative emoji from assistive tech", () => {
    const { container } = renderDefault();
    const emojiNode = container.querySelector('[aria-hidden="true"]');
    expect(emojiNode).not.toBeNull();
    expect(emojiNode).toHaveTextContent("🦁");
  });

  it("calls onCtaClick when the CTA is pressed", () => {
    const handler = vi.fn();
    renderDefault(handler);
    fireEvent.click(screen.getByRole("button", { name: /ajouter/i }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("has no axe-detectable a11y violations", async () => {
    const { container } = renderDefault();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
