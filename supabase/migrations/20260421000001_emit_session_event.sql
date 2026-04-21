-- Story 1.7 — emit_session_event: SECURITY DEFINER RPC that appends a
-- session-lifecycle event to audit_log's per-collector hash chain.
--
-- audit_emit() in migration 0007 is a trigger function (reads TG_TABLE_NAME /
-- TG_OP / NEW / OLD) and is not callable as an RPC. This migration adds a
-- dedicated function for session events (sign-out, sign-in-lockout, future
-- session.* taxonomy) that mirrors audit_emit's chain-hash logic byte-for-byte.
--
-- Client side (authenticated) calls:
--   supabase.rpc('emit_session_event', { p_reason: 'explicit' | 'idle' })
-- and receives void. The function derives collector_id from auth.uid(), so
-- there is no way for a caller to forge another collector's chain.
--
-- Canonical serialization MUST match audit_emit() in
-- 20260419000007_triggers_audit.sql lines 198-214 exactly — the downstream
-- offline audit-chain verifier walks every row the same way regardless of
-- emitter (trigger or RPC).

create or replace function public.emit_session_event(p_reason text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  -- Canonical event fields (same shape as audit_emit).
  v_event_id     uuid;
  v_event_type   text := 'session.signed_out';
  v_entity_id    uuid;
  v_entity_table text := 'sessions';
  v_timestamp    timestamptz;
  v_actor        text;
  v_source       text := 'online';
  v_payload      jsonb;
  v_collector_id uuid;

  -- Hash-chain
  v_prev_hash    bytea;
  v_entry_hash   bytea;

  -- Canonical serialization (bytewise identical to audit_emit).
  v_delim        bytea := decode('1F', 'hex');
  v_serialized   bytea;
  v_iso_ts       text;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'emit_session_event: caller is not authenticated';
  end if;

  if p_reason is null or p_reason not in ('explicit', 'idle') then
    -- Quote the caller-supplied value so attacker-controlled text cannot
    -- corrupt log parsing (e.g. injected newlines). quote_nullable(NULL)
    -- yields the literal string NULL rather than an empty substitution.
    raise exception 'emit_session_event: p_reason must be ''explicit'' or ''idle'' (got %)',
      quote_nullable(p_reason);
  end if;

  v_timestamp := clock_timestamp();
  v_event_id  := gen_random_uuid();
  -- Sentinel: session events have no natural entity; use the collector's own
  -- UUID so the NOT NULL constraints on audit_log.entity_id / entity_table
  -- are satisfied AND the existing idx_audit_log_entity_table_entity_id index
  -- can answer "session history for collector X" efficiently.
  v_entity_id := v_collector_id;
  v_actor     := v_collector_id::text;
  v_payload   := jsonb_build_object('reason', p_reason);

  -- Per-collector chain serialization lock — same advisory-lock namespace
  -- (0x5AFA) as audit_emit so a concurrent INSERT from a data-table trigger
  -- and this RPC cannot fork the chain by reading the same prev_hash.
  perform pg_advisory_xact_lock(0x5AFA, hashtext(v_collector_id::text));

  select entry_hash into v_prev_hash
  from public.audit_log
  where collector_id = v_collector_id
  order by timestamp desc, event_id desc
  limit 1;
  -- v_prev_hash stays NULL for the first row of the chain.

  -- Canonical serialization — MUST match audit_emit() byte-for-byte.
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
end;
$$;

comment on function public.emit_session_event(text) is
  'Story 1.7 — SECURITY DEFINER RPC that appends a session.signed_out event to the authenticated collector''s audit_log chain. p_reason must be ''explicit'' (user tapped Se déconnecter) or ''idle'' (30-min timeout, Story 1.6). Callable by authenticated only; anon denied via GRANT.';

-- Lock the function to authenticated callers. The SECURITY DEFINER body
-- already checks auth.uid() so a call from service_role would also work;
-- GRANT EXECUTE to authenticated is the blessed surface.
revoke execute on function public.emit_session_event(text) from public;
revoke execute on function public.emit_session_event(text) from anon;
grant execute on function public.emit_session_event(text) to authenticated;
