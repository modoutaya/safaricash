# receipt-url Worker

Public saver-facing surface for SafariCash receipt pages — `safaricash.app/r/{token}`.

Story 6.4 (FR30 / UX-DR19): no-JS semantic HTML, WCAG Level A baseline,
service-role lookup against Supabase.

## Routes

| Method    | Path                 | Behaviour                                                                                                                                |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`     | `/health`            | `200 ok` (CI readiness probe)                                                                                                            |
| `GET`     | `/r/{token}`         | Renders receipt HTML or 404. `token` MUST match `^[0-9a-f]{32}$` (Story 6.3 generates tokens via `encode(gen_random_bytes(16), 'hex')`). |
| `GET`     | `/r/{token}/dispute` | `200` — the dispute confirmation form (no-JS server-rendered, Story 10.1).                                                               |
| `POST`    | `/r/{token}/dispute` | Records the dispute via `flag_transaction_dispute` → `200` acknowledgment / `404` / `500` (Story 10.1).                                  |
| `GET`     | `/r/{token}/opt-out` | `200` — the opt-out confirmation form (Story 6.5).                                                                                       |
| `POST`    | `/r/{token}/opt-out` | Flips `members.sms_opt_out` → `200` (Story 6.5).                                                                                         |
| any other | any other            | 404                                                                                                                                      |

## Deploy

```bash
# 1. Set the real Supabase project URL in wrangler.toml [vars] (overrides
#    the placeholder; the pre-deploy check rejects example.supabase.co).
# 2. Set the service-role secret:
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# 3. Deploy:
npm run worker:receipt-url:deploy
# 4. In the Cloudflare dashboard: Routes → add safaricash.app/r/* →
#    safaricash-receipt-url
```

## Local dev

```bash
npm run worker:receipt-url:dev   # binds 127.0.0.1:8788
curl http://127.0.0.1:8788/health
```

For local lookups against the local Supabase stack, override
`SUPABASE_PROJECT_URL` to `http://127.0.0.1:54321` via:

```bash
wrangler dev --config workers/receipt-url/wrangler.toml --port 8788 \
  --var SUPABASE_PROJECT_URL:http://127.0.0.1:54321
```

(or edit `wrangler.toml` locally — never commit a non-placeholder URL).

## Dispute flow (Story 10.1)

`src/dispute.ts` handles the saver dispute flag:

- `GET /r/{token}/dispute` renders a no-JS confirmation form (optional
  free-text + "Signaler" / "Annuler").
- `POST /r/{token}/dispute` calls the `flag_transaction_dispute` RPC
  (SECURITY DEFINER, service-role) which inserts a `disputes` row — the
  `audit_disputes` trigger hash-chains a `dispute.flagged` audit event —
  then renders the compassionate acknowledgment screen. A re-submit while
  an open dispute exists is idempotent ("Signalement déjà envoyé").

Story 10.2 adds the `dispute-notify` Edge Function (collector + founder
notification) and the `dispute_ack` SMS — out of scope for the Worker.
