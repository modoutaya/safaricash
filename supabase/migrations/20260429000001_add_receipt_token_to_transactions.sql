-- Story 6.3 — Migration 0040: add receipt_token column to transactions.
--
-- 32 hex chars = 128 bits of entropy (NFR-S3 — *"≥ 128 bits, unguessable,
-- non-sequential"*). Story 6.4's Cloudflare Worker will resolve the public
-- URL `/r/{token}` by looking up this column via service-role Supabase.
--
-- The column is added NULL-able first so the backfill can populate every
-- existing row before the NOT NULL + CHECK + UNIQUE constraints take effect.
--
-- See: _bmad-output/implementation-artifacts/6-3-sms-copy-templates.md AC #1.

set check_function_bodies = off;

alter table public.transactions
  add column receipt_token text null;

comment on column public.transactions.receipt_token is
  'Story 6.3 / NFR-S3 — 32-hex-char (128-bit) random token used by Story 6.4 Cloudflare Worker to render the public receipt page at /r/<token>. Generated via encode(extensions.gen_random_bytes(16), ''hex'').';

-- Backfill — pre-prod local dev only (CI starts clean).
update public.transactions
   set receipt_token = encode(extensions.gen_random_bytes(16), 'hex')
 where receipt_token is null;

alter table public.transactions
  alter column receipt_token set not null;

alter table public.transactions
  alter column receipt_token set default encode(extensions.gen_random_bytes(16), 'hex');

-- Defend against malformed tokens future code might insert.
alter table public.transactions
  add constraint transactions_receipt_token_chk
  check (length(receipt_token) = 32 and receipt_token ~ '^[0-9a-f]{32}$')
  not valid;

alter table public.transactions
  validate constraint transactions_receipt_token_chk;

-- Story 6.4's Worker looks up by token; uniqueness + index in one shot.
create unique index idx_transactions_receipt_token
  on public.transactions (receipt_token);

comment on index public.idx_transactions_receipt_token is
  'Story 6.3 — supports Story 6.4 Worker GET /r/<token> O(1) lookup.';
