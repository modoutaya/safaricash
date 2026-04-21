# CI branch-protection checklist

Story 1.8 activates the full CI gate pipeline (`.github/workflows/ci.yml`
and `.github/workflows/deploy.yml`). This doc lists the GitHub
branch-protection rules the repo operator must apply on `main` for the
gates to actually **block** merges.

## 1. Required status checks

Settings → Branches → `main` → _Require status checks to pass before
merging_. Add each check below to the "Required status checks" list:

- `CI / Lint • Typecheck • Unit tests • Build`
- `CI / Supabase • Playwright • axe • RLS • wrangler • Deno`
- `CI / Commitlint (Conventional Commits)`
- `Deploy (preview + production) / Preflight (Cloudflare enabled?)`
- `Deploy (preview + production) / Build and deploy to Cloudflare Pages`
  _(only after the operator has flipped `CLOUDFLARE_ENABLED=true` — see §3 below)_

### Gotcha: the "expected check" dance

GitHub's "Require status checks" setting only surfaces a check name in the
dropdown once it has **run at least once on any PR in the repo**. If you
try to add a check that has never executed, the picker simply doesn't list
it. The required sequence is:

1. Open a throwaway PR (or push to a branch with an open PR).
2. Wait until CI reports all the jobs above as either passing or failing.
3. **Now** go back to Settings → Branches and add them to "Required status checks".

If you skip step 2, the checks are never mandatory and a merge can slip
through with red CI. This is counter-intuitive — call it out loudly in the
handover doc for any new operator.

## 2. Branch-protection flags to set

- ☑ Require a pull request before merging
- ☑ Require approvals (1 minimum — adjust for team size)
- ☑ Dismiss stale pull request approvals when new commits are pushed
- ☑ Require status checks to pass before merging (list above)
- ☑ Require branches to be up to date before merging
- ☑ Require conversation resolution before merging
- ☐ Do **not** allow bypassing the above settings (enforce for admins) — flip this after the first green PR proves the pipeline works.
- ☐ Allow force pushes — keep **disabled**.
- ☐ Allow deletions — keep **disabled**.

## 3. Cloudflare Pages activation

The `deploy.yml` workflow is gated on the repo variable `CLOUDFLARE_ENABLED`.
See [RUNBOOK.md § Cloudflare Pages activation](./RUNBOOK.md) for the
step-by-step operator checklist.

## 4. Verifying the gate is live

After applying the rules:

1. Open a test PR that deliberately breaks CI (e.g. a lint error, a failing
   Vitest assertion).
2. Confirm GitHub refuses to merge with a "Required checks have not passed"
   message.
3. Fix the deliberate break; confirm merge becomes available once all
   required checks are green.

If the merge goes through with a red check, the list is incomplete — check
that every job name in §1 is in the required list (names in the job's
`name:` key, not the file name).
