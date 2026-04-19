# ADR-001 — Column-level encryption via Supabase Vault (per-row + decryption view pattern)

- **Status:** Accepted
- **Date:** 2026-04-19
- **Story:** 1.2 (Supabase backend, schema, RLS, Vault, audit-log foundation)
- **Authors:** dev pairing on Story 1.2
- **Supersedes:** —
- **Superseded by:** —

## Context

PRD FR47 + NFR-S1 require AES-256-GCM column-level encryption for **PII at rest** on three columns:

- `members.name`
- `members.phone_number`
- `transactions.amount`

`architecture.md § Data Architecture → Column-level encryption` (Q-ARCH5 resolved) chose **Supabase Vault** over `pgsodium`, citing lower operational overhead and Supabase-native key management.

When Story 1.2 reached the Vault migration, we discovered that the documented public Vault API (verified 2026-04-19 against `https://supabase.com/docs/guides/database/vault`) only exposes **scalar secret storage**:

```sql
vault.create_secret(plaintext text, name text default null, description text default null)
  → uuid
-- Reads:
select decrypted_secret from vault.decrypted_secrets where id = <secret_id>;
```

There is no native `text → encrypted text` column wrap primitive. The architecture spec implicitly assumed one. This ADR captures how we bridged the gap and what the implications are.

## Decision

We adopted **Pattern 1 — per-row Vault secret + decryption view** (the community-standard pattern for column encryption with current Vault):

1. Each Vault-wrapped column on the underlying table becomes a `_encrypted` `uuid` column that references the `vault.secrets(id)` row holding the ciphertext for that row's value.
2. Two SECURITY DEFINER helper functions in `public` wrap the vault schema:
   - `public.vault_encrypt(plaintext text) → uuid` — calls `vault.create_secret(plaintext)` and returns the new `secret_id`.
   - `public.vault_decrypt(secret_id uuid) → text` — looks up `vault.decrypted_secrets` and returns the plaintext.
3. Two `security_invoker = true` views expose the full row with decrypted columns and inherit the underlying tables' RLS:
   - `public.members_decrypted`
   - `public.transactions_decrypted`

Migration `20260419000005_vault_setup.sql` implements all of the above.

### Why per-row secrets and not one secret per (collector, column)?

- Per-row secrets give us **fine-grained delete + rotate semantics**: deleting a member's row also makes their secret unreachable (and Story 10.4 saver-anonymisation can `vault.delete_secret(secret_id)` per row).
- Per-(collector, column) would require complex re-encryption when a single member is deleted under FR48 (saver data rights).

## Alternatives considered (and rejected)

### Pattern 2 — `pgsodium` direct column encryption

`pgsodium` has more mature column-encryption ergonomics: `security_label` annotation, transparent encryption/decryption via Postgres extension hooks, no view layer needed.

**Why rejected:** would override Q-ARCH5's explicit Vault choice. We retain `pgsodium` as a documented fallback if Vault's managed model becomes constraining (e.g., key-rotation latency exceeds operational SLA). Migration ramp from Vault → `pgsodium` is non-trivial but feasible (decrypt all rows via `vault_decrypt`, re-encrypt under `pgsodium` keys, drop `_encrypted` columns).

### Pattern 3 — application-layer AES-GCM with seed in Vault

Store one master AES key per collector in Vault; encrypt/decrypt at the JS layer (browser or Edge Function).

**Why rejected:** breaks the architecture promise that PostgREST returns decrypted plaintext to authenticated callers. Pushes crypto correctness into application code (high blast radius if a future feature mishandles the seed).

### Pattern 4 — defer encryption

Ship Story 1.2 with plaintext columns; add encryption in a later story.

**Why rejected:** once production data lands, retro-encryption requires a rolling re-encrypt migration with a maintenance window. Doing it now (zero rows in the DB) is essentially free.

## Encrypted columns inventory

| Table          | Encrypted column         | Vault field semantics                                                                         |
| -------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `members`      | `name_encrypted`         | UTF-8 saver name                                                                              |
| `members`      | `phone_number_encrypted` | E.164 phone number (e.g. `+221770000000`)                                                     |
| `transactions` | `amount_encrypted`       | Numeric amount serialised as text (e.g. `"500"`); decryption view re-casts to `numeric(12,0)` |

All three are `not null`. Reads via `members_decrypted` / `transactions_decrypted` propagate `NULL` only if a `secret_id` row was deleted from `vault.secrets` after the FK was set — which would itself be a tampering signal.

## Adding a new encrypted column

1. **Write the migration** (next available `0008_*.sql`):
   ```sql
   alter table public.<table>
     add column <field>_encrypted uuid not null;
   ```
