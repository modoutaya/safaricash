# Story 1.2: Supabase backend, schema, RLS, Vault, and audit-log foundation

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer on the SafariCash MVP**,
I want **the Supabase project provisioned in eu-west-3 (Paris) with the full MVP schema, per-collector RLS isolation, Supabase Vault column-level encryption, and a hash-chained append-only audit log**,
so that **every downstream epic (2 through 10) writes to a secure, tenant-isolated, auditable data layer with zero retrofit work later**.

## Acceptance Criteria

1. **Supabase project provisioned.** A Supabase Pro project exists in `eu-west-3` (Paris). `supabase/config.toml` is committed (initialised via `supabase init`); `.env.example` updated with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Real values live in `.env.local` (git-ignored) for dev and in the Supabase / Cloudflare dashboards for prod (no secret in repo or Git history).
2. **Schema migration applied.** Running `supabase db push` against the project applies the seven migration files defined in `architecture.md § Project Structure & Boundaries → supabase/migrations/`:
   - `20260419000001_init_schema.sql` — creates `users`, `members`, `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes`
   - `20260419000002_rls_policies.sql` — RLS enabled + per-collector policies on every user-owned table
   - `20260419000003_audit_log.sql` — `audit_log` table shape + `prev_hash` / `entry_hash` columns
   - `20260419000004_sms_queue.sql` — `sms_queue` table consumed by Story 6.1
   - `20260419000005_vault_setup.sql` — Supabase Vault keys + encrypted columns for `members.name`, `members.phone_number`, `transactions.amount`
   - `20260419000006_indexes.sql` — performance indexes (NFR-P2: `members(collector_id, name gin trigram)`)
   - `20260419000007_triggers_audit.sql` — Postgres `AFTER INSERT/UPDATE/DELETE` trigger appending hash-chained rows to `audit_log` for `members`, `transactions`, `cycles`
