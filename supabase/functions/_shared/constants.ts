// MUST stay in sync with src/lib/constants.ts (Deno + browser runtimes
// can't share imports). Story 1.5 (phone-OTP login) reuses these same
// numerics for sign-in lockout.

export const OTP_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 5;
export const OTP_LOCKOUT_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_RESEND_COOLDOWN_SECONDS = 30;
export const CONFIRMATION_TOKEN_EXPIRY_MINUTES = 2;

// Termii's current API base URL (v3). The older `api.ng.termii.com` host
// returns 404 on /api/sms/send — Story 1.3 shipped with the stale URL but
// was never exercised against real Termii until Story 1.5 hooked the login
// flow. Kept overridable via TERMII_API_BASE_URL env for future migrations.
export const TERMII_API_BASE_URL_DEFAULT = "https://v3.api.termii.com";
export const TERMII_REQUEST_TIMEOUT_MS = 5_000;
export const TERMII_MAX_RETRIES = 3;
