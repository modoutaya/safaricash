// Minimal i18n hook. Story 1.3 only needs a basic FR-only resolver.
// Story 1.5 will swap this for a real i18n library (or extend this) when
// Wolof / Bambara are needed (NFR-L2).

import frJson from "@/i18n/fr.json";
import type { TranslationKey } from "@/i18n/keys";

function resolveKey(obj: unknown, path: string[]): string | undefined {
  let cursor: unknown = obj;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = vars[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const segments = key.split(".");
  const raw = resolveKey(frJson, segments);
  if (raw === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  return interpolate(raw, vars);
}

/** React hook variant — for now, identical to `t`. Future enhancement: wire
 *  to a context/provider when locale switching lands in Story 1.5+. */
export function useT() {
  return t;
}
