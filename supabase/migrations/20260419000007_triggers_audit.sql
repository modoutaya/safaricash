-- Story 1.2 — Migration 0007: hash-chained audit trigger.
--
-- Implements NFR-S6 (cryptographically chained audit log, append-only,
-- mutation-resistant) and FR44.
--
-- Chain semantics:
--   - One independent chain per collector_id.
--   - prev_hash = entry_hash of the previous row for that collector
--     (NULL for the first row of a chain).
--   - entry_hash = sha256(canonical-serialized event bytes).
--   - The canonical serialization is shared verbatim with
--     src/domain/audit/hashChain.ts. The contract test (Task 10 last
--     subtask) inserts a row via SQL, recomputes the hash via TS, and
--     asserts byte-equality.
--
-- Concurrency: a per-collector pg_advisory_xact_lock serializes audit
-- writes for the same chain so that two concurrent INSERTs cannot both
-- pick the same prev_hash and fork the chain.
--
-- Encrypted columns: at trigger time, NEW.* contains the encrypted
-- secret_id values, not the plaintext. The audit payload preserves the
-- exact committed DB state (uuid pointers), not plaintext. Plaintext
-- recovery from an audit row goes through vault.decrypted_secrets via
-- public.vault_decrypt(). This avoids re-introducing plaintext into a
-- second table that would also need Vault wrapping.
--
-- See: architecture.md § Communication Patterns → Event payload structure.

-- pgcrypto is required for digest(). On Supabase, extensions live in the
-- `extensions` schema, not in `public` — so the trigger function below
-- references `extensions.digest()` and includes `extensions` in its
-- search_path.
create extension if not exists "pgcrypto" with schema "extensions";

-- ---------------------------------------------------------------------------
-- canonical_jsonb(jsonb) → text
--
-- Produces a deterministic, JS-compatible canonical JSON string from a jsonb
-- value:
--   - Object keys sorted alphabetically (recursive).
--   - No whitespace (compact form, unlike jsonb::text which emits ", " and ": ").
--   - Scalars use jsonb's native text form, which matches JSON.stringify
--     for our payloads (uuid/text → quoted string, numeric → number, etc.).
--
-- This is the SQL counterpart of canonicalJsonStringify() in
-- src/domain/audit/hashChain.ts. The contract test asserts byte-equality
-- between the two implementations.
-- ---------------------------------------------------------------------------

