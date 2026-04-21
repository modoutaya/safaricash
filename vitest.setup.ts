import "@testing-library/jest-dom/vitest";

// jsdom (as of v24) still does not ship ResizeObserver. Radix primitives
// (Slot, Dialog, etc. — inside shadcn components) call it during commit,
// so keep the no-op polyfill even after input-otp was removed in 1.5b.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
