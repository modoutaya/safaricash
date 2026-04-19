# Story 1.2: Supabase backend, schema, RLS, Vault, and audit-log foundation

Status: in-progress

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
5. **Vault column-level encryption (FR47, NFR-S1).** `members.name`, `members.phone_number`, and `transactions.amount` are stored encrypted via Supabase Vault keys; reads through PostgREST under an authenticated collector return decrypted plaintext; reads via the `service_role` outside Vault context return ciphertext or null per Vault policy. Vault key id is captured in `docs/ADR/001-supabase-vault.md` along with rotation procedure.
6. **Hash-chained audit log (FR44, NFR-S6).** The `audit_log` table has shape `{ event_id uuid PK, event_type text, collector_id uuid, entity_id uuid, entity_table text, timestamp timestamptz, actor uuid, source text CHECK IN ('online','offline_reconciled'), payload jsonb, prev_hash bytea, entry_hash bytea }`. The `triggers_audit.sql` trigger computes `entry_hash = sha256(prev_hash || event_id || event_type || collector_id || entity_id || timestamp || payload_canonical_json)` where `prev_hash` is the `entry_hash` of the previous row for the same `collector_id` (NULL for the first row). The chain is per-collector. The trigger is `SECURITY DEFINER` and the function disables direct `INSERT` / `UPDATE` / `DELETE` on `audit_log` from any role except the trigger itself (NFR-S6: append-only, mutation-resistant).
7. **Automated RLS isolation test gates the release (NFR-S5).** A Playwright + Supabase JS test at `tests/e2e/rls-isolation.spec.ts` (a) seeds two collector accounts (`collectorA`, `collectorB`) plus members + transactions + cycles for each, (b) signs in as `collectorA` and asserts that `select` queries against `members`, `transactions`, `cycles`, `audit_log`, `sms_queue`, `disputes` return only `collectorA`'s rows (zero rows from `collectorB`), and (c) attempts an `update` and a `delete` on a `collectorB` row and asserts a row-not-found / RLS rejection (zero rows affected). The test is wired into `.github/workflows/ci.yml` as a required step. **A failing isolation test blocks merge to `main` and blocks production deploy** — no manual override allowed (NFR-S5 explicitly states this is a release gate).
8. **Hash-chain integrity test.** A Vitest unit + integration suite at `src/domain/audit/hashChain.test.ts` (a) verifies `hashChain.ts` deterministically computes the same hash for a given `(prev_hash, event)` pair, (b) verifies a tampered `payload` (modified after insert) breaks chain validation when `verify.ts` walks the chain, (c) seeds 100 sequential audit rows via the trigger and asserts `verify.ts` returns `valid: true`. Coverage gate: `src/domain/audit/` ≥ 100 % per `architecture.md § Enforcement Guidelines → Test coverage gate`.
9. **No application code touched in this story.** No React component, no TanStack Query hook, no Edge Function is written here. Story 1.2 stops at the data layer + the two test scaffolds. The Supabase singleton client (`src/infrastructure/supabase/client.ts`) and the env loader (`src/infrastructure/supabase/env.ts`) are stubbed with minimal `createClient(...)` + Zod-validated env reads so that future stories (1.5 phone-OTP, 2.x members) can import them — but no domain or feature module is wired.
10. **ADR-001 documents Vault rationale.** `docs/ADR/001-supabase-vault.md` is created per `architecture.md § Project Structure & Boundaries → docs/ADR/`. Records: choice of Supabase Vault over `pgsodium`, rotation cadence (quarterly minimum), migration path back to `pgsodium` if Vault becomes constraining, encrypted columns inventory (`members.name`, `members.phone_number`, `transactions.amount`), and how to add a new encrypted column.

## Tasks / Subtasks

- [ ] **Task 1: Provision the Supabase project and initialise the CLI** (AC: 1)
  - [ ] Create the Supabase project in the dashboard, region `eu-west-3` (Paris), tier Pro
  - [ ] Capture project URL, `anon` key, `service_role` key in a secure password store (1Password / similar) — share with the dev pairing on this story; do NOT commit them
  - [ ] Run `supabase init` at repo root to create `supabase/config.toml`; commit the file
  - [ ] Update `.env.example` (already present from Story 1.1) — confirm `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` lines are present with empty values
  - [ ] Add `.env.local` to `.gitignore` (verify Story 1.1 already did this; if not, add it)
  - [ ] Run `supabase login` (developer auth) and `supabase link --project-ref {ref}` to link CLI to the project
  - [ ] Verify `supabase db push --dry-run` runs cleanly with no migrations yet (baseline check)

