// Story 6.7 — shareReceipt unit tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getReceiptUrlBase, shareReceipt } from "./shareReceipt";

const ORIGINAL_NAVIGATOR = globalThis.navigator;
const ORIGINAL_WINDOW = globalThis.window;

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  setNavigator(ORIGINAL_NAVIGATOR);
  setWindow(ORIGINAL_WINDOW);
  vi.restoreAllMocks();
});

describe("getReceiptUrlBase", () => {
  it("strips trailing slashes from VITE_RECEIPT_URL_BASE", () => {
    vi.stubEnv("VITE_RECEIPT_URL_BASE", "https://safaricash.app/r/");
    expect(getReceiptUrlBase()).toBe("https://safaricash.app/r");
  });

  it("falls back to the production default in dev when unset", () => {
    vi.stubEnv("VITE_RECEIPT_URL_BASE", "");
    expect(getReceiptUrlBase()).toBe("https://safaricash.app/r");
  });
});

const RECEIPT_TOKEN = "a".repeat(32);
const INPUT = { amount: 500, cycleDay: 1, receiptToken: RECEIPT_TOKEN } as const;
const EXPECTED_URL = `https://safaricash.app/r/${RECEIPT_TOKEN}`;

describe("shareReceipt", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_RECEIPT_URL_BASE", "https://safaricash.app/r");
  });

  it("uses navigator.share when available and not aborted", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    setNavigator({
      share: shareMock,
      canShare: () => true,
    });
    setWindow({ isSecureContext: true });

    const result = await shareReceipt(INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe("native");
    expect(shareMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: EXPECTED_URL, title: "Reçu SafariCash" }),
    );
  });

  it("returns aborted when navigator.share throws AbortError", async () => {
    const abortErr = Object.assign(new Error("user cancelled"), { name: "AbortError" });
    setNavigator({ share: vi.fn().mockRejectedValue(abortErr), canShare: () => true });
    setWindow({ isSecureContext: true });

    const result = await shareReceipt(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("aborted");
  });

  it("falls back to clipboard when navigator.share throws non-AbortError", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({
      share: vi.fn().mockRejectedValue(new Error("permission denied")),
      canShare: () => true,
      clipboard: { writeText },
    });
    setWindow({ isSecureContext: true });

    const result = await shareReceipt(INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith(EXPECTED_URL);
  });

  it("uses clipboard fallback when navigator.share is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigator({ clipboard: { writeText } });
    setWindow({ isSecureContext: true });

    const result = await shareReceipt(INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.via).toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith(EXPECTED_URL);
  });

  it("returns unsupported when neither API is available", async () => {
    setNavigator({});
    setWindow({ isSecureContext: false });

    const result = await shareReceipt(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported");
  });

  it("never logs the receipt URL or token", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    setNavigator({
      share: vi.fn().mockResolvedValue(undefined),
      canShare: () => true,
    });
    setWindow({ isSecureContext: true });

    await shareReceipt(INPUT);
    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(RECEIPT_TOKEN);
        expect(String(arg)).not.toContain(EXPECTED_URL);
      }
    }
  });
});
