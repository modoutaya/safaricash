import "@testing-library/jest-dom/vitest";

// jsdom (as of v24) still does not ship ResizeObserver. Several headless UI
// primitives we rely on (e.g. input-otp, Radix Slot inside shadcn components)
// call it during commit. Install a no-op so render() does not crash.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom does not implement document.elementFromPoint; input-otp schedules a
// setTimeout that calls it, which would otherwise throw after the test
// completes. Stub with a no-op to keep the test runner clean.
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  (document as Document & { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
}
