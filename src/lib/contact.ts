// Single source of truth for founder / support contact details.
// AC #4 + R-OP1 — when the founder line changes, only this file is touched.
//
// Read from build-time env so the founder's real phone number is not
// embedded in every git checkout / public JS bundle (Story 1.3 review L1).
// Falls back to the documented MVP value (prd.md line 640) if env is not
// set — operator runbook must configure VITE_FOUNDER_SUPPORT_PHONE in
// Cloudflare Pages production env before shipping.

const DEFAULT_FOUNDER_PHONE = "+221777915898";
const DEFAULT_FOUNDER_PHONE_DISPLAY = "77 791 58 98";

export const FOUNDER_SUPPORT_PHONE: string =
  (import.meta.env["VITE_FOUNDER_SUPPORT_PHONE"] as string | undefined) ?? DEFAULT_FOUNDER_PHONE;

/** Display variant — national format without country code for dialability. */
export const FOUNDER_SUPPORT_PHONE_DISPLAY: string =
  (import.meta.env["VITE_FOUNDER_SUPPORT_PHONE_DISPLAY"] as string | undefined) ??
  DEFAULT_FOUNDER_PHONE_DISPLAY;