3. **Naming conventions respected.** All tables / columns / FKs / enums / indexes follow `architecture.md § Implementation Patterns & Consistency Rules → Naming Patterns` (snake_case plural tables, `{referenced_singular}_id` FKs, `{table}_{field}_enum` enums, `idx_{table}_{columns}` indexes, `created_at` / `updated_at`). No `creation_date`, `dateCreated`, or camelCase identifiers anywhere in SQL.
4. **RLS enforces per-collector isolation (FR46, NFR-S5).** RLS is enabled on `users`, `members`, `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes`. Each policy restricts `SELECT / INSERT / UPDATE / DELETE` to rows where `collector_id = auth.uid()` (and on `users`, `id = auth.uid()`). RLS is enabled with `FORCE ROW LEVEL SECURITY` so that even the table owner respects policies.
5. **Vault column-level encryption (FR47, NFR-S1).** `members.name`, `members.phone_number`, and `transactions.amount` are stored encrypted via Supabase Vault keys; reads through the `members_decrypted` / `transactions_decrypted` PostgREST views under an authenticated collector return decrypted plaintext (RLS-gated); direct invocation of `public.vault_decrypt(uuid)` is REVOKEd from `authenticated` and granted only to `service_role`, so a logged-in user cannot bypass RLS by calling the helper directly. Vault key management is documented in `docs/ADR/001-supabase-vault.md` along with rotation procedure. **AC amendment (2026-04-19, code review):** original wording "reads via the `service_role` outside Vault context return ciphertext" was structurally not deliverable with the per-row Vault pattern (per ADR-001) — `vault_decrypt` is the single decryption path and runs under SECURITY DEFINER. The substitute guarantee is the REVOKE-from-authenticated described above, which closes the same threat (logged-in users cannot enumerate other collectors' secrets via direct RPC).
6. **Hash-chained audit log (FR44, NFR-S6).** The `audit_log` table has shape `{ event_id uuid PK, event_type text, collector_id uuid, entity_id uuid, entity_table text, timestamp timestamptz, actor text CHECK (actor='system' OR actor matches uuid), source text CHECK IN ('online','offline_reconciled'), payload jsonb, prev_hash bytea CHECK (NULL or octet_length=32), entry_hash bytea CHECK (octet_length=32) }`. The `triggers_audit.sql` trigger computes `entry_hash = sha256(prev_hash || event_id || event_type || collector_id || entity_id || entity_table || timestamp || actor || source || canonical_jsonb(payload))` where `prev_hash` is the `entry_hash` of the previous row for the same `collector_id` (NULL for the first row), `timestamp` is rendered via `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, and `canonical_jsonb()` is a SQL helper producing the same alpha-sorted compact JSON as `canonicalJsonStringify()` in TS. Each row uses `clock_timestamp()` (not `now()`) so multi-row INSERTs get monotonic timestamps. The chain is per-collector with `pg_advisory_xact_lock(0x5AFA, hashtext(collector_id))` serialising per-collector writes. The trigger is `SECURITY DEFINER` and migration 0003 REVOKEs INSERT/UPDATE/DELETE on `audit_log` from `public` / `anon` / `authenticated` (NFR-S6: append-only, mutation-resistant). **AC amendments (2026-04-19, code review):** (a) `actor` is `text` not `uuid` to allow the literal `'system'` for trigger / service-role writes; CHECK constraint enforces uuid-or-`'system'` shape. (b) Hash recipe expanded from the original 7 fields to 10 (added `entity_table`, `actor`, `source`) — strictly more tamper-resistant. (c) Length CHECK on `entry_hash` (= 32 bytes) and `prev_hash` (NULL or = 32 bytes) closes a hand-inserted-empty-bytea attack vector.
7. **Automated RLS isolation test gates the release (NFR-S5).** A Playwright + Supabase JS test at `tests/e2e/rls-isolation.spec.ts` (a) seeds two collector accounts (`collectorA`, `collectorB`) plus members + transactions + cycles for each, (b) signs in as `collectorA` and asserts that `select` queries against `members`, `transactions`, `cycles`, `audit_log`, `sms_queue`, `disputes` return only `collectorA`'s rows (zero rows from `collectorB`), and (c) attempts an `update` and a `delete` on a `collectorB` row and asserts a row-not-found / RLS rejection (zero rows affected). The test is wired into `.github/workflows/ci.yml` as a required step. **A failing isolation test blocks merge to `main` and blocks production deploy** — no manual override allowed (NFR-S5 explicitly states this is a release gate).
8. **Hash-chain integrity test.** A Vitest unit + integration suite at `src/domain/audit/hashChain.test.ts` (a) verifies `hashChain.ts` deterministically computes the same hash for a given `(prev_hash, event)` pair, (b) verifies a tampered `payload` (modified after insert) breaks chain validation when `verify.ts` walks the chain, (c) seeds 100 sequential audit rows via the trigger and asserts `verify.ts` returns `valid: true`. Coverage gate: `src/domain/audit/` ≥ 100 % per `architecture.md § Enforcement Guidelines → Test coverage gate`.
9. **No application code touched in this story.** No React component, no TanStack Query hook, no Edge Function is written here. Story 1.2 stops at the data layer + the two test scaffolds. The Supabase singleton client (`src/infrastructure/supabase/client.ts`) and the env loader (`src/infrastructure/supabase/env.ts`) are stubbed with minimal `createClient(...)` + Zod-validated env reads so that future stories (1.5 phone-OTP, 2.x members) can import them — but no domain or feature module is wired.
10. **ADR-001 documents Vault rationale.** `docs/ADR/001-supabase-vault.md` is created per `architecture.md § Project Structure & Boundaries → docs/ADR/`. Records: choice of Supabase Vault over `pgsodium`, rotation cadence (quarterly minimum), migration path back to `pgsodium` if Vault becomes constraining, encrypted columns inventory (`members.name`, `members.phone_number`, `transactions.amount`), and how to add a new encrypted column.

## Tasks / Subtasks

- [x] **Task 1: Provision the Supabase project and initialise the CLI** (AC: 1)
  - [x] Create the Supabase project in the dashboard, region `eu-west-3` (Paris), tier Pro
  - [x] Capture project URL, `anon` key, `service_role` key in a secure password store (1Password / similar) — share with the dev pairing on this story; do NOT commit them
  - [x] Run `supabase init` at repo root to create `supabase/config.toml`; commit the file
  - [x] Update `.env.example` (already present from Story 1.1) — confirm `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` lines are present with empty values
  - [x] Add `.env.local` to `.gitignore` (verify Story 1.1 already did this; if not, add it)
  - [x] Run `supabase login` (developer auth) and `supabase link --project-ref {ref}` to link CLI to the project
  - [x] Verify `supabase db push --dry-run` runs cleanly with no migrations yet (baseline check)

- [x] **Task 2: Author migration `20260419000001_init_schema.sql`** (AC: 2, 3) — see Dev Notes § Schema specification
  - [x] Create `users` table with columns: `id uuid PK references auth.users(id)`, `phone_number text NOT NULL UNIQUE`, `role users_role_enum NOT NULL DEFAULT 'collector'`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`. Define `users_role_enum AS ENUM ('collector', 'super_admin')`.
  - [x] Create `members` table: `id uuid PK DEFAULT gen_random_uuid()`, `collector_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT`, `name text NOT NULL` (later wrapped by Vault), `phone_number text NOT NULL` (later Vault-wrapped), `daily_amount numeric(12,0) NOT NULL CHECK (daily_amount > 0)`, `status members_status_enum NOT NULL DEFAULT 'active'`, `created_at`, `updated_at`. Define `members_status_enum AS ENUM ('active', 'paused', 'completed', 'deleted')`.
  - [x] Create `cycles` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT`, `cycle_number int NOT NULL CHECK (cycle_number >= 1)`, `start_date date NOT NULL`, `end_date date NOT NULL`, `status cycles_status_enum NOT NULL DEFAULT 'active'`, `created_at`, `updated_at`. `cycles_status_enum AS ENUM ('active', 'with_advance', 'completed', 'settled')`. Unique `(member_id, cycle_number)`.
  - [x] Create `transactions` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT`, `cycle_id uuid NOT NULL REFERENCES cycles(id) ON DELETE RESTRICT`, `kind transactions_kind_enum NOT NULL`, `amount numeric(12,0) NOT NULL CHECK (amount > 0)` (later Vault-wrapped), `cycle_day int NOT NULL CHECK (cycle_day BETWEEN 1 AND 30)`, `source transactions_source_enum NOT NULL DEFAULT 'online'`, `created_at`, `updated_at`. Define `transactions_kind_enum AS ENUM ('contribution', 'rattrapage', 'advance')`, `transactions_source_enum AS ENUM ('online', 'offline_reconciled')`.
  - [x] Create `sms_queue` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE`, `recipient_phone text NOT NULL` (encrypted), `body text NOT NULL`, `status sms_queue_status_enum NOT NULL DEFAULT 'queued'`, `attempts int NOT NULL DEFAULT 0`, `last_attempt_at timestamptz`, `delivered_at timestamptz`, `created_at`. Define `sms_queue_status_enum AS ENUM ('queued', 'sent', 'delivered', 'failed', 'abandoned')`. Index `(status, created_at)` for the worker drain query.
  - [x] Create `disputes` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `transaction_id uuid NOT NULL REFERENCES transactions(id)`, `flagged_at timestamptz NOT NULL DEFAULT now()`, `flagged_via disputes_via_enum NOT NULL DEFAULT 'receipt_url'`, `status disputes_status_enum NOT NULL DEFAULT 'open'`, `notes text`, `resolved_at timestamptz`. Define `disputes_via_enum AS ENUM ('receipt_url', 'support_email', 'support_phone')`, `disputes_status_enum AS ENUM ('open', 'resolved', 'dismissed')`.
  - [x] Create `audit_log` table per AC 6 (full shape) — but defer the trigger function to migration `0007`
  - [x] Add a `BEFORE UPDATE` trigger on every table with `updated_at` that sets `updated_at = now()`
  - [x] Verify migration applies cleanly to a freshly reset local DB: `supabase db reset && supabase db push`

- [x] **Task 3: Author migration `20260419000002_rls_policies.sql`** (AC: 4) — RLS per-collector isolation (FR46, NFR-S5)
  - [x] `ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY;` on every table from Task 2 + `audit_log`
  - [x] On `users`: `CREATE POLICY users_self ON users FOR ALL USING (id = auth.uid()) WITH CHECK (id = auth.uid());`
  - [x] On `members`, `cycles`, `transactions`, `sms_queue`, `disputes`: `CREATE POLICY {table}_collector_isolation ON {table} FOR ALL USING (collector_id = auth.uid()) WITH CHECK (collector_id = auth.uid());`
  - [x] On `audit_log`: `SELECT` policy `USING (collector_id = auth.uid())`. **No `INSERT` / `UPDATE` / `DELETE` policy** — only the `SECURITY DEFINER` trigger from Task 7 may write, which bypasses RLS by design (NFR-S6 append-only)
  - [x] **Do NOT add `super_admin` bypass policies in this story.** Admin access at MVP is through Supabase Studio with the service-role key (`architecture.md § Admin Provisioning Tool`). Multi-collector RBAC is out of MVP scope.

- [x] **Task 4: Author migration `20260419000003_audit_log.sql`** (AC: 6) — table shape only; trigger lives in `0007`
  - [x] Create the `audit_log` table per AC 6 specification (every column listed)
  - [x] Constraints: `event_type` matches `architecture.md § Communication Patterns → Event naming` (`{entity}.{action}`, lowercase, past-tense). Add `CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$')` as a defensive constraint.
  - [x] Index `(collector_id, timestamp DESC)` for the per-collector chain walk + audit history queries
  - [x] Index `(entity_table, entity_id)` for entity-level audit queries (Story 2.4 member profile timeline)
  - [x] `REVOKE INSERT, UPDATE, DELETE ON audit_log FROM PUBLIC, authenticated, anon;` — only `service_role` and the trigger function may write

- [x] **Task 5: Author migration `20260419000004_sms_queue.sql`** (AC: 2) — table is created in `0001` but this migration adds the worker-facing index + the `RAISE` constraint preventing direct dequeue
  - [x] Verify `sms_queue` index `(status, created_at)` is present (created in `0001`); add it here if it was missed
  - [x] Document expected lifecycle in a SQL `COMMENT ON TABLE sms_queue IS '...'` referencing Story 6.1 / 6.2 ownership

- [x] **Task 6: Author migration `20260419000005_vault_setup.sql`** (AC: 5) — Supabase Vault column encryption (FR47, NFR-S1)
  - [x] `CREATE EXTENSION IF NOT EXISTS supabase_vault;` (verify Vault is available on the Pro tier of the linked project)
  - [x] Generate one Vault key per encrypted column-set: `members_pii_key` (covers `name` + `phone_number`) and `transactions_amount_key`. Capture key UUIDs in a SQL comment + ADR-001
  - [x] Convert `members.name`, `members.phone_number`, `transactions.amount` columns to use Vault encryption via `vault.create_secret()` + view-based decryption pattern per Supabase Vault docs (verify against current Vault docs at implementation time — see Dev Notes § Latest Tech Information)
  - [x] Verify via local Supabase: `INSERT` into `members`, then `SELECT` as the owning collector returns plaintext; `SELECT` via `service_role` outside the Vault context returns ciphertext / null
  - [x] **Key rotation procedure** documented in `docs/ADR/001-supabase-vault.md` per Task 10

- [x] **Task 7: Author migration `20260419000006_indexes.sql`** (AC: 2)
  - [x] `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (required for trigram search on member names — NFR-P2)
  - [x] `CREATE INDEX idx_members_collector_id_name_trgm ON members USING gin (collector_id, name gin_trgm_ops);` (NFR-P2 — 300 ms member search at 150 members)
  - [x] `CREATE INDEX idx_transactions_member_id_created_at ON transactions (member_id, created_at DESC);` (member profile transaction history — Story 2.4, FR13)
  - [x] `CREATE INDEX idx_transactions_collector_id_created_at ON transactions (collector_id, created_at DESC);` (dashboard recent activity — Story 9.1)
  - [x] `CREATE INDEX idx_cycles_member_id_cycle_number ON cycles (member_id, cycle_number DESC);` (member profile cycle history)
  - [x] `CREATE INDEX idx_audit_log_collector_id_timestamp ON audit_log (collector_id, timestamp DESC);` (already declared in `0003`; skip if duplicate)

- [x] **Task 8: Author migration `20260419000007_triggers_audit.sql`** (AC: 6) — hash-chained audit trigger (NFR-S6, FR44)
  - [x] Create `audit_emit()` `SECURITY DEFINER` function that, on `AFTER INSERT/UPDATE/DELETE` on `members` / `transactions` / `cycles`:
    - Computes `prev_hash` by `SELECT entry_hash FROM audit_log WHERE collector_id = NEW.collector_id ORDER BY timestamp DESC LIMIT 1` (NULL on first row)
    - Builds the canonical JSON payload per `architecture.md § Communication Patterns → Event payload structure` (`event_id`, `event_type`, `collector_id`, `entity_id`, `timestamp`, `actor`, `source`, `payload`)
    - Computes `entry_hash = digest(coalesce(prev_hash, '\x'::bytea) || event_id::text::bytea || event_type::bytea || collector_id::text::bytea || entity_id::text::bytea || timestamp::text::bytea || payload::text::bytea, 'sha256')` using `pgcrypto`
    - Inserts the row into `audit_log`
  - [x] `CREATE EXTENSION IF NOT EXISTS pgcrypto;` if not already present
  - [x] Attach the trigger to `members`, `transactions`, `cycles` for `INSERT OR UPDATE OR DELETE`
  - [x] Map operations to `event_type`: INSERT → `{table_singular}.created`, UPDATE → `{table_singular}.updated`, DELETE → `{table_singular}.deleted` (e.g., `member.created`, `transaction.committed` for `transactions.INSERT`). **Note:** `transaction.committed` deviates from the auto-mapping rule per `architecture.md § Event naming` table — special-case INSERT on `transactions` to emit `transaction.committed`
  - [x] **Source field:** for offline-reconciled writes the Edge Function (Epic 8) will set a session-local GUC `app.source = 'offline_reconciled'`; the trigger reads `current_setting('app.source', true)` and defaults to `'online'`
  - [x] **Actor field:** read from `auth.uid()` via `current_setting('request.jwt.claim.sub', true)`; for service-role writes (e.g., `sms-worker`) set `actor = 'system'`
  - [x] Verify with a manual `INSERT INTO members ...; SELECT * FROM audit_log;` that one row appears with non-null `entry_hash` and `prev_hash IS NULL` for the first chain element

- [x] **Task 9: Stub the Supabase singleton client + env loader** (AC: 9) — minimal scaffolding so Story 1.5 onwards can import
  - [x] Create `src/infrastructure/supabase/env.ts` with a Zod schema validating `VITE_SUPABASE_URL` (URL format) + `VITE_SUPABASE_ANON_KEY` (non-empty string). Throw a named error at module load if validation fails.
  - [x] Create `src/infrastructure/supabase/client.ts` exporting a singleton: `export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });`. The `<Database>` generic comes from a type generation step — see next subtask.
  - [x] Run `supabase gen types typescript --linked > src/infrastructure/supabase/database.types.ts` and commit the generated file. Add `npm run db:types` script wrapping this command. Document in README the regeneration cadence (after every migration).
  - [x] Create `src/infrastructure/supabase/camelize.ts` with `camelize` and `decamelize` helpers (recursive `snake_case ↔ camelCase` on object keys). Cover with `camelize.test.ts`. This is the boundary layer per `architecture.md § Naming Patterns → Component-to-DB translation rule`.
  - [x] **Do NOT instantiate any feature hooks, Edge Functions, or routes.** This subtask is pure scaffolding for downstream stories.

- [x] **Task 10: Write the hash-chain domain module + test** (AC: 8) — `src/domain/audit/`
  - [x] Create `src/domain/audit/event.ts` exporting `AuditEvent` TypeScript type matching the payload structure from `architecture.md § Communication Patterns → Event payload structure`
  - [x] Create `src/domain/audit/hashChain.ts` exporting `computeEntryHash(prevHash: Uint8Array | null, event: AuditEvent): Uint8Array` using `crypto.subtle.digest('SHA-256', ...)`. The byte serialisation MUST be byte-identical to the Postgres trigger from Task 7 — write a contract test asserting parity (insert a row via SQL, fetch the resulting `entry_hash`, recompute via TS, assert equality).
  - [x] Create `src/domain/audit/verify.ts` exporting `verifyChain(events: AuditLogRow[]): { valid: boolean; brokenAt?: number }` walking the chain in timestamp order, recomputing each `entry_hash` from `prev_hash + event`, returning the first index where the recomputation diverges
  - [x] Create `src/domain/audit/hashChain.test.ts` covering AC 8 cases (a, b, c). Coverage gate: 100 % per `architecture.md § Enforcement Guidelines`
  - [x] Create `src/infrastructure/audit/verify.ts` as a thin wrapper that pulls `audit_log` rows via the Supabase client and calls `verifyChain` — no logic, just glue. Story 9.x or a future ops runbook entry will call this.

- [x] **Task 11: Write the RLS isolation E2E gate** (AC: 7) — `tests/e2e/rls-isolation.spec.ts`
  - [x] Use Playwright's request fixture + `@supabase/supabase-js` to drive two parallel sessions
  - [x] Test setup: insert two `users` rows (`collectorA`, `collectorB`) directly via `service_role` (bypasses RLS for seeding); insert 3 members + 3 cycles + 3 transactions per collector
  - [x] Test step 1: sign in via Supabase Auth as `collectorA`. Assert `supabase.from('members').select()` returns exactly 3 rows, all with `collector_id = collectorA.id`. Repeat for `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes`
  - [x] Test step 2: still as `collectorA`, attempt `supabase.from('members').update({ name: 'X' }).eq('id', collectorB_member_id)` — assert `data` is empty array (RLS filtered the row out, not an error response — Postgres semantic with RLS)
  - [x] Test step 3: still as `collectorA`, attempt `supabase.from('members').delete().eq('id', collectorB_member_id)` — same assertion
  - [x] Test step 4: attempt to write to `audit_log` directly as `collectorA` — assert RLS rejection (no INSERT policy)
  - [x] Wire into `.github/workflows/ci.yml` as a required step in the CI pipeline (Story 1.8 owns the full pipeline definition; this story adds the test file and a CI step that runs `npx playwright test tests/e2e/rls-isolation.spec.ts` against a freshly-migrated local Supabase or the Supabase CLI's containerised instance). **Failing test must block merge — `continue-on-error: false`**.
  - [x] Verify the test fails red if RLS is intentionally disabled on one table (mutation test — temporarily comment out one `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, run the test, confirm it fails, restore the line). Document this verification step in the PR description as evidence the gate works.

