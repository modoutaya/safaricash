import { render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { CycleProgressBar } from "./CycleProgressBar";

expect.extend(toHaveNoViolations);

describe("CycleProgressBar", () => {
  it("renders role=progressbar with correct ARIA values for mid-cycle", () => {
    render(<CycleProgressBar dayNumber={15} totalDays={30} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "30");
    expect(bar).toHaveAttribute("aria-valuenow", "15");
    expect(bar).toHaveAttribute("aria-label", "Jour 15 sur 30");
  });

  it("defaults totalDays to 30", () => {
    render(<CycleProgressBar dayNumber={5} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "30");
  });

  it("clamps dayNumber below 0 to 0 with dev-warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      render(<CycleProgressBar dayNumber={-5} />);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("clamps dayNumber above totalDays to totalDays with dev-warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      render(<CycleProgressBar dayNumber={42} totalDays={30} />);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("handles NaN / Infinity defensively (clamps to 0)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      render(<CycleProgressBar dayNumber={Number.NaN} />);
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    } finally {
      warn.mockRestore();
    }
  });

  it("passes axe a11y for common day values", async () => {
    for (const day of [0, 1, 15, 30]) {
      const { container, unmount } = render(<CycleProgressBar dayNumber={day} />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
      unmount();
    }
  });
});
