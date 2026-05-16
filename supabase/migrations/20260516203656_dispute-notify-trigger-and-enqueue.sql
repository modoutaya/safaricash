-- Story 10.2 — dispute-notify: the invocation trigger + the dispute_ack enqueue RPC.
--
-- Two pieces:
--
-- 1. enqueue_dispute_ack(p_transaction_id) — a SECURITY DEFINER RPC that
--    resolves the saver's decrypted phone, renders the body via the
--    already-built format_sms_body('dispute_ack', …), and INSERTs a
--    'dispute_ack' sms_queue row. The existing sms-worker sends it. Granted
--    to service_role ONLY — it is called by the dispute-notify Edge Function
--    (service-role, no JWT), so it resolves collector_id from the transaction,
--    NOT auth.uid(). It deliberately does NOT gate on members.sms_opt_out: a
--    dispute acknowledgment is a transactional response to the saver's own
--    explicit action (it carries the reference number they need), not an
--    unsolicited notification (FR32's opt-out target).
--
-- 2. dispute_notify_trigger() + the AFTER INSERT trigger on public.disputes —
--    pg_net.http_post to the dispute-notify Edge Function when a dispute row
--    is inserted (by Story 10.1's flag_transaction_dispute, which is
--    idempotent — fires exactly once per genuine new dispute). The full
--    function URL + the service-role key are read from Vault at trigger time;
--    the WHERE EXISTS guard makes it a clean no-op on an unseeded local stack.
--    pg_net queues the request asynchronously and sends it AFTER the
--    surrounding transaction commits, so the saver's POST is never blocked.
--    The net.http_post is wrapped in its own EXCEPTION block so a pg_net
--    failure can NEVER roll back the disputes INSERT — the dispute record
--    (Story 10.1) is the source of truth; this notification is best-effort.
--
--    Operator setup (post-deploy):
--      select vault.create_secret(
--        'https://<project>.supabase.co/functions/v1/dispute-notify',
--        'dispute_notify_url');
--      select vault.create_secret('<service-role-jwt>', 'service_role_key');
--    The URL is stored as the FULL function URL and POSTed verbatim — a
--    dedicated secret, NOT derived from the sms-worker cron's 'project_url'
--    (which that cron POSTs without a path; one secret cannot serve both).
--
-- See: _bmad-output/implementation-artifacts/10-2-dispute-notify-edge-function.md

set check_function_bodies = off;

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- 1. enqueue_dispute_ack — enqueue the saver's dispute-acknowledgment SMS.
--    Returns (enqueued int, reason text):
--      (1, NULL)        — happy path; one row enqueued
--      (0, 'not_found') — no transaction for p_transaction_id
--      (0, 'no_phone')  — cash-only saver (empty phone_number_encrypted)
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_dispute_ack(
  p_transaction_id uuid
)
returns table (enqueued int, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id uuid;
  v_phone        text;
begin
  -- Resolve collector + the saver's decrypted phone from the transaction.
  -- NO auth.uid() — the dispute-notify Edge Function calls this under the
  -- service-role key with no JWT context.
  select t.collector_id,
         coalesce(public.vault_decrypt(m.phone_number_encrypted), '')
    into v_collector_id, v_phone
    from public.transactions t
    join public.members m on m.id = t.member_id
   where t.id = p_transaction_id;

  if v_collector_id is null then
    return query select 0, 'not_found'::text;
    return;
  end if;

  -- Cash-only saver — no phone, no SMS path.
  if v_phone is null or trim(v_phone) = '' then
    return query select 0, 'no_phone'::text;
    return;
  end if;

  -- NOTE: deliberately NOT gated on members.sms_opt_out — see the header.
  insert into public.sms_queue (
    collector_id, transaction_id, recipient_phone, body, status,
    template_key, retry_count
  )
  values (
    v_collector_id,
    p_transaction_id,
    v_phone,
    public.format_sms_body('dispute_ack', p_transaction_id),
    'queued',
    'dispute_ack',
    0
  );

  return query select 1, null::text;
end;
$$;

comment on function public.enqueue_dispute_ack(uuid) is
  'Story 10.2 — enqueues the saver dispute-acknowledgment SMS (template_key=dispute_ack) for a transaction. SECURITY DEFINER, service_role-only (called by the dispute-notify Edge Function). Resolves collector_id from the transaction, NOT auth.uid(). Does NOT gate on sms_opt_out (transactional response to the saver action). Returns (1, NULL) | (0, not_found) | (0, no_phone).';

grant execute on function public.enqueue_dispute_ack(uuid) to service_role;
revoke execute on function public.enqueue_dispute_ack(uuid) from public;
revoke execute on function public.enqueue_dispute_ack(uuid) from anon;
revoke execute on function public.enqueue_dispute_ack(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. dispute_notify_trigger — invoke /functions/v1/dispute-notify on a new
--    disputes row. The pg_net request is queued async + sent post-commit.
-- ---------------------------------------------------------------------------

create or replace function public.dispute_notify_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Vault holds the FULL dispute-notify function URL ('dispute_notify_url',
  -- POSTed verbatim) + the service-role JWT ('service_role_key'). The
  -- WHERE EXISTS guard no-ops cleanly when Vault is unseeded (fresh local /
  -- CI stacks). The inner EXCEPTION block isolates a pg_net failure from the
  -- disputes INSERT — a notification hiccup must never lose the dispute.
  begin
    perform net.http_post(
      url := (
        select decrypted_secret from vault.decrypted_secrets where name = 'dispute_notify_url' limit 1
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1
        )
      ),
      body := jsonb_build_object(
        'dispute_id', new.id,
        'transaction_id', new.transaction_id,
        'collector_id', new.collector_id
      ),
      timeout_milliseconds := 15000
    )
    where exists (select 1 from vault.decrypted_secrets where name = 'service_role_key')
      and exists (select 1 from vault.decrypted_secrets where name = 'dispute_notify_url');
  exception when others then
    raise warning 'dispute_notify_trigger: net.http_post failed (%) — dispute % recorded, notification skipped',
      sqlerrm, new.id;
  end;

  return new;
end;
$$;

comment on function public.dispute_notify_trigger() is
  'Story 10.2 — AFTER INSERT trigger on public.disputes. pg_net.http_post to the dispute-notify Edge Function (dispute_notify_url + service_role_key from Vault). WHERE EXISTS-guarded (no-ops on an unseeded stack); the net.http_post is EXCEPTION-isolated so a pg_net failure never rolls back the disputes INSERT.';

revoke execute on function public.dispute_notify_trigger() from public;

create trigger dispute_notify_after_insert
  after insert on public.disputes
  for each row execute function public.dispute_notify_trigger();