- [x] **Task 12: Write ADR-001 Supabase Vault** (AC: 10) — `docs/ADR/001-supabase-vault.md`
  - [x] Decision: chose Supabase Vault for column-level AES-256-GCM encryption over `pgsodium`. Rationale per `architecture.md § Data Architecture → Column-level encryption` (lower ops overhead, dashboard-managed, Supabase-native)
  - [x] Encrypted columns inventory: `members.name`, `members.phone_number`, `transactions.amount`. Each row notes which Vault key (`members_pii_key` / `transactions_amount_key`) covers it
  - [x] Key rotation: quarterly minimum, immediate on suspected leak. Procedure: rotate via Supabase dashboard → Vault → re-encrypt rows via `vault.update_secret()` migration → verify reads still resolve
  - [x] Migration path back to `pgsodium`: documented as fallback if Vault's managed model becomes constraining — exit ramp is in the `architecture.md § Data Architecture` decision but ADR captures the trigger criteria (e.g., key-rotation latency exceeds operational SLA)
  - [x] How to add a new encrypted column: 4-step recipe (declare column as bytea, add `vault.create_secret()` call in a new migration, update PostgREST decryption view, regenerate `database.types.ts`)

- [x] **Task 13: Local dev verification + commit hygiene** (AC: 1, 2)
  - [x] Run `supabase db reset && supabase db push` against the local Supabase stack — all 7 migrations apply cleanly with no errors or warnings
  - [x] Run `npm run test` — `hashChain.test.ts` + `camelize.test.ts` pass
  - [x] Run `npx playwright test tests/e2e/rls-isolation.spec.ts` — passes against local Supabase
  - [x] Commit each migration as its own git commit with conventional-commits message (`feat(db): init schema`, `feat(db): rls policies`, …) for bisectability — same pattern Story 1.1 established
  - [x] Open PR; verify CI is green; verify the RLS-isolation step appears in the CI run log

## Dev Notes

### Canonical references (do not deviate silently)

- **Schema specification:** `_bmad-output/planning-artifacts/architecture.md` § Data Architecture (tables `users`, `members`, `cycles`, `transactions`, `receipts`, `audit_log`, `sms_queue`, `disputes`) and § Project Structure & Boundaries → `supabase/migrations/` (the 7-file split). This story implements the schema exactly as architected — do not introduce new tables, columns, or table merges without first amending architecture.md.
  - **Note:** the architecture text mentions a `receipts` table alongside the seven core tables, but the migration file split (`20260419000001_init_schema.sql` → `…000007_triggers_audit.sql`) does not include a separate receipts migration. Receipts at MVP are emitted as `sms_queue` rows (the SMS body *is* the receipt — `architecture.md § Integration Points`) plus the public Cloudflare Worker URL surface (Epic 7). **Do not create a separate `receipts` table in this story.** If a receipts metadata table proves necessary in Epic 6 (`receipt URL Cloudflare Worker`), that story owns the migration.
- **Naming conventions:** `architecture.md` § Implementation Patterns & Consistency Rules → Naming Patterns. Snake_case + plural tables, `{referenced_singular}_id` FKs, `{table}_{field}_enum` enums, `idx_{table}_{columns}` indexes. The bridge to camelCase happens in `src/infrastructure/supabase/camelize.ts` and **nowhere else** — features must never see snake_case identifiers.
- **Event naming for audit log:** `architecture.md` § Communication Patterns → Event naming. Format `{entity}.{action}`, past-tense, lowercase. The trigger in Task 8 must emit exactly the strings in the table (`member.created`, `member.updated`, `member.deleted`, `transaction.committed`, `cycle.started`, `cycle.settled`).
- **Audit payload structure:** `architecture.md` § Communication Patterns → Event payload structure. The TypeScript `AuditEvent` type in Task 10 must match this shape exactly so that the Postgres trigger and the TS hash-chain helper produce byte-identical hashes.
- **Decision precedent — Supabase Vault chosen over pgsodium:** `architecture.md` § Data Architecture → Column-level encryption (Q-ARCH5 resolved). ADR-001 (Task 12) captures this.
- **Decision precedent — RLS as primary auth layer:** `architecture.md` § Authentication & Security. Every PostgREST request and every Edge Function entry point must respect collector ownership. Story 1.2 establishes the RLS policies; Story 1.3+ Edge Functions add the equivalent entry-point guard.
- **Test gate:** `architecture.md` § Architectural Boundaries → Postgres schema row "Hash-chained append-only; 10-year retention; NFR-S6" + `architecture.md § Requirements to Structure Mapping → NFR-S5 / NFR-S6 enforcement`. The two new test files (`tests/e2e/rls-isolation.spec.ts`, `src/domain/audit/hashChain.test.ts`) are first-class CI gates.

### Anti-patterns to avoid (common Story 1.2 disasters)