- [ ] **Task 2: Author migration `20260419000001_init_schema.sql`** (AC: 2, 3) — see Dev Notes § Schema specification
  - [ ] Create `users` table with columns: `id uuid PK references auth.users(id)`, `phone_number text NOT NULL UNIQUE`, `role users_role_enum NOT NULL DEFAULT 'collector'`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`. Define `users_role_enum AS ENUM ('collector', 'super_admin')`.
  - [ ] Create `members` table: `id uuid PK DEFAULT gen_random_uuid()`, `collector_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT`, `name text NOT NULL` (later wrapped by Vault), `phone_number text NOT NULL` (later Vault-wrapped), `daily_amount numeric(12,0) NOT NULL CHECK (daily_amount > 0)`, `status members_status_enum NOT NULL DEFAULT 'active'`, `created_at`, `updated_at`. Define `members_status_enum AS ENUM ('active', 'paused', 'completed', 'deleted')`.
  - [ ] Create `cycles` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT`, `cycle_number int NOT NULL CHECK (cycle_number >= 1)`, `start_date date NOT NULL`, `end_date date NOT NULL`, `status cycles_status_enum NOT NULL DEFAULT 'active'`, `created_at`, `updated_at`. `cycles_status_enum AS ENUM ('active', 'with_advance', 'completed', 'settled')`. Unique `(member_id, cycle_number)`.
  - [ ] Create `transactions` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT`, `cycle_id uuid NOT NULL REFERENCES cycles(id) ON DELETE RESTRICT`, `kind transactions_kind_enum NOT NULL`, `amount numeric(12,0) NOT NULL CHECK (amount > 0)` (later Vault-wrapped), `cycle_day int NOT NULL CHECK (cycle_day BETWEEN 1 AND 30)`, `source transactions_source_enum NOT NULL DEFAULT 'online'`, `created_at`, `updated_at`. Define `transactions_kind_enum AS ENUM ('contribution', 'rattrapage', 'advance')`, `transactions_source_enum AS ENUM ('online', 'offline_reconciled')`.
  - [ ] Create `sms_queue` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `transaction_id uuid REFERENCES transactions(id) ON DELETE CASCADE`, `recipient_phone text NOT NULL` (encrypted), `body text NOT NULL`, `status sms_queue_status_enum NOT NULL DEFAULT 'queued'`, `attempts int NOT NULL DEFAULT 0`, `last_attempt_at timestamptz`, `delivered_at timestamptz`, `created_at`. Define `sms_queue_status_enum AS ENUM ('queued', 'sent', 'delivered', 'failed', 'abandoned')`. Index `(status, created_at)` for the worker drain query.
  - [ ] Create `disputes` table: `id uuid PK`, `collector_id uuid NOT NULL REFERENCES users(id)`, `transaction_id uuid NOT NULL REFERENCES transactions(id)`, `flagged_at timestamptz NOT NULL DEFAULT now()`, `flagged_via disputes_via_enum NOT NULL DEFAULT 'receipt_url'`, `status disputes_status_enum NOT NULL DEFAULT 'open'`, `notes text`, `resolved_at timestamptz`. Define `disputes_via_enum AS ENUM ('receipt_url', 'support_email', 'support_phone')`, `disputes_status_enum AS ENUM ('open', 'resolved', 'dismissed')`.
  - [ ] Create `audit_log` table per AC 6 (full shape) — but defer the trigger function to migration `0007`
  - [ ] Add a `BEFORE UPDATE` trigger on every table with `updated_at` that sets `updated_at = now()`
  - [ ] Verify migration applies cleanly to a freshly reset local DB: `supabase db reset && supabase db push`

- [ ] **Task 3: Author migration `20260419000002_rls_policies.sql`** (AC: 4) — RLS per-collector isolation (FR46, NFR-S5)
  - [ ] `ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; ALTER TABLE {t} FORCE ROW LEVEL SECURITY;` on every table from Task 2 + `audit_log`
  - [ ] On `users`: `CREATE POLICY users_self ON users FOR ALL USING (id = auth.uid()) WITH CHECK (id = auth.uid());`
  - [ ] On `members`, `cycles`, `transactions`, `sms_queue`, `disputes`: `CREATE POLICY {table}_collector_isolation ON {table} FOR ALL USING (collector_id = auth.uid()) WITH CHECK (collector_id = auth.uid());`
  - [ ] On `audit_log`: `SELECT` policy `USING (collector_id = auth.uid())`. **No `INSERT` / `UPDATE` / `DELETE` policy** — only the `SECURITY DEFINER` trigger from Task 7 may write, which bypasses RLS by design (NFR-S6 append-only)
  - [ ] **Do NOT add `super_admin` bypass policies in this story.** Admin access at MVP is through Supabase Studio with the service-role key (`architecture.md § Admin Provisioning Tool`). Multi-collector RBAC is out of MVP scope.

- [ ] **Task 4: Author migration `20260419000003_audit_log.sql`** (AC: 6) — table shape only; trigger lives in `0007`
  - [ ] Create the `audit_log` table per AC 6 specification (every column listed)
  - [ ] Constraints: `event_type` matches `architecture.md § Communication Patterns → Event naming` (`{entity}.{action}`, lowercase, past-tense). Add `CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$')` as a defensive constraint.
  - [ ] Index `(collector_id, timestamp DESC)` for the per-collector chain walk + audit history queries
  - [ ] Index `(entity_table, entity_id)` for entity-level audit queries (Story 2.4 member profile timeline)
  - [ ] `REVOKE INSERT, UPDATE, DELETE ON audit_log FROM PUBLIC, authenticated, anon;` — only `service_role` and the trigger function may write