create or replace function public.canonical_jsonb(j jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  result text;
  jt text;
begin
  if j is null then
    return 'null';
  end if;
  jt := jsonb_typeof(j);
  if jt = 'object' then
    select coalesce(
      '{' || string_agg(
        to_json(key)::text || ':' || public.canonical_jsonb(value),
        ',' order by key
      ) || '}',
      '{}'
    ) into result
    from jsonb_each(j);
    return result;
  elsif jt = 'array' then
    select coalesce(
      '[' || string_agg(
        public.canonical_jsonb(elem),
        ',' order by ord
      ) || ']',
      '[]'
    ) into result
    from jsonb_array_elements(j) with ordinality as arr(elem, ord);
    return result;
  else
    return j::text;
  end if;
end;
$$;

comment on function public.canonical_jsonb(jsonb) is
  'Deterministic canonical JSON serialiser matching src/domain/audit/hashChain.ts canonicalJsonStringify(). Used by audit_emit() to hash the payload identically on both sides.';

-- ---------------------------------------------------------------------------
-- audit_emit() — single trigger function reused for members / cycles /
-- transactions. Differentiates by TG_TABLE_NAME and TG_OP.
-- ---------------------------------------------------------------------------

create or replace function public.audit_emit()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  -- Canonical event fields
  v_event_id     uuid;
  v_event_type   text;
  v_entity_id    uuid;
  v_entity_table text;
  v_timestamp    timestamptz;
  v_actor        text;
  v_source       text;
  v_payload      jsonb;
  v_collector_id uuid;
  v_op           text;

  -- Hash-chain
  v_prev_hash    bytea;
  v_entry_hash   bytea;

  -- Canonical serialization
  v_delim        bytea := decode('1F', 'hex');  -- ASCII unit-separator
  v_serialized   bytea;
  v_iso_ts       text;
begin
  v_op           := tg_op;
  v_timestamp    := now();
  v_event_id     := gen_random_uuid();
  v_entity_table := tg_table_name::text;

  -- Pull collector_id and entity_id from the right tuple per op.
  if v_op = 'DELETE' then
    v_collector_id := old.collector_id;
    v_entity_id    := old.id;
    v_payload      := to_jsonb(old);
  else
    v_collector_id := new.collector_id;
    v_entity_id    := new.id;
    v_payload      := to_jsonb(new);
  end if;

  -- event_type per architecture.md § Communication Patterns → Event naming.
  -- Format: {entity_singular}.{action_past_tense}, lowercase, underscore-allowed.
  -- Special case (per Story 1.2 Task 8 spec): transactions INSERT emits
  -- 'transaction.committed', not 'transaction.created'.
  v_event_type := case
    when v_entity_table = 'members'      and v_op = 'INSERT' then 'member.created'
    when v_entity_table = 'members'      and v_op = 'UPDATE' then 'member.updated'
    when v_entity_table = 'members'      and v_op = 'DELETE' then 'member.deleted'
    when v_entity_table = 'cycles'       and v_op = 'INSERT' then 'cycle.started'
    when v_entity_table = 'cycles'       and v_op = 'UPDATE' then 'cycle.updated'
    when v_entity_table = 'cycles'       and v_op = 'DELETE' then 'cycle.deleted'
    when v_entity_table = 'transactions' and v_op = 'INSERT' then 'transaction.committed'
    when v_entity_table = 'transactions' and v_op = 'UPDATE' then 'transaction.updated'
    when v_entity_table = 'transactions' and v_op = 'DELETE' then 'transaction.deleted'
    else null  -- will fail the CHECK constraint on event_type and surface the gap
  end;

  if v_event_type is null then
    raise exception 'audit_emit: unmapped (table, op) = (%, %). Add a case branch and bump the audit-event taxonomy.', v_entity_table, v_op;
  end if;

  -- source: Edge Functions handling offline-reconciled writes set the GUC
  -- before performing the INSERT/UPDATE/DELETE. Defaults to 'online'.
  v_source := coalesce(current_setting('app.source', true), 'online');
  if v_source not in ('online', 'offline_reconciled') then
    v_source := 'online';
  end if;

  -- actor: JWT sub claim under PostgREST; 'system' under service_role / cron / triggers
  -- without a JWT context.
  v_actor := coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), 'system');

  -- Per-collector chain serialization lock — prevents two concurrent INSERTs
  -- for the same collector from forking the chain by reading the same prev_hash.
  perform pg_advisory_xact_lock(hashtextextended('safaricash.audit_chain.' || v_collector_id::text, 0));

  select entry_hash into v_prev_hash
  from public.audit_log
  where collector_id = v_collector_id
  order by timestamp desc, event_id desc
  limit 1;
  -- v_prev_hash stays NULL for the first row of the chain.

  -- Canonical serialization. MUST match src/domain/audit/hashChain.ts
  -- byte-for-byte. Order, delimiter, ISO timestamp format all locked.
  v_iso_ts := to_char(v_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  v_serialized :=
    coalesce(v_prev_hash, ''::bytea)              || v_delim ||
    convert_to(v_event_id::text, 'UTF8')          || v_delim ||
    convert_to(v_event_type, 'UTF8')              || v_delim ||
    convert_to(v_collector_id::text, 'UTF8')      || v_delim ||
    convert_to(v_entity_id::text, 'UTF8')         || v_delim ||
    convert_to(v_entity_table, 'UTF8')            || v_delim ||
    convert_to(v_iso_ts, 'UTF8')                  || v_delim ||
    convert_to(v_actor, 'UTF8')                   || v_delim ||
    convert_to(v_source, 'UTF8')                  || v_delim ||
    convert_to(public.canonical_jsonb(v_payload), 'UTF8');

  v_entry_hash := extensions.digest(v_serialized, 'sha256');

  insert into public.audit_log (
    event_id, event_type, collector_id, entity_id, entity_table,
    timestamp, actor, source, payload, prev_hash, entry_hash
  ) values (
    v_event_id, v_event_type, v_collector_id, v_entity_id, v_entity_table,
    v_timestamp, v_actor, v_source, v_payload, v_prev_hash, v_entry_hash
  );

  -- AFTER triggers can return null without canceling the original write.
  if v_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.audit_emit() is
  'AFTER INSERT/UPDATE/DELETE trigger function emitting hash-chained audit_log rows. SECURITY DEFINER so it can write to audit_log even when the calling role is REVOKEd from direct writes (see 0003). One chain per collector_id.';

-- Lock down direct invocation. The trigger machinery calls it under the
-- function owner's privileges regardless of grants on the function itself,
-- so revoking from public is safe and prevents misuse.
revoke execute on function public.audit_emit() from public;

-- ---------------------------------------------------------------------------
-- Attach to members / cycles / transactions.
-- AFTER triggers fire after the row write succeeds, so a failed INSERT
-- never produces a phantom audit row.
-- ---------------------------------------------------------------------------

create trigger audit_members
  after insert or update or delete on public.members
  for each row execute function public.audit_emit();

create trigger audit_cycles
  after insert or update or delete on public.cycles
  for each row execute function public.audit_emit();

create trigger audit_transactions
  after insert or update or delete on public.transactions
  for each row execute function public.audit_emit();