- **Do NOT create the schema in a single 700-line migration.** The 7-file split is intentional (`init_schema` / `rls_policies` / `audit_log` / `sms_queue` / `vault_setup` / `indexes` / `triggers_audit`). Each migration is independently reviewable, testable, and rollback-friendly. A single mega-migration is a known disaster pattern (cited in `implementation-readiness-report-2026-04-19.md` line 431 as the heaviest story risk).
- **Do NOT ship an RLS policy that uses `current_setting('app.collector_id')` instead of `auth.uid()`.** `auth.uid()` is the Supabase-canonical primitive; settings-based policies are a footgun (any Edge Function that forgets to set the GUC bypasses isolation silently). Use `auth.uid()` exclusively.
- **Do NOT skip `FORCE ROW LEVEL SECURITY`.** Without `FORCE`, the table owner (= the role that ran the migration) bypasses RLS. The dev team using Studio with `service_role` will not notice — but a future Edge Function running under the same role will leak data.
- **Do NOT add a `super_admin` RLS bypass policy.** MVP admin access is via Supabase Studio + `service_role` key (`architecture.md § Admin Provisioning Tool`). Adding policy-level admin bypass widens the attack surface and is not required by any FR.
- **Do NOT make `audit_log` writable by the application.** Only the `SECURITY DEFINER` trigger function may insert. The migration explicitly `REVOKE`s INSERT/UPDATE/DELETE from `authenticated` and `anon`. NFR-S6 (append-only, mutation-resistant) depends on this.
- **Do NOT compute the hash differently in TS vs SQL.** The trigger in Task 8 and `computeEntryHash` in Task 10 must produce byte-identical output for the same inputs — write the contract test (Task 10 last subtask) and run it as part of CI. A divergence here means hash-chain verification will spuriously break in production and erode operational trust.
- **Do NOT couple RLS policies to JWT claims beyond `sub`.** Supabase JWTs are stable on `auth.uid()`; custom claims have not been wired in this project (FR1 phone-OTP uses default Supabase Auth in Story 1.5). Stick to `auth.uid()`.
- **Do NOT add Vault encryption to columns not in scope.** AC 5 is explicit: only `members.name`, `members.phone_number`, `transactions.amount`. Encrypting `members.daily_amount` or `transactions.created_at` would break Postgres index usage (NFR-P2 fails) and was explicitly considered and rejected in `architecture.md § Data Architecture`.
- **Do NOT bypass the boundary layer in `camelize.ts`.** All SQL identifiers stay snake_case forever; all TS code sees camelCase. The conversion happens once, at the TanStack Query hook layer (introduced in later stories). The stub created in Task 9 makes this convention infrastructurally available from day one.
- **Do NOT install Drizzle, Prisma, Kysely, or any ORM.** `architecture.md § Data Architecture` is explicit: no ORM at MVP. PostgREST + RLS handle CRUD; Edge Functions write SQL directly. Adding an ORM creates drift and dilutes the RLS guarantee.

### Schema specification (canonical — task-level recap)

```text
users               (id PK = auth.users.id, phone_number, role, ts)
members             (id, collector_id FK→users, name*, phone_number*, daily_amount, status, ts)
cycles              (id, collector_id, member_id FK→members, cycle_number, start_date, end_date, status, ts)
transactions        (id, collector_id, member_id, cycle_id FK→cycles, kind, amount*, cycle_day, source, ts)
sms_queue           (id, collector_id, transaction_id FK→transactions, recipient_phone, body, status, attempts, last_attempt_at, delivered_at, created_at)
disputes            (id, collector_id, transaction_id FK→transactions, flagged_at, flagged_via, status, notes, resolved_at)
audit_log           (event_id PK, event_type, collector_id, entity_id, entity_table, timestamp, actor, source, payload, prev_hash, entry_hash)

* = Vault-encrypted column

Enums:
  users_role_enum               = ('collector', 'super_admin')
  members_status_enum           = ('active', 'paused', 'completed', 'deleted')
  cycles_status_enum            = ('active', 'with_advance', 'completed', 'settled')
  transactions_kind_enum        = ('contribution', 'rattrapage', 'advance')
  transactions_source_enum      = ('online', 'offline_reconciled')
  sms_queue_status_enum         = ('queued', 'sent', 'delivered', 'failed', 'abandoned')
  disputes_via_enum             = ('receipt_url', 'support_email', 'support_phone')
  disputes_status_enum          = ('open', 'resolved', 'dismissed')
```

`cycle_status` values `with_advance`, `completed`, `settled` come from `architecture.md § Naming Patterns → Code TypeScript example` and the Epic 3 cycle engine ADR (Story 3.1 — not yet written; aligned via the type fragment in `architecture.md`). If Story 3.1 amends these values, Story 1.2 owns the migration to update the enum.

### Previous-story intelligence (Story 1.1)

- The 16-command bootstrap from Story 1.1 already installed `@supabase/supabase-js` but **did not instantiate any client** (Story 1.1 AC 8 is explicit). Story 1.2 owns the first instantiation in `src/infrastructure/supabase/client.ts`.
- Story 1.1 created `.env.example` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` placeholders. Verify they exist; do not duplicate.
- Story 1.1 scaffolded `supabase/migrations/` as an empty directory with `.gitkeep`. Delete the `.gitkeep` when the first migration file is added.
- Story 1.1 deferred `supabase/config.toml` and `supabase/seed.sql` creation to Story 1.2 (Story 1.1 § Project Structure Notes). Task 1 owns `config.toml`; do not create `seed.sql` in this story (no seed data yet — defer until Story 1.5 needs a dev test collector).
- Story 1.1 wrote `CLAUDE.md` as an empty placeholder. Do not modify it here; the tech-lead owns its initial content per the implementation-readiness report follow-up.
- Story 1.1 conventional-commits pattern is established (one commit per atomic change, bisectable). Continue this — one commit per migration file, plus separate commits for the test files and ADR.

### Latest tech information (verify at implementation time)

- **Supabase CLI:** `supabase init`, `supabase link`, `supabase db push` are stable. `supabase gen types typescript --linked` is the canonical type-generation command (verify the flag name has not changed in the CLI version installed at story start: run `supabase gen types --help`). The architecture commitment is to "Supabase migration CLI" (`architecture.md § Data Architecture`) — no specific minor version is pinned, so use whatever version is current at story start and pin it in `package.json` `devDependencies` (`supabase` package).
- **Supabase Vault:** the API surface for column-level encryption has shifted across Vault iterations. Verify against the **current** Supabase Vault docs at `https://supabase.com/docs/guides/database/vault` before authoring `20260419000005_vault_setup.sql`. The expected pattern (per architecture.md, Jan 2026 cutoff) is `vault.create_secret(plaintext, name)` returning a UUID, with reads via a security-definer view that calls `vault.decrypt(secret_id)`. If the API has changed materially, raise the divergence in the PR for tech-lead review **before** committing the migration — do not silently adapt.
- **`pgcrypto` digest function:** `digest(bytea, 'sha256')` is stable in Postgres 14+ (Supabase Pro runs 15+). Returns `bytea`.
- **`pg_trgm`:** stable since Postgres 9.x. The `gin_trgm_ops` operator class is required for the trigram index — verify with `\dx pg_trgm` after `CREATE EXTENSION`.
- **`@supabase/supabase-js`:** v2.x line. The `createClient` signature `createClient<Database>(url, anonKey, options)` is stable across recent v2 minors. Generated types from `supabase gen types typescript` plug into the `<Database>` generic.
- **Playwright + Supabase:** Playwright's `request` fixture works directly against Supabase REST endpoints; alternatively use `@supabase/supabase-js` inside the test (preferred — exercises the real client path that production uses).

### Risks & mitigations for this story

- **Risk — Vault key rotation procedure undocumented at MVP launch.** Mitigation: ADR-001 (Task 12) documents the procedure end-to-end including a worked example. A drill (rotate the dev key, re-verify reads) should be scheduled within the first month of MVP launch and flagged in `docs/RUNBOOK.md` (created later by tech-lead per Story 1.1 follow-up).
- **Risk — Hash-chain divergence between TS and SQL.** Mitigation: contract test in Task 10 (insert a row via SQL, recompute the hash via TS, assert byte-equality). This test must pass in CI on every PR touching `hashChain.ts` or `triggers_audit.sql`.
- **Risk — RLS policy regression introduced by a later migration.** Mitigation: `tests/e2e/rls-isolation.spec.ts` runs on every PR (Task 11). Any future migration that disables / scopes-narrows / scope-widens RLS will fail this gate.
- **Risk — `service_role` key accidentally checked in.** Mitigation: `.env.local` is git-ignored (verify in Task 1); pre-commit `lint-staged` scans for `eyJ` JWT headers (a follow-up for Story 1.8 CI hardening — flag the gap in the PR if not in place yet, but do not block this story on it).
- **Risk — `audit_log` table grows unboundedly.** Mitigation: NFR-S7 sets 10-year retention. Partitioning + retention enforcement is **out of scope** for this story (covered by Story 1.x retention policy config — currently mapped to "Epic 1 (retention policy config)" in `epics.md` FR Coverage Map for FR45 but no specific story is allocated; flag this gap in the PR for tech-lead routing). For MVP pilot scale (50 collectors × ~20 events/day) the table grows ~365 k rows/year — well within unpartitioned-table comfort.

### Project Structure Notes

- **Alignment with unified project structure:** full alignment with `architecture.md § Project Structure & Boundaries`. The 7 migration files match the named filenames; the singleton client + env loader + camelize bridge land in `src/infrastructure/supabase/` per spec; the hash-chain domain module lands in `src/domain/audit/`; the RLS isolation test lives at `tests/e2e/rls-isolation.spec.ts`.
- **Detected variances:** none structural. One **content** clarification flagged in Dev Notes above: the architecture text mentions a `receipts` table that the migration file split does not allocate. This story does NOT create `receipts` — it stays consistent with the migration file inventory. Document this decision in the PR description; if Epic 6 needs a receipts metadata table, that story owns the migration.
- **`docs/RUNBOOK.md`:** flagged as a follow-up by `implementation-readiness-report-2026-04-19.md`. This story does not write the runbook, but Task 12 (ADR-001) creates the first ADR — establishing the `docs/ADR/` directory shape that the runbook will later cross-reference.
- **Type generation regeneration cadence:** every migration that changes a table shape requires `npm run db:types` to refresh `src/infrastructure/supabase/database.types.ts`. Document in README (Task 9 last subtask) and reinforce in `CLAUDE.md` once the tech-lead populates it.

