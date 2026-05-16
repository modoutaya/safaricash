// Story 10.3 — DisputeInlineBanner tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { DisputeInlineBanner } from "./DisputeInlineBanner";

expect.extend(toHaveNoViolations);

describe("DisputeInlineBanner", () => {
  it("renders an sr-only empty region when count is 0", () => {
    render(<DisputeInlineBanner count={0} onViewDetail={vi.fn()} />);
    const region = screen.getByTestId("dispute-banner");
    expect(region).toBeInTheDocument();
    expect(region).toHaveClass("sr-only");
    expect(screen.queryByText(/contestée/i)).not.toBeInTheDocument();
  });

  it("renders the banner with singular copy + CTA when count is 1", () => {
    render(<DisputeInlineBanner count={1} onViewDetail={vi.fn()} />);
    expect(screen.getByText("Transaction contestée")).toBeInTheDocument();
    expect(screen.getByText(/a contesté une transaction/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /voir le détail/i })).toBeInTheDocument();
  });

  it("renders count-aware plural copy when count > 1", () => {
    render(<DisputeInlineBanner count={3} onViewDetail={vi.fn()} />);
    expect(screen.getByText(/a contesté 3 transactions/i)).toBeInTheDocument();
  });

  it("tapping the CTA calls onViewDetail", () => {
    const onViewDetail = vi.fn();
    render(<DisputeInlineBanner count={2} onViewDetail={onViewDetail} />);
    fireEvent.click(screen.getByRole("button", { name: /voir le détail/i }));
    expect(onViewDetail).toHaveBeenCalledTimes(1);
  });

  it("is axe-clean", async () => {
    const { container } = render(<DisputeInlineBanner count={2} onViewDetail={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
