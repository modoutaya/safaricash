# SafariCash operations runbook

Operator-facing checklists for provisioning external services, enabling
deploys, and handling common production scenarios. Started in Story 1.8
(CI pipeline gates); will grow as later stories add ops-adjacent concerns.

## Cloudflare Pages activation

`.github/workflows/deploy.yml` builds + deploys the PWA to Cloudflare Pages.
The job is gated on the repo variable `CLOUDFLARE_ENABLED` so the workflow
stays green on repos where Cloudflare has not yet been wired. To switch it
on:

### Step 1 — Provision Cloudflare

1. Sign in to https://dash.cloudflare.com and capture the **Account ID**
   (top-right of the dashboard).
2. Cloudflare Pages → Create project → Direct Upload (Wrangler will drive
   the deploys). Name the project `safaricash` (or update the
   `CLOUDFLARE_PROJECT_NAME` repo variable to match whatever you pick).
3. Cloudflare → My Profile → API Tokens → Create Token:
   - Permissions: `Account → Cloudflare Pages → Edit`.
   - Account resources: the specific account you're deploying into.
   - TTL: set a renewal reminder for 12 months out.
   - Copy the token — Cloudflare only shows it once.

### Step 2 — Store credentials in GitHub

Settings → Secrets and variables → Actions:

- **Repository secrets**
  - `CLOUDFLARE_API_TOKEN` — the token minted in step 1.3.
  - `CLOUDFLARE_ACCOUNT_ID` — the ID from step 1.1.

- **Repository variables** (these are NOT secrets — they surface in logs)
  - `CLOUDFLARE_PROJECT_NAME` — e.g. `safaricash`.
  - `CLOUDFLARE_ENABLED` — set to `true` **only after** the secrets above
    are in place. Until this variable reads `true`, the deploy job
    short-circuits with a preflight no-op.

### Step 3 — First deploy smoke test

1. Open a throwaway PR that touches any file.
2. Watch `Deploy (preview + production) / Build and deploy to Cloudflare
Pages` land green.
3. Confirm a PR comment appears with the preview URL.
4. Visit the URL; confirm the SafariCash login page renders.

### Step 4 — Add the deploy check to branch protection

See [docs/ci-branch-protection.md § 1](./ci-branch-protection.md) — the
`Deploy (preview + production) / Build and deploy to Cloudflare Pages`
check becomes required only AFTER it has run at least once.

### Rollback

If a deploy breaks production, use Cloudflare's Pages dashboard:
Projects → safaricash → Deployments → select the last known-good
deployment → "Promote to production". There is no CLI flag for this; do
it from the dashboard.

## Backup & recovery (TODO — architecture.md NFR-R5/R6)

Quarterly PITR drill procedure, decryption smoke test, audit-chain replay
steps. Story Epic-9 / operations-hardening sprint will flesh this out.
