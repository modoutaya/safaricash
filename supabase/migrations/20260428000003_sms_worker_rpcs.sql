-- Story 6.2 — Migration 0039: sms-worker RPCs.
--
-- Two RPCs the sms-worker Edge Function calls:
--
--   1. claim_sms_queue_batch(p_batch_size, p_claim_ttl_seconds)
--      — atomic FOR UPDATE SKIP LOCKED claim of ready rows. Filters out
--        soft-undone transactions (Story 4.5 handshake) and rows that
--        another worker already claimed less than p_claim_ttl_seconds
--        ago (defends against worker-tick overlap). Updates
--        last_attempt_at as the claim marker so rows become re-claimable
--        if the worker crashes mid-dispatch.
--
--   2. audit_append_external (5-arg overload)
--      — same canonical-serialisation chain logic as the 4-arg variant
--        from migration 0036/0037, but accepts an explicit p_collector_id
--        instead of resolving auth.uid(). The worker authenticates as
--        service-role at the Edge Function boundary, so auth.uid() is
--        unset; the worker passes the row's owning collector_id.
--      — Implementation: sets request.jwt.claim.sub for the duration of
--        the transaction and delegates to the 4-arg variant. Keeps the
--        canonical serialiser in ONE place (the 4-arg function).
--
-- See: _bmad-output/implementation-artifacts/6-2-sms-worker-termii-retry.md AC #2/#11.

set check_function_bodies = off;

-- 1. claim_sms_queue_batch
create or replace function public.claim_sms_queue_batch(
  p_batch_size         int default 10,
  p_claim_ttl_seconds  int default 90
)
returns table (
  id              uuid,
  collector_id    uuid,
  transaction_id  uuid,
  recipient_phone text,
  body            text,
  template_key    text,
  retry_count     int,
  age_seconds     int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with claimed as (
    select sq.id
    from public.sms_queue sq
    left join public.transactions t on t.id = sq.transaction_id
    where sq.status = 'queued'
      and sq.abandoned_at is null
      and (sq.next_retry_at is null or sq.next_retry_at <= now())
      and (
        sq.last_attempt_at is null
        or sq.last_attempt_at < now() - (p_claim_ttl_seconds || ' seconds')::interval
      )
      and (t.id is null or t.undone_at is null)
    order by sq.next_retry_at nulls first, sq.created_at
    limit greatest(p_batch_size, 1)
    for update of sq skip locked
  )
  update public.sms_queue sq
     set last_attempt_at = now()
    from claimed
   where sq.id = claimed.id
   returning
     sq.id,
     sq.collector_id,
     sq.transaction_id,
     sq.recipient_phone,
     sq.body,
     sq.template_key,
     sq.retry_count,
     extract(epoch from (now() - sq.created_at))::int as age_seconds;
end;
$$;

comment on function public.claim_sms_queue_batch(int, int) is
  'Story 6.2 — atomic FOR UPDATE SKIP LOCKED claim of ready sms_queue rows. Marks claimed rows with last_attempt_at = now() so they become re-claimable after p_claim_ttl_seconds (defends against worker mid-dispatch crash).';

grant execute on function public.claim_sms_queue_batch(int, int) to service_role;
revoke execute on function public.claim_sms_queue_batch(int, int) from public;
revoke execute on function public.claim_sms_queue_batch(int, int) from authenticated;

-- 2. audit_append_external (5-arg overload with explicit p_collector_id)
create or replace function public.audit_append_external(
  p_event_type   text,
  p_entity_id    uuid,
  p_entity_table text,
  p_payload      jsonb,
  p_collector_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
begin
  if p_collector_id is null then
    raise exception 'p_collector_id is required' using errcode = '22000';
  end if;
  perform set_config('request.jwt.claim.sub', p_collector_id::text, true);
  v_event_id := public.audit_append_external(p_event_type, p_entity_id, p_entity_table, p_payload);
  return v_event_id;
end;
$$;

comment on function public.audit_append_external(text, uuid, text, jsonb, uuid) is
  'Story 6.2 — 5-arg overload for callers without auth.uid() context (e.g., the sms-worker authenticated as service-role). Sets request.jwt.claim.sub locally and delegates to the 4-arg variant — the canonical serialiser lives in ONE place.';

grant execute on function public.audit_append_external(text, uuid, text, jsonb, uuid) to service_role;
revoke execute on function public.audit_append_external(text, uuid, text, jsonb, uuid) from public;
revoke execute on function public.audit_append_external(text, uuid, text, jsonb, uuid) from authenticated;
