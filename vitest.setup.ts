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

// Story 8.2 — make IndexedDB available in jsdom. jsdom does NOT ship IDB,
// so we polyfill with fake-indexeddb's auto-shim, which registers
// indexedDB, IDBKeyRange, and the rest of the IDB family on globalThis.
// Production uses the browser-native IDB (zero overhead — fake-indexeddb
// is a devDependency and stays out of the prod bundle). Dynamic import is
// the cleanest gate: if a future environment ships IDB natively, we skip.
if (typeof globalThis.indexedDB === "undefined") {
  await import("fake-indexeddb/auto");
}
