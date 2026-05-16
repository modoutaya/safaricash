-- Story 10.1 — saver dispute flag: audit plumbing + the flag_transaction_dispute RPC.
--
-- The receipt-URL Cloudflare Worker (service-role, no user JWT) records a
-- saver dispute. Two pieces:
--
-- 1. AUDIT PLUMBING. An INSERT into public.disputes must hash-chain a
--    `dispute.flagged` audit_log row. audit_emit() is the canonical
--    serialiser already wired to members/cycles/transactions. Here it is
--    `CREATE OR REPLACE`d with one extra CASE branch for (disputes,
--    INSERT) and an `audit_disputes` AFTER INSERT trigger is attached.
--    The body is reproduced from the CURRENT audit_emit — migration 0030
--    (20260426000005_audit_emit_transaction_undone.sql) — which carries the
--    Story 2.5 3-tier actor-JWT fallback, the Story 3.3 cycle.transitioned
--    branch and the Story 4.5 transaction.undone branch. ONLY the new
--    disputes CASE line is added. NOTE: the audit_log.event_type CHECK
--    (migration 0003) is a regex `^[a-z][a-z_]*\.[a-z][a-z_]*$` — NOT an
--    allowlist — so `dispute.flagged` already passes; no CHECK change.
--
-- 2. THE RPC. flag_transaction_dispute(p_receipt_token, p_notes) — a
--    SECURITY DEFINER function granted to service_role only. disputes has
--    RLS forced (anon hard-denied); the Worker calls under the service-role
--    key with no JWT, so auth.uid() is NULL — the RPC resolves collector_id
--    from the token, never from auth.uid(). It is idempotent: a second call
--    while an `open` dispute exists returns 'already_disputed' without
--    inserting a duplicate.
--
-- See: _bmad-output/implementation-artifacts/10-1-dispute-flag-surface.md

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. audit_emit() — add the (disputes, INSERT) → 'dispute.flagged' branch.
--    Body reproduced from migration 0030 EXCEPT the one new CASE line.
-- ---------------------------------------------------------------------------

create or replace function public.audit_emit()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
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
  v_prev_hash    bytea;
  v_entry_hash   bytea;
  v_delim        bytea := decode('1F', 'hex');
  v_serialized   bytea;
  v_iso_ts       text;
begin
  v_op           := tg_op;
  v_timestamp    := clock_timestamp();
  v_event_id     := gen_random_uuid();
  v_entity_table := tg_table_name::text;

  if v_op = 'DELETE' then
    v_collector_id := old.collector_id;
    v_entity_id    := old.id;
    v_payload      := to_jsonb(old);
  else
    v_collector_id := new.collector_id;
    v_entity_id    := new.id;
    v_payload      := to_jsonb(new);
  end if;

  v_event_type := case
    when v_entity_table = 'members'      and v_op = 'INSERT' then 'member.created'
    when v_entity_table = 'members'      and v_op = 'UPDATE' then 'member.updated'
    when v_entity_table = 'members'      and v_op = 'DELETE' then 'member.deleted'
    when v_entity_table = 'cycles'       and v_op = 'INSERT' then 'cycle.started'
    when v_entity_table = 'cycles'       and v_op = 'UPDATE'
         and (v_payload->>'status') = 'settled'
         and (to_jsonb(old)->>'status') <> 'settled'   then 'cycle.settled'
    -- Story 3.3 — non-settled status flips on cycles.
    when v_entity_table = 'cycles'       and v_op = 'UPDATE'
         and (v_payload->>'status') is distinct from (to_jsonb(old)->>'status')
         and (v_payload->>'status') <> 'settled'
         then 'cycle.transitioned'
    when v_entity_table = 'cycles'       and v_op = 'UPDATE' then 'cycle.updated'
    when v_entity_table = 'cycles'       and v_op = 'DELETE' then 'cycle.deleted'
    when v_entity_table = 'transactions' and v_op = 'INSERT' then 'transaction.committed'
    -- Story 4.5 — soft-undo pattern: NULL → NOT NULL on undone_at.
    when v_entity_table = 'transactions' and v_op = 'UPDATE'
         and (v_payload->>'undone_at') is not null
         and (to_jsonb(old)->>'undone_at') is null     then 'transaction.undone'
    when v_entity_table = 'transactions' and v_op = 'UPDATE' then 'transaction.updated'
    when v_entity_table = 'transactions' and v_op = 'DELETE' then 'transaction.deleted'
    -- Story 10.1 — a saver-flagged dispute. INSERT only — dispute resolution
    -- (UPDATE) is Story 10.3 and adds its own branch when it lands.
    when v_entity_table = 'disputes'     and v_op = 'INSERT' then 'dispute.flagged'
    else null
  end;

  if v_event_type is null then
    raise exception 'audit_emit: unmapped (table, op) = (%, %).', v_entity_table, v_op;
  end if;

  v_source := coalesce(current_setting('app.source', true), 'online');
  if v_source not in ('online', 'offline_reconciled') then
    v_source := 'online';
  end if;

  -- Story 2.5 — 3-tier actor JWT fallback (PRESERVED through all later patches).
  v_actor := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    'system'
  );

  perform pg_advisory_xact_lock(0x5AFA, hashtext(v_collector_id::text));

  select entry_hash into v_prev_hash
  from public.audit_log
  where collector_id = v_collector_id
  order by timestamp desc, event_id desc
  limit 1;

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

  if v_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.audit_emit() is
  'AFTER INSERT/UPDATE/DELETE trigger function. Story 10.1: (disputes, INSERT) -> dispute.flagged. Story 4.5 transaction.undone + Story 3.3 cycle.transitioned + Story 2.5 actor-JWT fallback PRESERVED. Hash chain unchanged.';

