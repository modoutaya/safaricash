// InstallAppButton tests.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { InstallAppButton } from "./InstallAppButton";

expect.extend(toHaveNoViolations);

/** Dispatch a synthetic Chromium `beforeinstallprompt` event. */
function fireBeforeInstallPrompt(): ReturnType<typeof vi.fn> {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const evt = new Event("beforeinstallprompt");
  Object.assign(evt, { prompt, userChoice: Promise.resolve({ outcome: "accepted" }) });
  window.dispatchEvent(evt);
  return prompt;
}

describe("InstallAppButton", () => {
  it("renders nothing until the browser reports installability", () => {
    render(<InstallAppButton />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the install button after beforeinstallprompt fires", async () => {
    render(<InstallAppButton />);
    fireBeforeInstallPrompt();
    expect(
      await screen.findByRole("button", { name: /installer l'application/i }),
    ).toBeInTheDocument();
  });

  it("calls the native prompt on click, then hides itself", async () => {
    render(<InstallAppButton />);
    const prompt = fireBeforeInstallPrompt();
    fireEvent.click(await screen.findByRole("button", { name: /installer l'application/i }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("hides when the app reports it was installed", async () => {
    render(<InstallAppButton />);
    fireBeforeInstallPrompt();
    await screen.findByRole("button", { name: /installer l'application/i });
    window.dispatchEvent(new Event("appinstalled"));
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("axe-clean when visible", async () => {
    const { container } = render(<InstallAppButton />);
    fireBeforeInstallPrompt();
    await screen.findByRole("button", { name: /installer l'application/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