- [ ] **Task 5: Author migration `20260419000004_sms_queue.sql`** (AC: 2) — table is created in `0001` but this migration adds the worker-facing index + the `RAISE` constraint preventing direct dequeue
  - [ ] Verify `sms_queue` index `(status, created_at)` is present (created in `0001`); add it here if it was missed
  - [ ] Document expected lifecycle in a SQL `COMMENT ON TABLE sms_queue IS '...'` referencing Story 6.1 / 6.2 ownership

- [ ] **Task 6: Author migration `20260419000005_vault_setup.sql`** (AC: 5) — Supabase Vault column encryption (FR47, NFR-S1)
  - [ ] `CREATE EXTENSION IF NOT EXISTS supabase_vault;` (verify Vault is available on the Pro tier of the linked project)
  - [ ] Generate one Vault key per encrypted column-set: `members_pii_key` (covers `name` + `phone_number`) and `transactions_amount_key`. Capture key UUIDs in a SQL comment + ADR-001
  - [ ] Convert `members.name`, `members.phone_number`, `transactions.amount` columns to use Vault encryption via `vault.create_secret()` + view-based decryption pattern per Supabase Vault docs (verify against current Vault docs at implementation time — see Dev Notes § Latest Tech Information)
  - [ ] Verify via local Supabase: `INSERT` into `members`, then `SELECT` as the owning collector returns plaintext; `SELECT` via `service_role` outside the Vault context returns ciphertext / null
  - [ ] **Key rotation procedure** documented in `docs/ADR/001-supabase-vault.md` per Task 10

- [ ] **Task 7: Author migration `20260419000006_indexes.sql`** (AC: 2)
  - [ ] `CREATE EXTENSION IF NOT EXISTS pg_trgm;` (required for trigram search on member names — NFR-P2)
  - [ ] `CREATE INDEX idx_members_collector_id_name_trgm ON members USING gin (collector_id, name gin_trgm_ops);` (NFR-P2 — 300 ms member search at 150 members)
  - [ ] `CREATE INDEX idx_transactions_member_id_created_at ON transactions (member_id, created_at DESC);` (member profile transaction history — Story 2.4, FR13)
  - [ ] `CREATE INDEX idx_transactions_collector_id_created_at ON transactions (collector_id, created_at DESC);` (dashboard recent activity — Story 9.1)
  - [ ] `CREATE INDEX idx_cycles_member_id_cycle_number ON cycles (member_id, cycle_number DESC);` (member profile cycle history)
  - [ ] `CREATE INDEX idx_audit_log_collector_id_timestamp ON audit_log (collector_id, timestamp DESC);` (already declared in `0003`; skip if duplicate)

