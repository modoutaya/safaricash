// Story 6.7 — Web Share API wrapper with clipboard fallback.
//
// Pure module: takes the receipt datapoints, composes the public receipt
// URL via VITE_RECEIPT_URL_BASE + receipt_token, then tries:
//   1. navigator.share (mobile native sheet)
//   2. navigator.clipboard.writeText (desktop / Playwright / older mobile)
//   3. {ok:false, reason:'unsupported'} — caller surfaces the URL inline.
//
// NEVER logs the receipt URL or token (128-bit access capability — leaking
// it to console would let any log-scraping tool open the receipt).

import { formatFcfaAmount } from "@/features/member/api/formatAmount";

export type ShareReceiptResult =
  | { ok: true; via: "native" | "clipboard"; url: string }
  | { ok: false; reason: "aborted" | "unsupported" | "error"; url: string };

export interface ShareReceiptInput {
  /** Transaction amount in FCFA (integer). Rendered via formatFcfaAmount. */
  amount: number;
  /** 1-based cycle day for the transaction. */
  cycleDay: number;
  /** 32-hex-char receipt token (Story 6.4 surface). */
  receiptToken: string;
}

const DEFAULT_RECEIPT_URL_BASE = "https://safaricash.app/r";

/** Read the receipt URL base from Vite env. Falls back to the production
 *  default in dev only; production builds inline the real value at build time. */
export function getReceiptUrlBase(): string {
  const fromEnv = import.meta.env["VITE_RECEIPT_URL_BASE"];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.replace(/\/+$/, "");
  }
  if (import.meta.env.DEV) {
    return DEFAULT_RECEIPT_URL_BASE;
  }
  throw new Error("VITE_RECEIPT_URL_BASE not set — production builds must wire this env var");
}

export async function shareReceipt(input: ShareReceiptInput): Promise<ShareReceiptResult> {
  const { amount, cycleDay, receiptToken } = input;
  const url = `${getReceiptUrlBase()}/${receiptToken}`;
  // Short summary kept well under 280 chars so any share target (SMS,
  // WhatsApp, Notes) accepts it cleanly. NOTE: `formatFcfaAmount` emits
  // NBSP (U+00A0) as the thousands separator — Web Share API accepts
  // unicode, so this is intentional. NFR-A6 (7-bit ASCII / GSM-7) applies
  // ONLY to the server-side SMS body; the share text is a separate surface.
  const text = `${formatFcfaAmount(amount)} FCFA — jour ${cycleDay}/30 — détail: ${url}`;
  const title = "Reçu SafariCash";
  const payload = { title, text, url };

  // 1. Native share sheet (mobile Chrome / Safari / Samsung Internet / Edge).
  const nav = typeof navigator === "undefined" ? null : navigator;
  if (nav && typeof nav.share === "function") {
    const canShare = typeof nav.canShare === "function" ? nav.canShare(payload) : true;
    if (canShare) {
      try {
        await nav.share(payload);
        return { ok: true, via: "native", url };
      } catch (err) {
        // AbortError = user dismissed the sheet — distinct from a real error.
        if ((err as { name?: string })?.name === "AbortError") {
          return { ok: false, reason: "aborted", url };
        }
        // Fall through to clipboard fallback on any other share failure.
      }
    }
  }

  // 2. Clipboard fallback (requires secure context — https or localhost).
  const isSecure = typeof window !== "undefined" && window.isSecureContext;
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function" && isSecure) {
    try {
      await nav.clipboard.writeText(url);
      return { ok: true, via: "clipboard", url };
    } catch {
      return { ok: false, reason: "error", url };
    }
  }

  // 3. Neither API available — caller renders the URL inline for manual copy.
  return { ok: false, reason: "unsupported", url };
}
