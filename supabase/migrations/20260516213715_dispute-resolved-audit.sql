-- Story 10.3 — dispute resolution audit: audit_emit (disputes, UPDATE) branch
-- + the audit_disputes trigger extended to AFTER INSERT OR UPDATE.
--
-- Story 10.1 added the audit_disputes trigger as AFTER INSERT only, and its
-- audit_emit branch handles only (disputes, INSERT) → 'dispute.flagged' — the
-- 10.1 migration's comment said "dispute resolution (UPDATE) is Story 10.3 and
-- adds its own branch when it lands". This is that branch.
--
-- Story 10.3's collector-side "Marquer comme résolue" action does a direct
-- RLS-scoped PostgREST UPDATE on public.disputes (status open → resolved).
-- For that UPDATE to hash-chain an audit event:
--   1. audit_emit() gains a status-aware (disputes, UPDATE) CASE branch
--      (open → resolved ⇒ 'dispute.resolved'; any other UPDATE ⇒
--      'dispute.updated' — a defensive catch-all).
--   2. the audit_disputes trigger fires on UPDATE as well as INSERT.
--
-- The audit_emit() body below is reproduced from its CURRENT definition —
-- migration 20260516101216 (Story 10.1, the latest to touch it) — preserving
-- EVERY existing branch (Story 2.5 actor-JWT fallback, 3.3 cycle.transitioned,
-- 4.5 transaction.undone, 10.1 dispute.flagged). ONLY the two new
-- (disputes, UPDATE) CASE lines are added. The audit_log.event_type CHECK
-- (migration 0003) is a regex `^[a-z][a-z_]*\.[a-z][a-z_]*$` — NOT an
-- allowlist — so 'dispute.resolved' / 'dispute.updated' already pass.
--
-- See: _bmad-output/implementation-artifacts/10-3-dispute-member-profile-banner.md

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
    -- Story 10.1 — a saver-flagged dispute.
    when v_entity_table = 'disputes'     and v_op = 'INSERT' then 'dispute.flagged'
    -- Story 10.3 — the collector resolves a dispute: status open → resolved.
    when v_entity_table = 'disputes'     and v_op = 'UPDATE'
         and (v_payload->>'status') = 'resolved'
         and (to_jsonb(old)->>'status') = 'open'       then 'dispute.resolved'
    when v_entity_table = 'disputes'     and v_op = 'UPDATE' then 'dispute.updated'
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
  'AFTER INSERT/UPDATE/DELETE trigger function. Story 10.3: (disputes, UPDATE) -> dispute.resolved (open->resolved) / dispute.updated. Story 10.1 dispute.flagged + Story 4.5 transaction.undone + Story 3.3 cycle.transitioned + Story 2.5 actor-JWT fallback PRESERVED. Hash chain unchanged.';

revoke execute on function public.audit_emit() from public;

-- Extend the disputes audit trigger to fire on UPDATE as well as INSERT
-- (mirrors audit_members / audit_cycles / audit_transactions).
drop trigger if exists audit_disputes on public.disputes;

create trigger audit_disputes
  after insert or update on public.disputes
  for each row execute function public.audit_emit();