- [ ] **Task 8: Author migration `20260419000007_triggers_audit.sql`** (AC: 6) — hash-chained audit trigger (NFR-S6, FR44)
  - [ ] Create `audit_emit()` `SECURITY DEFINER` function that, on `AFTER INSERT/UPDATE/DELETE` on `members` / `transactions` / `cycles`:
    - Computes `prev_hash` by `SELECT entry_hash FROM audit_log WHERE collector_id = NEW.collector_id ORDER BY timestamp DESC LIMIT 1` (NULL on first row)
    - Builds the canonical JSON payload per `architecture.md § Communication Patterns → Event payload structure` (`event_id`, `event_type`, `collector_id`, `entity_id`, `timestamp`, `actor`, `source`, `payload`)
    - Computes `entry_hash = digest(coalesce(prev_hash, '\x'::bytea) || event_id::text::bytea || event_type::bytea || collector_id::text::bytea || entity_id::text::bytea || timestamp::text::bytea || payload::text::bytea, 'sha256')` using `pgcrypto`
    - Inserts the row into `audit_log`
  - [ ] `CREATE EXTENSION IF NOT EXISTS pgcrypto;` if not already present
  - [ ] Attach the trigger to `members`, `transactions`, `cycles` for `INSERT OR UPDATE OR DELETE`
  - [ ] Map operations to `event_type`: INSERT → `{table_singular}.created`, UPDATE → `{table_singular}.updated`, DELETE → `{table_singular}.deleted` (e.g., `member.created`, `transaction.committed` for `transactions.INSERT`). **Note:** `transaction.committed` deviates from the auto-mapping rule per `architecture.md § Event naming` table — special-case INSERT on `transactions` to emit `transaction.committed`
  - [ ] **Source field:** for offline-reconciled writes the Edge Function (Epic 8) will set a session-local GUC `app.source = 'offline_reconciled'`; the trigger reads `current_setting('app.source', true)` and defaults to `'online'`
  - [ ] **Actor field:** read from `auth.uid()` via `current_setting('request.jwt.claim.sub', true)`; for service-role writes (e.g., `sms-worker`) set `actor = 'system'`
  - [ ] Verify with a manual `INSERT INTO members ...; SELECT * FROM audit_log;` that one row appears with non-null `entry_hash` and `prev_hash IS NULL` for the first chain element

- [ ] **Task 9: Stub the Supabase singleton client + env loader** (AC: 9) — minimal scaffolding so Story 1.5 onwards can import
  - [ ] Create `src/infrastructure/supabase/env.ts` with a Zod schema validating `VITE_SUPABASE_URL` (URL format) + `VITE_SUPABASE_ANON_KEY` (non-empty string). Throw a named error at module load if validation fails.
  - [ ] Create `src/infrastructure/supabase/client.ts` exporting a singleton: `export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });`. The `<Database>` generic comes from a type generation step — see next subtask.
  - [ ] Run `supabase gen types typescript --linked > src/infrastructure/supabase/database.types.ts` and commit the generated file. Add `npm run db:types` script wrapping this command. Document in README the regeneration cadence (after every migration).
  - [ ] Create `src/infrastructure/supabase/camelize.ts` with `camelize` and `decamelize` helpers (recursive `snake_case ↔ camelCase` on object keys). Cover with `camelize.test.ts`. This is the boundary layer per `architecture.md § Naming Patterns → Component-to-DB translation rule`.
  - [ ] **Do NOT instantiate any feature hooks, Edge Functions, or routes.** This subtask is pure scaffolding for downstream stories.

- [ ] **Task 10: Write the hash-chain domain module + test** (AC: 8) — `src/domain/audit/`
  - [ ] Create `src/domain/audit/event.ts` exporting `AuditEvent` TypeScript type matching the payload structure from `architecture.md § Communication Patterns → Event payload structure`
  - [ ] Create `src/domain/audit/hashChain.ts` exporting `computeEntryHash(prevHash: Uint8Array | null, event: AuditEvent): Uint8Array` using `crypto.subtle.digest('SHA-256', ...)`. The byte serialisation MUST be byte-identical to the Postgres trigger from Task 7 — write a contract test asserting parity (insert a row via SQL, fetch the resulting `entry_hash`, recompute via TS, assert equality).
  - [ ] Create `src/domain/audit/verify.ts` exporting `verifyChain(events: AuditLogRow[]): { valid: boolean; brokenAt?: number }` walking the chain in timestamp order, recomputing each `entry_hash` from `prev_hash + event`, returning the first index where the recomputation diverges
  - [ ] Create `src/domain/audit/hashChain.test.ts` covering AC 8 cases (a, b, c). Coverage gate: 100 % per `architecture.md § Enforcement Guidelines`
  - [ ] Create `src/infrastructure/audit/verify.ts` as a thin wrapper that pulls `audit_log` rows via the Supabase client and calls `verifyChain` — no logic, just glue. Story 9.x or a future ops runbook entry will call this.

