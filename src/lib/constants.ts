// Project-wide constants. MUST stay in sync with
// supabase/functions/_shared/constants.ts (Deno + browser runtimes can't
// share imports). Story 1.5 (phone-OTP login) reuses these same numerics
// for sign-in lockout.

export const OTP_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 5;
export const OTP_LOCKOUT_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const CONFIRMATION_TOKEN_EXPIRY_MINUTES = 2;

// FOUNDER_SUPPORT_PHONE moved to src/lib/contact.ts (single source of truth
// per Story 1.5 AC #4 + R-OP1). Do NOT re-introduce it here.
