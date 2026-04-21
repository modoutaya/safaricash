// Project-wide constants.
//
// Story 1.5b — OTP_* constants were removed after PRD v1.3 pivoted auth
// to `signInWithPassword`. Server-side abuse defence now lives in
// Supabase Auth's native per-identifier rate limit, so there are no
// client-side OTP length / lockout / cooldown numerics to share.
//
// FOUNDER_SUPPORT_PHONE is in src/lib/contact.ts (single source of
// truth per Story 1.5 AC #4 + R-OP1). Do NOT re-introduce it here.

// Story 1.6 — NFR-S4 collector session policy.
// 30-min idle timeout (client-side; Supabase Auth has no native idle concept).
// 30-day absolute lifetime (dual-enforced: Supabase refresh-token TTL +
// localStorage guard as defense in depth — see docs/session policy).
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ACTIVITY_DEBOUNCE_MS = 1_000;
export const SESSION_STARTED_AT_STORAGE_KEY = "sc_session_started_at";
