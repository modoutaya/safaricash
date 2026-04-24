-- Story 3.3 — Migration 0020: extend audit_emit() with cycle.transitioned.
--
-- A new event type slots into the cycle CASE branch BETWEEN cycle.settled
-- and the catch-all cycle.updated. Triggered when a cycles UPDATE changes
-- the `status` field to anything OTHER than 'settled' (which already has
-- its dedicated event). Story 3.3 introduces this so the
-- promote_cycle_on_advance trigger (migration 0021) produces a discoverable
-- event for analytics queries like "how many cycles ever entered
-- with_advance state?".
--
-- The CHECK constraint on audit_log.event_type (migration 0003) accepts
-- the new event without modification — the regex
-- `^[a-z][a-z_]*\.[a-z][a-z_]*$` matches.
--
-- Hash chain UNCHANGED: only the CASE branch text differs; the canonical
-- serialiser order, delimiter (\x1F), and field set are identical. New
-- rows hash correctly; old rows remain valid.
--
-- See: _bmad-output/implementation-artifacts/3-3-cycle-status-transitions.md
-- AC #2 + #10.

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
    -- Story 3.3 — non-settled status flips (active ↔ with_advance, plus
    -- the future demotion path) get a dedicated event. Status set to the
    -- same value falls through to cycle.updated (the diff is null).
    when v_entity_table = 'cycles'       and v_op = 'UPDATE'
         and (v_payload->>'status') is distinct from (to_jsonb(old)->>'status')
         and (v_payload->>'status') <> 'settled'
         then 'cycle.transitioned'
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
  'AFTER INSERT/UPDATE/DELETE trigger function. Story 3.3 update: non-settled status flips on cycles emit cycle.transitioned (not cycle.updated). Hash chain unchanged. Story 2.5 actor JWT fix preserved.';
