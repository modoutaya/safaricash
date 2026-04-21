-- Story 1.5b — Migration 0012: drop check_collector_registered RPC.
--
-- PRD v1.3 auth pivot (Termii business-KYC blocker). The login UX no
-- longer pre-checks whether a phone is a pre-provisioned collector
-- because signInWithPassword returns invalid_credentials for both
-- "unregistered phone" and "wrong password" — strictly stronger than
-- the prior explicit existence oracle (no enumeration).
--
-- See: _bmad-output/implementation-artifacts/1-5b-password-auth-switch.md
-- AC #3; PRD v1.3 amendment (2026-04-21).

drop function if exists public.check_collector_registered(text);
