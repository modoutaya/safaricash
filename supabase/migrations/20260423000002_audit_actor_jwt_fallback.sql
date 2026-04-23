-- Story 2.5 — Migration 0017: audit actor reads BOTH legacy + modern JWT GUCs.
--
-- Bug surfaced by Story 2.5's E2E (first spec to assert against
-- audit_log.actor): every audit row was landing as actor='system', even
-- when the originating call came from an authenticated browser session.
--
-- Root cause: PostgREST 12+ stopped setting individual `request.jwt.claim.*`
-- GUCs and now only sets the JSON `request.jwt.claims`. The audit trigger's
-- read of `current_setting('request.jwt.claim.sub', true)` always returns
-- NULL → falls back to 'system'.
--
-- Fix: mirror Supabase's own auth.uid() implementation, which coalesces
-- the legacy GUC AND the modern JSON form. This restores actor=user_uuid
-- for all browser-driven writes and keeps actor='system' for service-role
-- + cron paths (where neither GUC is set).
--
-- All other audit machinery — hash chain, canonical serialisation, per-
-- collector advisory lock — is unchanged. The serialised payload's `actor`
-- field will now carry the correct UUID, so verifiers walking the chain
-- continue to compute identical entry_hashes from the new rows. Old rows
-- with actor='system' remain unchanged (the chain was internally consistent
-- under the buggy actor; rewriting history would be the wrong fix).

set check_function_bodies = off;

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
    when v_entity_table = 'cycles'       and v_op = 'UPDATE' then 'cycle.updated'
    when v_entity_table = 'cycles'       and v_op = 'DELETE' then 'cycle.deleted'
    when v_entity_table = 'transactions' and v_op = 'INSERT' then 'transaction.committed'
    when v_entity_table = 'transactions' and v_op = 'UPDATE' then 'transaction.updated'
    when v_entity_table = 'transactions' and v_op = 'DELETE' then 'transaction.deleted'
    else null
  end;

  if v_event_type is null then
    raise exception 'audit_emit: unmapped (table, op) = (%, %).', v_entity_table, v_op;
  end if;

  v_source := coalesce(current_setting('app.source', true), 'online');
  if v_source not in ('online', 'offline_reconciled') then
    v_source := 'online';
  end if;

  -- Story 2.5 — mirror auth.uid()'s coalesce pattern. PostgREST 12+ only
  -- sets `request.jwt.claims` (JSON), not the legacy `request.jwt.claim.sub`.
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
  'AFTER INSERT/UPDATE/DELETE trigger function. Story 2.5 fix: actor reads from BOTH legacy request.jwt.claim.sub AND modern request.jwt.claims JSON to survive PostgREST 12+ migration. Hash chain unchanged.';
