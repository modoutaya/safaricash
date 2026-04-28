# receipt-url Worker

Public saver-facing surface for SafariCash receipt pages — `safaricash.app/r/{token}`.

Story 6.4 (FR30 / UX-DR19): no-JS semantic HTML, WCAG Level A baseline,
service-role lookup against Supabase.

## Routes

| Method    | Path                 | Behaviour                                                                                                                                |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`     | `/health`            | `200 ok` (CI readiness probe)                                                                                                            |
| `GET`     | `/r/{token}`         | Renders receipt HTML or 404. `token` MUST match `^[0-9a-f]{32}$` (Story 6.3 generates tokens via `encode(gen_random_bytes(16), 'hex')`). |
| `GET`     | `/r/{token}/dispute` | 501 _"Cette fonctionnalité arrive bientôt."_ — Story 10.2 will replace with the dispute submission form (UX-DR20).                       |
| `POST`    | `/r/{token}/dispute` | 501 placeholder — Story 10.2 will land the handler.                                                                                      |
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

## Story 10.2 hand-off

`src/dispute.ts` is a 501-stub. Story 10.2 replaces it with the saver
dispute submission flow per UX-DR20:

- GET form with single textarea + destructive CTA.
- POST handler inserts a `disputes` row + dispatches the `dispute_ack`
  SMS via Story 6.3's `format_sms_body('dispute_ack', tx_id)` helper.
- Compassionate acknowledgment screen on submit.
