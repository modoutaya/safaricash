-- Story 6.5 — Migration 0046: extend audit_append_external allowlist for
-- the sms.opt_out event.
--
-- The Story 6.2 baseline (migration 0037,
-- 20260428000001_audit_append_external_extend_sms_events.sql) shipped the
-- allowlist as {sms.queued, sms.sent, sms.failed, sms.abandoned}. Story 6.5
-- adds 'sms.opt_out'. Function body is byte-for-byte identical EXCEPT the
-- allowlist line + a comment line — same diff discipline as 6.2.
--
-- See: _bmad-output/implementation-artifacts/6-5-first-sms-consent-optout.md AC #3 / #11.

set check_function_bodies = off;

create or replace function public.audit_append_external(
  p_event_type   text,
  p_entity_id    uuid,
  p_entity_table text,
  p_payload      jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_event_id     uuid;
  v_collector_id uuid;
  v_timestamp    timestamptz;
  v_actor        text;
  v_source       text;
  v_prev_hash    bytea;
  v_entry_hash   bytea;

  v_delim        bytea := decode('1F', 'hex');
  v_serialized   bytea;
  v_iso_ts       text;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Allowed external event types — guard against drift / typos.
  -- Story 6.1: 'sms.queued'. Story 6.2: 'sms.sent', 'sms.failed', 'sms.abandoned'.
  -- Story 6.5: 'sms.opt_out'.
  if p_event_type not in ('sms.queued', 'sms.sent', 'sms.failed', 'sms.abandoned', 'sms.opt_out') then
    raise exception 'invalid_event_type: % is not an allowed external event', p_event_type
      using errcode = '22000';
  end if;

  v_timestamp := clock_timestamp();
  v_event_id  := gen_random_uuid();

  v_source := coalesce(current_setting('app.source', true), 'online');
  if v_source not in ('online', 'offline_reconciled') then
    v_source := 'online';
  end if;

  -- 3-tier actor JWT fallback (mirrors the Story 2.5 audit_emit fix).
  v_actor := coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    'system'
  );

  -- Per-collector chain serialisation lock — prevents two concurrent
  -- INSERTs for the same collector from forking the chain.
  perform pg_advisory_xact_lock(0x5AFA, hashtext(v_collector_id::text));

  select entry_hash into v_prev_hash
  from public.audit_log
  where collector_id = v_collector_id
  order by timestamp desc, event_id desc
  limit 1;

  v_iso_ts := to_char(v_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  -- MUST match the audit_emit canonical serialiser byte-for-byte.
  v_serialized :=
    coalesce(v_prev_hash, ''::bytea)              || v_delim ||
    convert_to(v_event_id::text, 'UTF8')          || v_delim ||
    convert_to(p_event_type, 'UTF8')              || v_delim ||
    convert_to(v_collector_id::text, 'UTF8')      || v_delim ||
    convert_to(p_entity_id::text, 'UTF8')         || v_delim ||
    convert_to(p_entity_table, 'UTF8')            || v_delim ||
    convert_to(v_iso_ts, 'UTF8')                  || v_delim ||
    convert_to(v_actor, 'UTF8')                   || v_delim ||
    convert_to(v_source, 'UTF8')                  || v_delim ||
    convert_to(public.canonical_jsonb(p_payload), 'UTF8');

  v_entry_hash := extensions.digest(v_serialized, 'sha256');

  insert into public.audit_log (
    event_id, event_type, collector_id, entity_id, entity_table,
    timestamp, actor, source, payload, prev_hash, entry_hash
  ) values (
    v_event_id, p_event_type, v_collector_id, p_entity_id, p_entity_table,
    v_timestamp, v_actor, v_source, p_payload, v_prev_hash, v_entry_hash
  );

  return v_event_id;
end;
$$;

comment on function public.audit_append_external(text, uuid, text, jsonb) is
  'Story 6.1/6.2/6.5 — SECURITY DEFINER helper for non-trigger audit events. Mirrors audit_emit canonical serialisation byte-for-byte. Allowed event_types: sms.queued (Story 6.1 — manual sms-dispatch), sms.sent / sms.failed / sms.abandoned (Story 6.2 — sms-worker terminal states), sms.opt_out (Story 6.5 — saver consent withdrawal).';

grant execute on function public.audit_append_external(text, uuid, text, jsonb) to authenticated;
revoke execute on function public.audit_append_external(text, uuid, text, jsonb) from public;