- [ ] **Task 11: Write the RLS isolation E2E gate** (AC: 7) — `tests/e2e/rls-isolation.spec.ts`
  - [ ] Use Playwright's request fixture + `@supabase/supabase-js` to drive two parallel sessions
  - [ ] Test setup: insert two `users` rows (`collectorA`, `collectorB`) directly via `service_role` (bypasses RLS for seeding); insert 3 members + 3 cycles + 3 transactions per collector
  - [ ] Test step 1: sign in via Supabase Auth as `collectorA`. Assert `supabase.from('members').select()` returns exactly 3 rows, all with `collector_id = collectorA.id`. Repeat for `cycles`, `transactions`, `audit_log`, `sms_queue`, `disputes`
  - [ ] Test step 2: still as `collectorA`, attempt `supabase.from('members').update({ name: 'X' }).eq('id', collectorB_member_id)` — assert `data` is empty array (RLS filtered the row out, not an error response — Postgres semantic with RLS)
  - [ ] Test step 3: still as `collectorA`, attempt `supabase.from('members').delete().eq('id', collectorB_member_id)` — same assertion
  - [ ] Test step 4: attempt to write to `audit_log` directly as `collectorA` — assert RLS rejection (no INSERT policy)
  - [ ] Wire into `.github/workflows/ci.yml` as a required step in the CI pipeline (Story 1.8 owns the full pipeline definition; this story adds the test file and a CI step that runs `npx playwright test tests/e2e/rls-isolation.spec.ts` against a freshly-migrated local Supabase or the Supabase CLI's containerised instance). **Failing test must block merge — `continue-on-error: false`**.
  - [ ] Verify the test fails red if RLS is intentionally disabled on one table (mutation test — temporarily comment out one `ALTER TABLE … ENABLE ROW LEVEL SECURITY`, run the test, confirm it fails, restore the line). Document this verification step in the PR description as evidence the gate works.

- [ ] **Task 12: Write ADR-001 Supabase Vault** (AC: 10) — `docs/ADR/001-supabase-vault.md`
  - [ ] Decision: chose Supabase Vault for column-level AES-256-GCM encryption over `pgsodium`. Rationale per `architecture.md § Data Architecture → Column-level encryption` (lower ops overhead, dashboard-managed, Supabase-native)
  - [ ] Encrypted columns inventory: `members.name`, `members.phone_number`, `transactions.amount`. Each row notes which Vault key (`members_pii_key` / `transactions_amount_key`) covers it
  - [ ] Key rotation: quarterly minimum, immediate on suspected leak. Procedure: rotate via Supabase dashboard → Vault → re-encrypt rows via `vault.update_secret()` migration → verify reads still resolve
  - [ ] Migration path back to `pgsodium`: documented as fallback if Vault's managed model becomes constraining — exit ramp is in the `architecture.md § Data Architecture` decision but ADR captures the trigger criteria (e.g., key-rotation latency exceeds operational SLA)
  - [ ] How to add a new encrypted column: 4-step recipe (declare column as bytea, add `vault.create_secret()` call in a new migration, update PostgREST decryption view, regenerate `database.types.ts`)

- [ ] **Task 13: Local dev verification + commit hygiene** (AC: 1, 2)
  - [ ] Run `supabase db reset && supabase db push` against the local Supabase stack — all 7 migrations apply cleanly with no errors or warnings
  - [ ] Run `npm run test` — `hashChain.test.ts` + `camelize.test.ts` pass
  - [ ] Run `npx playwright test tests/e2e/rls-isolation.spec.ts` — passes against local Supabase
  - [ ] Commit each migration as its own git commit with conventional-commits message (`feat(db): init schema`, `feat(db): rls policies`, …) for bisectability — same pattern Story 1.1 established
  - [ ] Open PR; verify CI is green; verify the RLS-isolation step appears in the CI run log

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

*(to be filled by the dev agent upon implementation start)*

### Debug Log References

### Completion Notes List

### File List