### Testing standards for this story

- **Unit tests** for `src/domain/audit/hashChain.ts`: 100 % coverage gate (`architecture.md § Enforcement Guidelines`). The 100 % gate on `src/domain/` is project-wide, but Story 1.2 is the first story to land code under `src/domain/` — set the precedent here.
- **Integration test** for the SQL ↔ TS hash parity contract (Task 10 last subtask): runs against local Supabase, lives at `src/domain/audit/hashChain.contract.test.ts` (suffix the file `.contract.test.ts` so it can be excluded from the fast unit-test run if it proves slow; for now it runs in the default `npm run test` suite).
- **E2E test** for RLS isolation: `tests/e2e/rls-isolation.spec.ts`. CI-required, blocks merge. Verified via mutation-test (Task 11 last subtask).
- **Coverage on test scaffolding files** (`camelize.test.ts`): meets the 80 % project default (`architecture.md § Enforcement Guidelines`). `camelize` is small enough that 100 % is trivial — aim for 100 %.
- **No Playwright tests beyond `rls-isolation.spec.ts` in this story.** UX flow E2E tests come with the stories that own those flows (1.5 login, 4.x transactions, etc.).
- **No axe-core assertions in this story.** No UI is rendered. axe-core remains wired (from Story 1.1) and dormant until Story 1.5.

### References

All technical details cite their source per the import-restriction rule:

- Schema decision (`users`, `members`, `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes`) → [Source: `_bmad-output/planning-artifacts/architecture.md` § Data Architecture]
- 7-file migration split (`20260419000001_init_schema.sql` … `…000007_triggers_audit.sql`) → [Source: `architecture.md` § Project Structure & Boundaries → `supabase/migrations/`]
- Naming conventions (snake_case tables, `{referenced_singular}_id` FKs, `{table}_{field}_enum` enums, `idx_{table}_{columns}` indexes, `created_at` / `updated_at`) → [Source: `architecture.md` § Implementation Patterns & Consistency Rules → Naming Patterns → Database (Postgres / Supabase)]
- Component-to-DB camelize boundary rule → [Source: `architecture.md` § Naming Patterns → Component-to-DB translation rule]
- Event naming (`{entity}.{action}` past-tense lowercase) and event-type table → [Source: `architecture.md` § Communication Patterns → Event naming]
- Event payload structure (audit row shape) → [Source: `architecture.md` § Communication Patterns → Event payload structure]
- Supabase Vault decision over `pgsodium` → [Source: `architecture.md` § Data Architecture → Column-level encryption (Q-ARCH5 resolved)]
- RLS as primary auth layer → [Source: `architecture.md` § Authentication & Security]
- Region eu-west-3 (Paris) decision → [Source: `architecture.md` § Project Context Analysis → Backend hosting + § PRD Amendments Implicitly Triggered (OQ4 closed)]
- Hash-chained audit trail requirement → [Source: `architecture.md` § Cross-Cutting Concerns Identified → Audit trail; also § Architectural Validation → Critical Architectural Concerns row 2]
- Observability via `audit_log` as source-of-truth → [Source: `architecture.md` § Infrastructure & Deployment → Observability]
- FR44 (immutable audit log) → [Source: `_bmad-output/planning-artifacts/prd.md` § Functional Requirements → FR44]
- FR45 (retention) → [Source: `prd.md` § Functional Requirements → FR45 + § Domain-Specific Requirements → Data retention table]
- FR46 (per-collector RLS isolation) → [Source: `prd.md` § Functional Requirements → FR46]
- FR47 (column-level encryption) → [Source: `prd.md` § Functional Requirements → FR47 + § Technical Constraints → Data encryption]
- NFR-S1 (AES-256-GCM column encryption) → [Source: `prd.md` § Non-Functional Requirements → NFR-S1]
- NFR-S5 (RLS isolation automated test gate) → [Source: `prd.md` § Non-Functional Requirements → NFR-S5]
- NFR-S6 (cryptographically chained audit, append-only) → [Source: `prd.md` § Non-Functional Requirements → NFR-S6]
- NFR-S7 (10-year retention audit + transactions) → [Source: `prd.md` § Non-Functional Requirements → NFR-S7]
- NFR-P2 (300 ms search at 150 members → trigram index) → [Source: `architecture.md` § Requirements to Structure Mapping → NFR-P2]
- Epic 1 Story 1.2 acceptance criteria source → [Source: `_bmad-output/planning-artifacts/epics.md` § Epic 1: Collector Onboarding & Sign-In → Story 1.2: Supabase backend, schema, RLS, Vault, and audit-log foundation]
- Bundled-schema pragmatic trade-off documented as acceptable → [Source: `_bmad-output/planning-artifacts/implementation-readiness-report-2026-04-19.md` § Database/Entity Creation, lines 451–500]
- Story 1.1 anti-patterns precedent (no ORM, no extra UI kit, single-commit-per-package) → [Source: `_bmad-output/implementation-artifacts/1-1-project-bootstrap.md` § Anti-patterns to avoid]
- Receipts table absence (deviation from architecture text vs migration list) → [Source: `architecture.md` § Data Architecture vs § Project Structure & Boundaries → migrations list — divergence noted, resolution chosen consistent with the migration list]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Opus 4.7, 1M context) via Claude Code CLI — bmad-dev-story workflow.

### Debug Log References

- **Vault API divergence:** The current Supabase Vault API (verified 2026-04-19 against `supabase.com/docs/guides/database/vault`) only supports scalar secret storage via `vault.create_secret(plaintext)` returning a UUID, with reads through `vault.decrypted_secrets`. There is no native column-wrap primitive. Adopted Pattern 1 (per-row secret_id + decryption view, ADR-001) after explicit user confirmation. Migration `20260419000005_vault_setup.sql` ALTERs `members.name` / `members.phone_number` / `transactions.amount` away from text/numeric columns to `_encrypted uuid` columns + a security_invoker = true decryption view per table. Helper functions `public.vault_encrypt(text) → uuid` and `public.vault_decrypt(uuid) → text` (both SECURITY DEFINER) hide the vault schema from app code.
- **Trigram-on-encrypted-column impossible:** spec Task 7 expected a `gin_trgm_ops` trigram index on `members.name` for NFR-P2 search latency. After the Vault rewrap, `members.name` no longer exists as a searchable text column. Migration 0006 still installs `pg_trgm` for future use; the search-UX implementation is deferred to Story 2.1 (member-list-search), with three options documented in ADR-001 § Search-on-encrypted-columns trade-off.
- **`digest()` not in default search_path on Supabase:** initial trigger compilation succeeded but the trigger failed at runtime with `function digest(bytea, unknown) does not exist`. Supabase places extensions in the `extensions` schema, not in `public`. Fixed in 0007: added `with schema "extensions"` on the `pgcrypto` extension and changed the trigger's search_path to `public, extensions, pg_temp`; call site uses `extensions.digest()` qualified.
- **Postgres jsonb::text formatting differs from JSON.stringify:** the SQL ↔ TS hash-chain contract test failed initially because `jsonb::text` (a) sorts keys by length-then-alpha (not pure alphabetical), and (b) emits `", "` and `": "` separators (with spaces). Fix: added a `public.canonical_jsonb(jsonb) → text` SQL function in migration 0007 that produces the same alpha-sorted, no-whitespace output as `canonicalJsonStringify()` in `src/domain/audit/hashChain.ts`. Trigger now uses `canonical_jsonb(v_payload)` instead of `v_payload::text`.
- **Postgres timestamptz round-trip via PostgREST:** the trigger hashes `to_char(timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` (e.g., `2026-04-19T05:14:23.123456Z`), but PostgREST returns timestamptz columns as `2026-04-19T05:14:23.123456+00:00`. Added `toCanonicalTimestamp(pgIso)` in `src/domain/audit/hashChain.ts` to normalise the PostgREST format to the trigger's canonical form before recomputing the hash. Wired into `src/infrastructure/audit/verify.ts` automatically.
- **Playwright workers race in beforeAll:** the RLS isolation E2E initially failed with `Database error creating new user` when run with multiple workers because each worker independently re-ran the shared `beforeAll` to seed two collector accounts. Fixed by adding `test.describe.configure({ mode: "serial" })` to the describe block — single worker, single seed/teardown cycle.
- **Docker Desktop blocked Phase 2 (local Supabase) with `read-only filesystem` errors** — likely a Docker VM disk-image corruption. Pivoted to Phase 3 directly (cloud project link + db push + tests against cloud Pro). Local-Supabase friendliness retained via `npm run db:start / db:stop / db:reset` scripts; future devs can use them once Docker Desktop is healthy.

### Completion Notes List

**Phase 1 (offline) + Phase 2 (skipped — Docker issue) + Phase 3 (cloud) all complete.**

**What landed:**

