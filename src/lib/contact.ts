// Single source of truth for founder / support contact details.
// AC #4 + R-OP1 — when the founder line changes, only this file is touched.
// Lives outside constants.ts because constants.ts mixes OTP magic numbers
// shared with Deno; contact details are UI-only.

export const FOUNDER_SUPPORT_PHONE = "+221777915898";

/** Display variant — national format without country code for dialability. */
export const FOUNDER_SUPPORT_PHONE_DISPLAY = "77 791 58 98";