revoke execute on function public.audit_emit() from public;

-- Attach to disputes — AFTER INSERT only (resolution UPDATE is Story 10.3).
create trigger audit_disputes
  after insert on public.disputes
  for each row execute function public.audit_emit();

-- ---------------------------------------------------------------------------
-- 2. One open dispute per transaction. The partial unique index is the
--    DB-level guard that closes the TOCTOU race between the existence
--    check and the INSERT inside flag_transaction_dispute — two concurrent
--    POSTs for the same transaction can both pass the SELECT, but only one
--    INSERT survives; the loser hits unique_violation.
-- ---------------------------------------------------------------------------

create unique index if not exists disputes_one_open_per_transaction
  on public.disputes (transaction_id)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- 3. flag_transaction_dispute(p_receipt_token, p_notes) — the dispute RPC.
--    SECURITY DEFINER, service_role-only. Resolves the transaction from the
--    receipt token, idempotency-guards on an existing open dispute, inserts
--    the disputes row (the audit_disputes trigger hash-chains the event).
--    The SELECT pre-check handles the common case; the unique-index
--    exception handler handles the concurrent-POST race.
--    Returns 'created' | 'already_disputed' | 'not_found'.
-- ---------------------------------------------------------------------------

create or replace function public.flag_transaction_dispute(
  p_receipt_token text,
  p_notes         text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transaction_id uuid;
  v_collector_id   uuid;
  v_existing       uuid;
  v_notes          text;
begin
  -- Resolve the transaction from the receipt token. Undone transactions
  -- are not disputable (the receipt page itself 404s for them).
  select t.id, t.collector_id
    into v_transaction_id, v_collector_id
    from public.transactions t
   where t.receipt_token = p_receipt_token
     and t.undone_at is null
   limit 1;

  if v_transaction_id is null then
    return 'not_found';
  end if;

  -- Idempotency: one open dispute per transaction. A re-submit (saver taps
  -- twice, refreshes the acknowledgment page) must not fork a second row.
  select d.id
    into v_existing
    from public.disputes d
   where d.transaction_id = v_transaction_id
     and d.status = 'open'
   limit 1;

  if v_existing is not null then
    return 'already_disputed';
  end if;

  -- Blank / whitespace-only free-text collapses to NULL.
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- Insert guarded by disputes_one_open_per_transaction. A concurrent POST
  -- that raced past the existence check above loses here on unique_violation.
  begin
    insert into public.disputes (collector_id, transaction_id, flagged_via, notes)
    values (v_collector_id, v_transaction_id, 'receipt_url', v_notes);
    -- The audit_disputes trigger hash-chains the dispute.flagged event.
  exception
    when unique_violation then
      return 'already_disputed';
  end;

  return 'created';
end;
$$;

comment on function public.flag_transaction_dispute(text, text) is
  'Story 10.1 — records a saver-flagged dispute from the receipt-URL Worker (service-role, no JWT). Resolves collector_id from the receipt token, NOT auth.uid(). Idempotent: returns already_disputed if an open dispute exists. Returns created | already_disputed | not_found.';

grant execute on function public.flag_transaction_dispute(text, text) to service_role;
revoke execute on function public.flag_transaction_dispute(text, text) from public;
revoke execute on function public.flag_transaction_dispute(text, text) from anon;
revoke execute on function public.flag_transaction_dispute(text, text) from authenticated;