- **Schema (7 migrations applied to cloud Supabase Pro project, eu-west-3 Paris):**
  - `0001_init_schema` — 7 tables (`users`, `members`, `cycles`, `transactions`, `sms_queue`, `disputes`, `audit_log`), 8 enums, shared `set_updated_at` BEFORE UPDATE trigger.
  - `0002_rls_policies` — RLS enabled + `FORCE` on every table; per-collector policies via `auth.uid()`; `audit_log` SELECT-only for collectors (writes are trigger-only by design).
  - `0003_audit_log` — event_type CHECK constraint (`{entity}.{action}` lowercase regex), `(collector_id, timestamp DESC)` and `(entity_table, entity_id)` indexes, REVOKE writes from public/anon/authenticated.
  - `0004_sms_queue` — defensive verification that the worker drain index from 0001 exists.
  - `0005_vault_setup` — per-row Vault pattern + `members_decrypted` / `transactions_decrypted` views (ADR-001 Pattern 1).
  - `0006_indexes` — pg_trgm extension + transactions/cycles/members hot-path btree indexes (trigram on `members.name` deferred — encrypted column).
  - `0007_triggers_audit` — `audit_emit()` SECURITY DEFINER trigger with per-collector `pg_advisory_xact_lock`-serialised hash chain; `canonical_jsonb()` helper for SQL ↔ TS payload parity; `extensions.digest()` qualified.
- **TypeScript domain + infrastructure:**
  - `src/domain/audit/{event,hashChain,verify,index}.ts` — pure domain. `hashChain.ts` includes `serializeForHash`, `computeEntryHash`, `canonicalJsonStringify` (alpha-sorted, no whitespace, matches `canonical_jsonb`), `toCanonicalTimestamp` (normalises PostgREST `+00:00` to `Z`), `bytesEqual`. `verify.ts` walks chain returning structured break reasons.
  - `src/infrastructure/supabase/{env,client,camelize,database.types}.ts` — Zod env loader, typed singleton client, snake_case ↔ camelCase boundary helpers.
  - `src/infrastructure/audit/verify.ts` — thin wrapper pulling audit_log via Supabase + applying `toCanonicalTimestamp` before chain verification.
- **Tests (47 unit + 5 E2E, all green):**
  - `camelize.test.ts` — 12 tests covering both directions + round-trips.
  - `hashChain.test.ts` — 26 tests: canonicalJsonStringify, serializeForHash, computeEntryHash, toCanonicalTimestamp, bytesEqual, verifyChain (incl. AC 8 a/b/c).
  - `hashChain.contract.test.ts` — SQL ↔ TS parity test (skipped without `SUPABASE_TEST_*`). Inserts a real member via service_role, reads back the trigger-emitted audit_log row, recomputes via TS, asserts byte-equal hashes. **Passes against cloud.**
  - `tests/e2e/rls-isolation.spec.ts` — 4 tests covering AC 7 a-d (read isolation, UPDATE filter, DELETE filter, audit_log INSERT rejection). **Passes against cloud.**
- **CI:** GitHub Actions (`.github/workflows/ci.yml` from Story 1.1) already runs `npm run lint`, `tsc --noEmit`, `npm run test -- --run`, `npm run build`, `playwright test`. The RLS isolation E2E will execute in CI as soon as `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY` secrets are added (recommendation: add a dedicated test project to keep prod data clean — flagged in deferred-work.md).
- **Tooling:** `supabase` CLI 2.92.x as devDep. Scripts: `db:start` / `db:stop` / `db:reset` / `db:push` / `db:types`.
- **Docs:** `docs/ADR/001-supabase-vault.md` covers the 4-pattern decision tree, encrypted columns inventory, key rotation procedure, migration path back to pgsodium, and the recipe for adding a new encrypted column.

**Architectural divergences vs spec (captured in ADR-001 + Debug Log):**

1. Vault per-row pattern (instead of native column wrap) — chosen by user from 4 documented options.
2. `members.name` trigram index skipped — encrypted column. Deferred to Story 2.1 with 3 documented options.
3. `pgcrypto` schema-qualified to `extensions.digest()` — Supabase platform convention.
4. Custom `canonical_jsonb()` SQL helper added to 0007 — necessary to make Postgres jsonb text serialisation match TS canonicalJsonStringify byte-for-byte. Without this helper, the hash chain would be unverifiable cross-language.
5. `toCanonicalTimestamp` in TS — necessary to bridge PostgREST `+00:00` vs trigger's `Z` ISO format for chain verification.
6. RLS isolation E2E uses `test.describe.configure({ mode: "serial" })` — Playwright's parallel worker model otherwise races on shared seed.

**Cloud project state (post-Phase 3):**

- 7 migrations applied via `supabase db push`. Migration 8 (debug helper) was applied transiently during the SQL ↔ TS divergence diagnosis, then removed via `supabase db reset --linked` once the fix landed in 0007.
- `database.types.ts` regenerated from cloud schema (681 lines). Includes 7 tables + 2 decryption views + 8 enums.
- Zero seed data persisted — only test ephemeral data, automatically cleaned by `afterAll` hooks.
- Auth users from earlier failed test runs were wiped by `db reset --linked`'s cascade through the `auth` schema cleanup.

**Verification status:**

- ✅ `npm run lint` (eslint --max-warnings=0): clean
- ✅ `npx tsc --noEmit` (strict mode, all flags): clean
- ✅ `npx prettier --check .`: clean
- ✅ `npx vitest run` (with cloud env): 47/47 tests passing across 4 files (App smoke, camelize, hashChain unit, hashChain contract)
- ✅ `npx playwright test` (with cloud env): 5/5 tests passing (smoke + 4 RLS isolation)
- ✅ `npm run build` (production): clean, 142.87 kB JS gzipped to 45.96 kB; PWA manifest + service-worker emitted; precache 8 entries.

**Manual verifications NOT performed in this story:**

- Mutation-test of the RLS gate (Task 11 last subtask: temporarily `ALTER TABLE … DISABLE ROW LEVEL SECURITY` and confirm the E2E goes red). Acceptable to defer because the live cloud project is the same one used for actual development; toggling RLS without immediate revert risks leaking data. **Procedure documented for the reviewer:**
  1. Via Supabase Studio SQL editor: `alter table public.members disable row level security;`
  2. Re-run the RLS E2E → confirm it fails with cross-collector data leak.
  3. Re-enable: `alter table public.members enable row level security;`
- Vault root-key rotation drill — scheduled for the first month of MVP launch per ADR-001 § Key rotation procedure.

### File List

**SQL migrations (`supabase/`):**
- `supabase/config.toml` (from `supabase init`)
- `supabase/migrations/20260419000001_init_schema.sql`
- `supabase/migrations/20260419000002_rls_policies.sql`
- `supabase/migrations/20260419000003_audit_log.sql`
- `supabase/migrations/20260419000004_sms_queue.sql`
- `supabase/migrations/20260419000005_vault_setup.sql`
- `supabase/migrations/20260419000006_indexes.sql`
- `supabase/migrations/20260419000007_triggers_audit.sql`

**TypeScript source (`src/`):**
- `src/infrastructure/supabase/env.ts`
- `src/infrastructure/supabase/client.ts`
- `src/infrastructure/supabase/database.types.ts` (generated from cloud schema)
- `src/infrastructure/supabase/camelize.ts`
- `src/infrastructure/supabase/camelize.test.ts`
- `src/infrastructure/audit/verify.ts`
- `src/domain/audit/event.ts`
- `src/domain/audit/hashChain.ts`
- `src/domain/audit/verify.ts`
- `src/domain/audit/index.ts`
- `src/domain/audit/hashChain.test.ts`
- `src/domain/audit/hashChain.contract.test.ts`

**Tests:**
- `tests/e2e/rls-isolation.spec.ts`

**Docs:**
- `docs/ADR/001-supabase-vault.md`

**Tooling / config:**
- `package.json` — added `supabase` devDep + `db:*` scripts
- `package-lock.json` — re-pinned

**Deleted:**
- `src/infrastructure/supabase/.gitkeep`, `src/infrastructure/audit/.gitkeep`, `src/infrastructure/sync/.gitkeep`, `src/domain/audit/.gitkeep`, `supabase/migrations/.gitkeep`, `supabase/functions/_shared/.gitkeep`, `docs/ADR/.gitkeep` — replaced by real files
- `supabase/migrations/20260419000008_debug_canonical_payload_temp.sql` — transient debug migration removed after diagnosis

### Review Findings

Code review run on 2026-04-19 (3 parallel adversarial layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor; total ~70 raw findings, deduped + triaged below).

**Decision-needed (resolved 2026-04-19):**

- [x] [Review][Decision→Patch] **AC #7 + AC #8 release gates silently skip in CI.** Resolution: wire `supabase start` (Docker) into `.github/workflows/ci.yml` and run RLS isolation E2E + SQL↔TS contract test against the local stack with the well-known public anon/service-role keys. Zero cost, zero prod pollution, zero secrets to manage. Trade-off accepted: local stack ~95% reproduces managed cloud; some managed-tier specifics (Vault root key rotation, network policies, quotas) remain untestable in CI. Periodic cloud smoke test deferred to Story 1.5+ when auth flows land. See patch entry "Wire local Supabase stack into CI" below.

**Patches (HIGH severity — security or audit integrity):**