2. **Add it to the decryption view** (drop & recreate `<table>_decrypted` with the new field projected through `public.vault_decrypt(<field>_encrypted)`).
3. **Run `npm run db:types`** to refresh `src/infrastructure/supabase/database.types.ts` so feature code sees the new column on the view.
4. **Update the inventory table above** in this ADR.

## Key rotation procedure

Vault's underlying root key is managed by Supabase. Rotation cadence:

- **Default:** quarterly review (no rotation if no signal of compromise).
- **Immediate:** on any suspected leak of an environment, `service_role` key, or Postgres credentials.

Rotation steps (when triggered):

1. **Trigger key rotation in the Supabase dashboard** → Project Settings → Vault → _Rotate root key_. Supabase re-wraps existing `vault.secrets` rows with the new root key in-place — application reads continue to work transparently.
2. **Verify reads still resolve** — run a smoke query against `public.members_decrypted` for a known member; expect plaintext.
3. **Document the rotation** in `docs/RUNBOOK.md` (created later by tech-lead, see Story 1.1 follow-up) under _Vault key rotations_: date, trigger reason (scheduled / suspected leak), operator initials.
4. **No application redeploy required** — only Postgres-side key rewrap.

If a rotation is triggered for _suspected leak_, also:

5. Rotate the leaked credential (e.g., issue a new `service_role` key in the dashboard and update Cloudflare Pages + Edge Function env).
6. Audit `audit_log` for suspicious actor patterns since the suspected leak window.

## Search-on-encrypted-columns trade-off

Migration `0006_indexes.sql` was supposed to add a trigram index on `members.name` (NFR-P2: 300 ms member search at 150 members). Encryption rules out a trigram index on the encrypted column.

**Resolution:** Story 2.1 (member-list-search) owns the search-UX and will choose between:

- **(a) Decrypt-then-filter in app** — at MVP scale (≤150 members per collector × ~1 KB decrypt cost) the latency is well under 100 ms. Acceptable. _Default expected choice._
- **(b) HMAC-hashed search column** — `members.name_search bytea` storing `hmac_sha256(normalised_name, per_collector_search_key)`. Allows exact-match lookup without revealing plaintext. Trades substring search for a deterministic salt-based hash. Adds a schema migration + a HMAC key per collector in Vault.
- **(c) Plaintext search column with explicit user consent** — exposes the saver name in cleartext for crawlable indexes. Only acceptable if the FR48 saver consent flow is wired to gate it. **Not recommended** at MVP.

The pg_trgm extension is installed in `0006` so option (b) or (c) can wire a trigram index in Story 2.1 without further migration churn.

## Migration path back to `pgsodium`

If Vault becomes constraining, the exit ramp is:

1. New migration enables `pgsodium`, creates `pgsodium.create_key()` per encrypted column-set.
2. Backfill: for each row in `members` / `transactions`, `pgsodium`-encrypt `vault_decrypt(<field>_encrypted)` into a new `<field>_pgsodium` column.
3. Cut over the `*_decrypted` views to the `pgsodium` columns.
4. Drop the `_encrypted` columns + `vault_encrypt` / `vault_decrypt` helpers.

Trigger criteria for considering this exit (any one of):

- Vault key-rotation latency exceeds the operational SLA.
- Vault's managed key model conflicts with future compliance requirements (e.g., HSM-backed BYOK demanded by a regulator).
- Read latency on `*_decrypted` views regresses materially (expected only at >>50 collectors × thousands of rows).

## Operational notes

- `supabase_vault` extension is auto-installed on Supabase Pro and on the Supabase CLI's local containerised stack. Migration `0005` `CREATE EXTENSION IF NOT EXISTS` is idempotent.
- The SECURITY DEFINER helpers run as the function owner (typically `postgres`). Their `EXECUTE` grant is restricted to `authenticated` and `service_role`. Anonymous (`anon`) callers cannot call them.
- The leak surface for `vault_decrypt(uuid)` is bounded by RLS: an `authenticated` caller only knows `secret_id`s that live in their RLS-protected rows. UUID v4 enumeration (2¹²² space) is not a realistic threat at MVP scale.

## References

- Architecture spec — `_bmad-output/planning-artifacts/architecture.md` § Data Architecture → Column-level encryption (Q-ARCH5)
- PRD — `_bmad-output/planning-artifacts/prd.md` FR47, NFR-S1
- Implementation — `supabase/migrations/20260419000005_vault_setup.sql`
- Story spec — `_bmad-output/implementation-artifacts/1-2-supabase-foundation.md` AC #5, Task 6
- Vault docs (verified 2026-04-19) — `https://supabase.com/docs/guides/database/vault`
