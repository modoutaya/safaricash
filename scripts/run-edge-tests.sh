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

deno test --allow-net --allow-env --allow-read --no-check supabase/functions/re-auth/index.test.ts "$@"