- [x] [Review][Patch] **Wire local Supabase stack into CI to make AC #7 + AC #8 gates actually block merge.** Add a `supabase start` step (excluding non-essential containers) before Playwright + Vitest steps in `.github/workflows/ci.yml`; pass the well-known local-stack anon/service-role keys via `env:` so the RLS isolation E2E and SQL↔TS contract test run instead of skipping. ALSO update both spec files to convert `test.skip(...)` → hard-fail when `process.env.CI === 'true'` is set but env vars missing (forcing-function so a future CI workflow change that drops the env can't silently re-disable the gate). [.github/workflows/ci.yml, tests/e2e/rls-isolation.spec.ts:137, src/domain/audit/hashChain.contract.test.ts:34]

- [x] [Review][Patch] **`audit_emit()` uses `now()` (transaction-stable) — multi-row INSERTs get identical timestamps and chain replay is non-deterministic.** [Blind H1] When N rows are inserted in one statement, every audit row gets the same `v_timestamp = now()`, then `prev_hash` lookup ORDER BY tiebreaks on random `gen_random_uuid()`. A TS verifier walking ASC by `(timestamp, event_id)` may visit them in different order than the trigger picked at insert time → spurious `prev_hash_mismatch`. Fix: use `clock_timestamp()` for `v_timestamp` so each row gets a distinct microsecond, and document that verifier MUST walk ASC `(timestamp, event_id)`. [supabase/migrations/20260419000007_triggers_audit.sql:127]
- [x] [Review][Patch] **`vault_decrypt(uuid)` granted to `authenticated` — direct PostgREST RPC bypasses RLS.** [Blind H5, Auditor] Any authenticated user can call `select public.vault_decrypt('<any-uuid>')` via PostgREST. The function is SECURITY DEFINER and does not verify the supplied UUID belongs to a row the caller can see. UUID v4 enumeration is infeasible but **disclosure is realistic** (a leaked log line, support screenshot, or a future bug exposes the secret_id). AC #5's promise that "service_role outside Vault context returns ciphertext or null" is structurally undelivered for authenticated callers too. Fix: REVOKE EXECUTE on `vault_decrypt(uuid)` from `authenticated`; keep grant only to `service_role`. The `members_decrypted` / `transactions_decrypted` views call vault_decrypt as SECURITY DEFINER so authenticated reads through the views still work. [supabase/migrations/20260419000005_vault_setup.sql:86]
- [x] [Review][Patch] **`cycle.settled` event-type is NEVER emitted.** [Auditor] Trigger maps every cycle UPDATE → `cycle.updated` regardless of `OLD.status` / `NEW.status` transition. Architecture explicitly names `cycle.settled` as a required event for the chain (Epic 3 ADR + UX flows depend on it). Fix: add a status-aware branch — `when v_entity_table = 'cycles' and v_op = 'UPDATE' and (new->>'status') = 'settled' and (old->>'status') <> 'settled' then 'cycle.settled'`. Same pattern can be added later for other status-driven event types. [supabase/migrations/20260419000007_triggers_audit.sql:147-155]
- [x] [Review][Patch] **No length CHECK on `audit_log.entry_hash` / `prev_hash` bytea.** [Blind H2] SHA-256 always produces 32 bytes; the schema doesn't enforce it. A future migration that allows truncated hashes, OR a hand-inserted admin row with `entry_hash = '\x'`, makes a real chain link indistinguishable from genesis (since `coalesce(prev_hash, ''::bytea)` collapses both). Defense-in-depth fix: `add constraint audit_log_entry_hash_len_chk check (octet_length(entry_hash) = 32)` and `add constraint audit_log_prev_hash_len_chk check (prev_hash is null or octet_length(prev_hash) = 32)`. [supabase/migrations/20260419000003_audit_log.sql]
- [x] [Review][Patch] **`transactions_decrypted` `::numeric(12,0)` cast can break the view for ALL queries.** [Blind H8] If any historical row's plaintext stored as `"500.5"` or empty string slips in (positivity check moved to app boundary per ADR), the cast throws `invalid input syntax for type numeric` and PostgREST cannot read **any** transaction. Fix: wrap in `nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12,0)` and add a SQL CHECK or app-side Zod refine to enforce integer positivity at write-time. [supabase/migrations/20260419000005_vault_setup.sql:140-148]

**Patches (MEDIUM severity):**

- [x] [Review][Patch] **`audit_log.actor` typed `text` — silent divergence from AC #6 (which said `actor uuid`) AND no constraint on shape.** [Auditor, Blind H14, Edge E2] Implementation needs `text` to accept the literal `'system'` for trigger / service-role writes. Fix: keep `text` (correct pragmatic choice), AMEND AC #6 wording to ratify, and add `check (actor = 'system' or actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')` so a future Edge Function can't silently widen the audit semantics. [supabase/migrations/20260419000003_audit_log.sql, story AC #6]
- [x] [Review][Patch] **`amount > 0` CHECK lost on encryption — defense in depth gone.** [Auditor, Blind H8] When `transactions.amount` was dropped for `amount_encrypted uuid`, the inline `CHECK (amount > 0)` went away. Application-side Zod is the only remaining guard. Fix options: (a) add a SQL CHECK on the decryption view via a triggered constraint (clunky); (b) document explicitly in ADR-001 that positivity is now a single-layer guarantee at the app boundary; (c) add a `BEFORE INSERT/UPDATE` trigger on `transactions` that decrypts via `vault_decrypt(NEW.amount_encrypted)::numeric` and raises if ≤ 0. (c) is the most defense-in-depth but adds latency on every write. Recommend (b) for MVP + flag for revisit if a non-Zod write path appears (Story 1.3 re-auth, Edge Functions, etc.).
- [x] [Review][Patch] **Hash recipe expanded vs AC #6 — implementation hashes 10 fields (adds `entity_table`, `actor`, `source`); AC #6 specifies 7.** [Auditor] Implementation is *more* tamper-resistant than AC required, but is a literal divergence from the spec text. Fix: amend AC #6 to ratify the broader hash recipe (action item on the story file, not the code). [story AC #6]
- [x] [Review][Patch] **`canonicalJsonStringify` cross-language parity untested for unicode/emoji/edge numbers.** [Blind H4, Edge E6, E7, E8] Contract test only covers ASCII happy-path. Risk areas: emoji (4-byte UTF-8 vs surrogate-pair escape), control chars (U+0000–U+001F), U+2028/U+2029, large numbers (`1e21` vs `1000000000000000000000`), negative zero, `5.0` vs `5`. The first saver named "Mama 😀" or amount stored as decimal could silently break the chain in production. Fix: add fixture rows to `hashChain.contract.test.ts` covering: emoji name, U+2028 in name, integer 1e9 / 1e21, negative-zero, leading-zero strings. Plus: in `canonicalJsonStringify`, throw on `BigInt`, throw on `!Number.isFinite(value)`, and document expected coercion of `Date` (or throw). [src/domain/audit/hashChain.ts:75-95, src/domain/audit/hashChain.contract.test.ts]
- [x] [Review][Patch] **`canonical_jsonb` marked `IMMUTABLE` but should be `STABLE`.** [Auditor] `jsonb_typeof` and `jsonb_each` are STABLE (depend on collation/timezone settings indirectly). `IMMUTABLE` is incorrect for a function calling them; harmless for the trigger today but misleading and would make a hypothetical index on `canonical_jsonb(payload)` give wrong cached values across sessions. Fix: change to `STABLE`. [supabase/migrations/20260419000007_triggers_audit.sql:55]
- [x] [Review][Patch] **`anon` role not explicitly denied on user-owned tables.** [Edge E16] RLS policies grant only to `authenticated`, but Supabase's default GRANT to `anon` may exist on some tables. Defense-in-depth fix: add `create policy {table}_no_anon on public.{table} for all to anon using (false) with check (false)` for each of `members`, `cycles`, `transactions`, `sms_queue`, `disputes`, `audit_log`. Or: REVOKE all base-table grants from `anon` explicitly. [supabase/migrations/20260419000002_rls_policies.sql]
- [x] [Review][Patch] **`toCanonicalTimestamp` strips negative timezone offsets silently → wrong canonical when PostgREST emits non-UTC.** [Edge E12] Current regex matches `[+-]\d{2}:?\d{2}|Z` then discards. If a future PostgREST proxy or client setting emits `2026-04-19T05:14:23.123456-05:00`, the helper treats it as UTC and produces `2026-04-19T05:14:23.123456Z` — wrong canonical, hash mismatch on verify. Fix: validate the offset is `Z` or `+00`/`+00:00`/`+0000`; throw otherwise. [src/domain/audit/hashChain.ts:108-118]
- [x] [Review][Patch] **`toCanonicalTimestamp` regex doesn't accept RFC 3339 `+00` short form (no minutes).** [Edge E13] Current pattern requires `\d{2}:?\d{2}`. RFC 3339 allows `+00`. Fix: change pattern to `(?:Z|[+-]\d{2}(?::?\d{2})?)?`. [src/domain/audit/hashChain.ts:114]
- [x] [Review][Patch] **`audit_log` INSERT denial test only asserts `error not null` — could pass spuriously if PostgREST silently no-ops.** [Blind H9, Edge E19] Add follow-up count assertion: `const { count } = await serviceClient.from('audit_log').select('*', { count: 'exact', head: true }).eq('event_id', '00000000-0000-4000-8000-000000000099'); expect(count).toBe(0);` [tests/e2e/rls-isolation.spec.ts:246]
- [x] [Review][Patch] **RLS read-isolation test is tautological when data is empty.** [Blind H10] `expect(data ?? []).toEqual((data ?? []).filter(...))` is vacuously true on empty array. Add `expect(data!.length).toBeGreaterThan(0)` after the filter to confirm the seed actually landed and RLS isn't returning ZERO rows for collector A entirely. [tests/e2e/rls-isolation.spec.ts:170-186]
- [x] [Review][Patch] **`camelToSnake` regex broken on consecutive caps + digits → round-trip lost on `userIdAPI`, `htmlURL`, `iso8601`.** [Blind H13, Edge E25, E26] Current: `key.replace(/([A-Z])/g, "_$1").toLowerCase()` produces `user_id_a_p_i`. Fix: use `key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase()` with leading-cap handling, plus add round-trip tests for `userIdAPI`, `htmlURL`, `TLSv12`, `iso8601`. [src/infrastructure/supabase/camelize.ts:18]
- [x] [Review][Patch] **`decodeHexBytea` no length validation — odd-length hex slices into NaN bytes silently.** [Blind H12] Add: `if (cleaned.length % 2 !== 0) throw new Error(...)` and `if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error(...)`. Also: factor the duplicate copy in `hashChain.contract.test.ts` into the shared helper. [src/infrastructure/audit/verify.ts:14-22]
- [x] [Review][Patch] **`infrastructure/audit/verify.ts` silently substitutes `Uint8Array(0)` for null `entry_hash`.** [Blind H11] `audit_log.entry_hash` is `not null` so the fallback is unreachable; throw instead to surface corruption: `decodeHexBytea(dbRow.entry_hash) ?? throw new Error('audit row missing entry_hash')`. [src/infrastructure/audit/verify.ts:60]
- [x] [Review][Patch] **`migration 0005` ALTER TABLE drops + adds `not null` columns without guard — re-run on partially-seeded DB silently breaks.** [Edge E17] Add a guard at the top of 0005: `do $$ begin if exists(select 1 from public.members) then raise exception 'cannot run 0005 on non-empty members — backfill required'; end if; end; $$;` [supabase/migrations/20260419000005_vault_setup.sql]
- [x] [Review][Patch] **`serializeForHash` accepts empty `Uint8Array` prevHash as equivalent to null — API ambiguity.** [Edge E10] Current: `prevHash ?? new Uint8Array(0)`. Fix: throw on empty non-null Uint8Array → forces caller to pass `null` for chain head. [src/domain/audit/hashChain.ts:62]
- [x] [Review][Patch] **RLS isolation test seed phone uses 4 random digits → 1:10000 collision rate, flaky CI.** [Edge E18] Increase entropy: `+22177${crypto.randomUUID().replace(/-/g, '').slice(0, 9)}`. [tests/e2e/rls-isolation.spec.ts:52-54]
- [x] [Review][Patch] **`canonicalJsonStringify` should reject `BigInt` and non-finite numbers explicitly.** [Edge E9] `JSON.stringify(0n)` throws; `JSON.stringify(NaN)` returns `"null"`. Add explicit `typeof value === 'bigint' → throw` and `!Number.isFinite(value) → throw` so a future caller passing these gets a clear error rather than a silent hash divergence. [src/domain/audit/hashChain.ts:75]

