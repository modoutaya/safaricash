// Story 2.5 — computeEditImpact pure-helper tests.
import { describe, expect, it } from "vitest";

import { computeEditImpact } from "./computeEditImpact";
import type { CreateMemberInput } from "../types";

const BASE: CreateMemberInput = {
  name: "Awa Diallo",
  phoneNumber: "+221770000001",
  dailyAmount: 500,
};

describe("computeEditImpact", () => {
  it("returns 'none' when nothing changed", () => {
    expect(computeEditImpact(BASE, BASE, { status: "active" })).toBe("none");
  });

  it("returns 'none' when only the name changed", () => {
    expect(computeEditImpact(BASE, { ...BASE, name: "Awa N." }, { status: "active" })).toBe("none");
  });

  it("returns 'none' when only the phone changed", () => {
    expect(
      computeEditImpact(BASE, { ...BASE, phoneNumber: "+221770000002" }, { status: "active" }),
    ).toBe("none");
  });

  it("returns 'cycle-affecting' when daily_amount changed on an active cycle", () => {
    expect(computeEditImpact(BASE, { ...BASE, dailyAmount: 1000 }, { status: "active" })).toBe(
      "cycle-affecting",
    );
  });

  it("returns 'cycle-affecting' when daily_amount changed on a with_advance cycle", () => {
    expect(computeEditImpact(BASE, { ...BASE, dailyAmount: 750 }, { status: "with_advance" })).toBe(
      "cycle-affecting",
    );
  });

  it("returns 'none' when daily_amount changed but the cycle is completed", () => {
    expect(computeEditImpact(BASE, { ...BASE, dailyAmount: 1000 }, { status: "completed" })).toBe(
      "none",
    );
  });

  it("returns 'none' when daily_amount changed but the cycle is settled", () => {
    expect(computeEditImpact(BASE, { ...BASE, dailyAmount: 1000 }, { status: "settled" })).toBe(
      "none",
    );
  });

  it("returns 'none' when daily_amount changed but there is no current cycle", () => {
    expect(computeEditImpact(BASE, { ...BASE, dailyAmount: 1000 }, null)).toBe("none");
  });
});
