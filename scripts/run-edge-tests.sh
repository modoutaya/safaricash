#!/usr/bin/env bash
# Wrapper: load env vars from .env.local, then run Deno tests for Edge Functions.
# CI-friendly: works locally + in GitHub Actions (which can override env vars).
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

# The Edge Function reads SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
# from env. Test code uses SUPABASE_TEST_* (kept distinct in case CI uses a
# separate test project later). Mirror values:
export SUPABASE_URL="${SUPABASE_TEST_URL:-${VITE_SUPABASE_URL:-}}"
export SUPABASE_ANON_KEY="${SUPABASE_TEST_ANON_KEY:-${VITE_SUPABASE_ANON_KEY:-}}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_TEST_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
export SUPABASE_TEST_URL="$SUPABASE_URL"
export SUPABASE_TEST_ANON_KEY="$SUPABASE_ANON_KEY"
export SUPABASE_TEST_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
export TERMII_API_KEY="${TERMII_API_KEY:-mock-key-not-used-in-tests}"
# Story 6.5 — sms-inbound webhook secret. CI sets this to the same value
# we pass via ?secret= in the contract test fetches.
export TERMII_INBOUND_SECRET="${TERMII_INBOUND_SECRET:-ci-test-inbound-secret}"

# --node-modules-dir=auto lets Deno resolve the npm deps pinned in deno.lock
# (e.g. @supabase/realtime-js@2.103.3, a transitive of jsr:@supabase/supabase-js)
# even when `npm ci` has populated node_modules/ with different versions via
# the package-lock.json resolution.
deno test --allow-net --allow-env --allow-read --no-check --node-modules-dir=auto \
  supabase/functions/re-auth/index.test.ts \
  supabase/functions/_shared/emit-session-event.contract.test.ts \
  supabase/functions/_shared/create-member-with-cycle.contract.test.ts \
  supabase/functions/_shared/promote-cycle-on-advance.contract.test.ts \
  supabase/functions/_shared/reject-transaction-on-closed-cycle.contract.test.ts \
  supabase/functions/_shared/record-contribution.contract.test.ts \
  supabase/functions/_shared/record-rattrapage.contract.test.ts \
  supabase/functions/_shared/undo-transaction.contract.test.ts \
  supabase/functions/_shared/record-advance.contract.test.ts \
  supabase/functions/_shared/sms-dispatch-trigger.contract.test.ts \
  supabase/functions/sms-dispatch/index.test.ts \
  supabase/functions/sms-worker/backoff.test.ts \
  supabase/functions/sms-worker/index.test.ts \
  supabase/functions/_shared/sms-worker-audit-allowlist.contract.test.ts \
  supabase/functions/_shared/sms-worker-cron-schedule.contract.test.ts \
  supabase/functions/_shared/format-sms-body.contract.test.ts \
  supabase/functions/_shared/sms-templates-banking-language.contract.test.ts \
  supabase/functions/_shared/sms-templates-length.contract.test.ts \
  supabase/functions/_shared/set-member-sms-opt-out.contract.test.ts \
  supabase/functions/sms-inbound/index.test.ts \
  supabase/functions/_shared/format-resend-sms-body.contract.test.ts \
  supabase/functions/_shared/enqueue-resend-history.contract.test.ts \
  supabase/functions/sms-resend-history/index.test.ts \
  "$@"