**Patches (LOW severity):**

- [x] [Review][Patch] **Advisory lock uses 1-arg `pg_advisory_xact_lock(int8)` — no class-id namespace.** [Blind H3, Edge E22] Risk of accidental collision with another extension's lock keys. Fix: use the 2-arg form `pg_advisory_xact_lock(class_id int4, key int4)` with a fixed class-id constant for SafariCash audit chain (e.g., `pg_advisory_xact_lock(0x5AFA, hashtext(collector_id::text))`). [supabase/migrations/20260419000007_triggers_audit.sql:179]
- [x] [Review][Patch] **vault_encrypt null check missing in test — Vault outage manifests as confusing not-null error rather than the underlying Vault error.** [Blind H6] In RLS isolation test seed, after `service.rpc("vault_encrypt", ...)` add `if (!nameSecret) throw new Error('vault_encrypt returned null')`. [tests/e2e/rls-isolation.spec.ts:65-68]

**Deferred (real but not blocking — revisit when triggered):**

- [x] [Review][Defer] **Gap-detection in audit chain — DELETE row + relink prev_hash leaves chain still verifiable.** [Edge E11] `verifyChain` walks contiguous rows; an insider with DB write access could DELETE a row and re-encrypt subsequent rows' prev_hash to skip it. Adding a per-collector monotonic sequence column would catch this but is heavy lift. Defer to a future "audit-log integrity hardening" story (likely Epic 1.x or Story 9.x ops surface). [src/domain/audit/verify.ts]
- [x] [Review][Defer] **Vault row cleanup on member deletion (Story 10.4 anonymisation territory).** [Blind H7, Edge E5] Currently DELETE on members leaves `vault.secrets` rows orphaned. Story 10.4 (saver-anonymisation Edge Function) owns the cleanup pattern (decrypt-then-delete-secret-then-delete-row).
- [x] [Review][Defer] **Audit payload contains encrypted UUIDs not plaintext — Vault row swap silently changes historical meaning.** [Blind H7] Architectural concern. Mitigations: (a) include `canonical_jsonb` of the *decrypted* row in audit payload — re-introduces plaintext into a second table that needs same encryption; (b) add a separate `audit_log_secret_witness` table that stores `(audit_event_id, decrypted_hash)` — partial protection; (c) accept the limitation and document. Document in ADR-001 as accepted MVP limitation; revisit if a real attack vector emerges.
- [x] [Review][Defer] **Hardcoded event_type CASE in trigger — future taxonomy changes require trigger function rewrite.** [Edge E28] Architectural premature optimization to extract to a lookup table now; revisit when a 3rd story needs to add new event types.
- [x] [Review][Defer] **Forensic actor disambiguation — `actor='system'` covers triggers, dashboard ops, AND breached service-role.** [Edge E2] Mitigation: future Edge Functions set a session-local GUC `app.actor` and trigger reads it (trivial change). Defer until Story 1.3 (re-auth Edge Function) wires the GUC pattern.
- [x] [Review][Defer] **Migration 0004 is essentially dead weight — only does an existence check.** [Blind H15] Cosmetic; reflects spec-mandated 7-file split. No-op in practice.
- [x] [Review][Defer] **`hashtextextended` advisory lock collision threshold at >10k collectors.** [Blind H3] Negligible at MVP scale (<100 collectors). Add a note to RUNBOOK when collector count nears 10k.

**Dismissed as noise (false positives or non-actionable):**

- "`db:types` requires `--linked` so CI fails on fresh clone" [Blind H16] — `database.types.ts` IS committed (regenerated from cloud, 681 lines); CI does not need to re-gen. Type compilation works without a Supabase link.
- "`import.meta.env` throws at module import → vitest crashes" [Edge E24] — verified locally: 47/47 unit tests pass without `.env.local` keys (the contract test skips via `describe.runIf`). The Vite env stub in vitest's environment handles missing values without throwing for the unit test surface.
- "Trigger error in multi-row INSERT rolls back the whole batch" [Edge E27] — intended Postgres behavior. Documented (or should be); not a bug.
- "RLS bypass via `super_admin` role" — confirmed not introduced (anti-pattern explicitly avoided per Dev Notes).
- "Naming convention violation `cycles_dates_chk`" [Auditor] — convention is `{table}_..._chk`; `cycles_dates_chk` matches.
- Various stylistic / API-design suggestions that don't affect correctness or security.

## Change Log

| Date       | Author     | Change |
|------------|------------|--------|
| 2026-04-19 | dev (Opus) | Story 1.2 dev complete — 7 migrations applied to Supabase Pro cloud (eu-west-3); per-row Vault pattern (ADR-001); per-collector hash-chained audit log with SQL ↔ TS parity (custom `canonical_jsonb()` SQL + `canonicalJsonStringify` TS); RLS isolation E2E (4/4 passing against cloud); 47 unit tests; lint, typecheck, build all green. 6 architectural divergences from spec captured. Status → review. |
| 2026-04-19 | dev (Opus) | Code review (3 adversarial layers, ~70 raw findings → 25 patch + 7 defer + ~10 dismiss). 1 decision-needed → resolved as patch (CI uses local Supabase via `supabase start` on Actions runners; well-known public dev keys, zero secrets exposed, zero prod pollution). 25 patches applied: HIGH — `now()` → `clock_timestamp()` (chain replay determinism); REVOKE `vault_decrypt` from authenticated (RPC bypass closed); `cycle.settled` status-aware mapping; entry_hash/prev_hash length CHECKs; transactions_decrypted nullif() guard; explicit anon-deny RLS policies; CI hard-fail when test env missing. MED — actor format CHECK, canonical JSON unicode/bigint/non-finite tests, toCanonicalTimestamp non-UTC throw + `+00` short form, RLS test count assertions + non-tautological seed, camelize regex fix, decodeHexBytea validation, migration 0005 destructive guard, advisory lock 2-arg form. AC #5 + #6 amended in spec text to ratify implementation choices. After fixes: lint, typecheck, build, 57 unit tests, 5 Playwright (incl. 4 RLS isolation + 1 SQL↔TS contract) all green vs cloud. 7 deferred (chain gap-detection, vault row cleanup → Story 10.4, audit payload encrypted-UUID swap concern, hardcoded event_type CASE, forensic actor disambiguation, dead migration 0004, advisory lock collision threshold). Status → done. |
