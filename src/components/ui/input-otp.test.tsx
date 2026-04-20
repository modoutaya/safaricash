import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

function Harness({ value = "" }: { value?: string }) {
  return (
    <InputOTP maxLength={6} value={value} onChange={() => {}}>
      <InputOTPGroup>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

describe("InputOTP (re-skinned)", () => {
  it("renders 6 slots, each with a digit-position aria-label", () => {
    render(<Harness />);
    for (let i = 1; i <= 6; i++) {
      expect(screen.getByLabelText(`Chiffre ${i} du code`)).toBeInTheDocument();
    }
  });

  it("echoes the controlled value into the slots", () => {
    render(<Harness value="123456" />);
    // input-otp keeps the native <input> invisible; chars surface inside each slot.
    for (const char of "123456") {
      expect(screen.getAllByText(char).length).toBeGreaterThan(0);
    }
  });

  it("does NOT leak oklch() CSS values into the rendered DOM (tokens not hex rule)", () => {
    const { container } = render(<Harness />);
    const html = container.innerHTML;
    expect(html).not.toContain("oklch(");
  });
});
