import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "@/App";

describe("App (smoke test)", () => {
  it("renders the SafariCash brand title", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /safaricash/i, level: 1 })).toBeInTheDocument();
  });
});
