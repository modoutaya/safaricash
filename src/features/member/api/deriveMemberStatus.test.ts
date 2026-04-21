import { describe, expect, it, vi } from "vitest";

import type { CycleRow, MemberRow } from "../types";
import { deriveMemberStatus } from "./deriveMemberStatus";

// Minimal factories — only the props the function actually reads.
const m = (status: MemberRow["status"]): Pick<MemberRow, "status"> => ({ status });
const c = (status: CycleRow["status"]): Pick<CycleRow, "status"> => ({ status });

describe("deriveMemberStatus", () => {
  it("maps member.status='deleted' to 'hidden' regardless of cycle", () => {
    expect(deriveMemberStatus(m("deleted"), c("active"))).toBe("hidden");
    expect(deriveMemberStatus(m("deleted"), null)).toBe("hidden");
  });

  it("maps member.status='paused' to 'hidden'", () => {
    expect(deriveMemberStatus(m("paused"), c("active"))).toBe("hidden");
  });

  it("maps member.status='completed' to 'termine'", () => {
    expect(deriveMemberStatus(m("completed"), null)).toBe("termine");
    // Even with an active cycle the member-level completed wins (admin
    // corrections, settlement edge cases).
    expect(deriveMemberStatus(m("completed"), c("active"))).toBe("termine");
  });

  it("maps active member with cycle.status='with_advance' to 'avance'", () => {
    expect(deriveMemberStatus(m("active"), c("with_advance"))).toBe("avance");
  });

  it("maps active member with cycle.status='active' to 'actif'", () => {
    expect(deriveMemberStatus(m("active"), c("active"))).toBe("actif");
  });

  it("maps active member with no current cycle to 'actif' + dev-warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(deriveMemberStatus(m("active"), null)).toBe("actif");
      expect(deriveMemberStatus(m("active"), undefined)).toBe("actif");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ignores cycle status when cycle is in settled/completed state (falls through to active fallback)", () => {
    // settled/completed cycles aren't the 'current' cycle by definition;
    // caller is expected to pass them as null. If one slips through, the
    // function treats it like "no current cycle" and returns 'actif' + warn.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(deriveMemberStatus(m("active"), c("completed"))).toBe("actif");
      expect(deriveMemberStatus(m("active"), c("settled"))).toBe("actif");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
