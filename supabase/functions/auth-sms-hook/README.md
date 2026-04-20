# auth-sms-hook — Supabase Auth Send SMS Hook → Termii

Story 1.5. Receives Supabase Auth's **Send SMS Hook** webhook when a phone OTP is minted (via `signInWithOtp({ channel: 'sms' })`), verifies the signature following the [Standard Webhooks](https://www.standardwebhooks.com/) spec, and dispatches the SMS through the shared Termii client.

This is what lets SafariCash use its own SMS provider (Termii) for Supabase Auth phone-OTP, instead of Supabase's built-in Twilio fallback.

---

## Operator runbook — one-time setup

### 1. Deploy the Edge Function

**MUST deploy with `--no-verify-jwt`** — Supabase Auth calls this webhook service-to-service without a caller JWT, so the platform's default JWT gate would reject every dispatch with `Hook requires authorization token`. Our Standard Webhooks HMAC check is the real authentication boundary.

```bash
supabase functions deploy auth-sms-hook --no-verify-jwt --project-ref <your-ref>
```

`supabase/config.toml` already sets `[functions.auth-sms-hook] verify_jwt = false` for reproducibility, but the CLI flag is still required on explicit deploys to be safe.

Project env must already have:

- `TERMII_API_KEY` — reused from Story 1.3 (re-auth). Same value.
- `TERMII_SENDER_ID` (optional) — defaults to `SafariCash`.

### 2. Obtain the hook secret (Standard Webhooks format)

Supabase Auth follows the Standard Webhooks spec. The secret must be in the form:

```
v1,whsec_<base64-encoded-random-bytes>
```

or

```
whsec_<base64-encoded-random-bytes>
```

The handler strips both prefixes and base64-decodes the rest to derive the HMAC-SHA256 key.

Two ways to get one:

**Option A — let the Supabase dashboard generate it (recommended).**
Go to **Authentication → Hooks → Send SMS Hook**, toggle _Enable_, and click the "Generate secret" button. Supabase returns a value like `v1,whsec_MfKQ9r8GK...`. **Copy that exact string.**

**Option B — generate locally.**

```bash
echo "v1,whsec_$(openssl rand -base64 32)"
```

### 3. Register the secret in two places

The Edge Function and the dashboard must hold the **same value**.

```bash
npx supabase secrets set AUTH_SMS_HOOK_SECRET='v1,whsec_<paste-here>' --project-ref <your-ref>
```

Then paste the same value into the dashboard's _Secret_ field for the Send SMS Hook.

### 4. Configure the hook URL

In **Authentication → Hooks → Send SMS Hook**:

- **Hook type**: HTTPS (NOT Postgres — we need to call the Termii external API)
- **URL**: `https://<your-ref>.supabase.co/functions/v1/auth-sms-hook`
- **Secret**: the value from step 2.

### 5. Verify

Seed a collector via Supabase Studio (insert into `public.users` with a phone already attached to `auth.users`), then from the dev front-end:

```bash
npm run dev
# Go to /login, type the phone, click "Recevoir le code"
# Expect: SMS arrives on that phone (Termii dashboard shows dispatch)
# Edge Function logs show event=auth.sms.dispatched
```

If you see `auth.sms.bad_signature` in logs — the secret in env and dashboard do not match. Rotate both.
If you see `auth.sms.bad_timestamp` — clock skew between Supabase Auth and the Edge Function is >5 minutes (unlikely unless the region is misconfigured).

---

## Signature verification details (for reviewers)

The handler implements Standard Webhooks v1 signature verification:

1. Reads `webhook-id`, `webhook-timestamp`, `webhook-signature` headers.
2. Rejects any timestamp more than **5 minutes** off from the Edge Function's clock (replay window).
3. Strips `v1,` then `whsec_` from `AUTH_SMS_HOOK_SECRET`, base64-decodes the rest → HMAC key.
4. Computes `HMAC-SHA256(key, "{webhook-id}.{webhook-timestamp}.{rawBody}")`, base64-encodes.
5. Parses `webhook-signature` as a space-separated list of `v1,<sig>` tokens.
6. Returns 200 if **any** token's signature matches the computed expected (constant-time compare). Multi-signature support is what lets secret rotation be zero-downtime: Supabase sends both old and new for a brief overlap.

---

## Secret rotation

Standard Webhooks explicitly supports rolling two signatures during overlap. Our handler accepts any matching `v1,<sig>` entry.

Zero-downtime rotation procedure:

1. Generate new secret `v1,whsec_<new-base64>`.
2. In the dashboard, trigger "Rotate secret" (the UI retains both for a few minutes).
3. Immediately update `AUTH_SMS_HOOK_SECRET` to the **new** value via `supabase secrets set`.
4. During the overlap, Supabase sends `webhook-signature: v1,<old-sig> v1,<new-sig>`. Our handler matches the new one, the old one is ignored.

If the dashboard does not expose a rotation UI, you can do a hard swap: both sides to the new value at once. At worst one hook dispatch 401s; Supabase Auth retries.

---

## Logs & observability

The handler emits structured JSON logs (stdout → Supabase function logs):

- `auth.sms.dispatched` (info) — success. Fields: `phone_masked`, `message_id`.
- `auth.sms.failed` (error) — Termii error. Fields: `phone_masked`, `termii_status`, `ops_alert` (set to `"termii_credentials_bad"` on 401/403).
- `auth.sms.bad_signature` (warn) — attacker probing or misconfiguration (secret mismatch, wrong version, tampered body).
- `auth.sms.bad_timestamp` (warn) — replay attempt OR severe clock skew.
- `auth.sms.invalid_request` (warn) — Supabase Auth payload drift (malformed JSON, missing `sms.otp`).
- `auth.config_missing` (error) — `AUTH_SMS_HOOK_SECRET` missing. Alert.
- `auth.config_invalid` (error) — `AUTH_SMS_HOOK_SECRET` is not valid `v1,whsec_<base64>`. Alert.

The OTP is **never** logged. Termii's response body is scrubbed of any 6-digit run before it enters error messages.
