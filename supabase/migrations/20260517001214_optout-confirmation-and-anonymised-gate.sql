-- Story 10.5 — saver opt-out action surface from the receipt URL (FR32).
--
-- FIFTH and FINAL story of Epic 10. Story 6.5 already shipped the
-- receipt-URL opt-out plumbing (the GET/POST /r/{token}/opt-out routes,
-- set_member_sms_opt_out, the footer link, the form/confirmed pages).
-- This migration completes the two pieces 6.5 deferred:
--
--   1. The FINAL CONFIRMATION SMS.
--      - format_sms_body() gains an 'opt_out_confirmation' template — a
--        STATIC, member-scoped body (no transaction context), so the
--        branch returns BEFORE the transaction fetch. The body is
--        reproduced from the CURRENT definition; the 4 existing templates
--        (first_receipt / subsequent_receipt / settlement / dispute_ack)
--        are preserved verbatim.
--      - The sms_queue.template_key CHECK gains 'opt_out_confirmation'.
--      - set_member_sms_opt_out() enqueues the confirmation SMS via a
--        direct INSERT — AFTER the idempotent early-return (so it is sent
--        exactly once per opt-out) and ONLY when p_via = 'receipt_url'
--        (STOP-keyword / collector-action opt-outs do not get one). It is
--        NOT routed through the enqueue_sms_on_transaction trigger (which
--        short-circuits on sms_opt_out), so it is sent despite the flag
--        now being true — the enqueue_dispute_ack precedent. transaction_id
--        is NULL: the opt-out is member-scoped, not transaction-scoped.
--
--   2. The anonymised_at GATE (Story 10.4 shipped members.anonymised_at).
--      - get_receipt_payload() returns anonymised_at so the Worker can hide
--        the footer opt-out link for an anonymised member.
--      - get_member_id_from_token() returns anonymised_at alongside
--        member_id so the Worker can 404 the opt-out routes for an
--        anonymised member. Its return type changes (scalar uuid -> a row),
--        so it is DROP + CREATE, not CREATE OR REPLACE.
--
-- See: _bmad-output/implementation-artifacts/10-5-saver-optout-action.md

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. format_sms_body — + the 'opt_out_confirmation' static template.
--    Reproduced from the current definition (20260515000001, the latest
--    migration that defines format_sms_body — it already carries all 4
--    templates incl. dispute_ack). The 4 existing templates are preserved
--    verbatim. ONLY the allowlist entry and the early-return branch are new.
-- ---------------------------------------------------------------------------

create or replace function public.format_sms_body(p_template_key text, p_transaction_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_tx              record;
  v_member          record;
  v_advances_sum    numeric(12, 0);
  v_amount          numeric(12, 0);
  v_projected       numeric(12, 0);
  v_url_base        text;
  v_url             text;
  v_prenom          text;
  v_amount_str      text;
  v_projected_str   text;
  v_dispute_ref     text;
  -- Story 7.5 — new locals for the settlement-branch dates.
  v_cycle_start_str text;
  v_cycle_end_str   text;
begin
  if p_template_key not in ('first_receipt', 'subsequent_receipt', 'settlement', 'dispute_ack', 'opt_out_confirmation') then
    raise exception 'invalid_template_key: % is not a recognised template', p_template_key
      using errcode = '22000';
  end if;

  -- Story 10.5 — the opt-out confirmation is a STATIC, member-scoped body.
  -- It has no transaction context (callers pass p_transaction_id = NULL),
  -- so return before the transaction fetch below. GSM-7 single-SMS,
  -- accent-free (matches the other templates), banking-language-clean.
  if p_template_key = 'opt_out_confirmation' then
    return 'SafariCash. Vous ne recevrez plus de SMS. Pour les reactiver, contactez votre collecteur.';
  end if;

  -- Fetch transaction + decrypted amount.
  select t.id, t.member_id, t.cycle_id, t.kind, t.cycle_day, t.receipt_token,
         nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount
    into v_tx
    from public.transactions t
   where t.id = p_transaction_id;

  if v_tx.id is null then
    raise exception 'transaction_not_found: % does not exist', p_transaction_id
      using errcode = 'P0002';
  end if;

  v_amount := v_tx.amount;

  -- Receipt URL base (Story 6.4 hand-off).
  v_url_base := coalesce(
    nullif(current_setting('app.receipt_url_base', true), ''),
    'https://safaricash.app/r'
  );
  v_url := v_url_base || '/' || v_tx.receipt_token;

  -- Format amount with ASCII-space thousands separators (Postgres default
  -- is comma; replace to align with French SMS convention).
  v_amount_str := replace(to_char(v_amount, 'FM999G999G999'), ',', ' ');

  if p_template_key = 'first_receipt' or p_template_key = 'subsequent_receipt' then
    -- Decrypt + sanitise member name → first token, unaccent, truncate to 16.
    select unaccent(public.vault_decrypt(m.name_encrypted)) as full_name,
           m.daily_amount
      into v_member
      from public.members m
     where m.id = v_tx.member_id;

    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 16);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    -- Advances on this cycle (excludes soft-undone rows; mirrors the
    -- cycleEngine `dailyAmount * 29 - sum(advances)` formula).
    select coalesce(sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0)), 0)
      into v_advances_sum
      from public.transactions t2
     where t2.cycle_id = v_tx.cycle_id
       and t2.kind = 'advance'
       and t2.undone_at is null;

    v_projected := v_member.daily_amount * 29 - v_advances_sum;
    v_projected_str := replace(to_char(v_projected, 'FM999G999G999'), ',', ' ');

    if p_template_key = 'first_receipt' then
      return format(
        'Bonjour %s. Recu SafariCash: %s FCFA, jour %s/30. Solde projete fin de cycle: %s FCFA. Detail: %s. SafariCash est un journal d''epargne et non une banque. Repondez STOP pour ne plus recevoir.',
        v_prenom, v_amount_str, v_tx.cycle_day, v_projected_str, v_url
      );
    else
      return format(
        'SafariCash. %s FCFA recu, jour %s/30. Solde projete: %s FCFA. Detail: %s.',
        v_amount_str, v_tx.cycle_day, v_projected_str, v_url
      );
    end if;
  end if;

  if p_template_key = 'settlement' then
    -- Story 7.5 — settlement SMS receives the saver's first name + cycle
    -- date range (per BDD line 1163). GSM-7 single-SMS discipline:
    -- unaccent the name, cap firstName at 9 chars (typical Senegalese
    -- names + worst-case 9-digit amount = exactly 160 chars), omit the
    -- year (DD/MM only), use plain digits (no NBSP) for the amount.
    -- Closing statement deferred to the Worker receipt page (longer
    -- "Merci de votre confiance..." copy) to keep the SMS in single-SMS.
    select unaccent(public.vault_decrypt(m.name_encrypted)) as full_name
      into v_member
      from public.members m
     where m.id = v_tx.member_id;

    -- Code-review patch #1 — cap at 9 (was 16; combined with the removed
    -- 'Merci. ' suffix this puts the worst-case body at exactly 160 chars).
    v_prenom := substring(coalesce(split_part(v_member.full_name, ' ', 1), 'Saver') from 1 for 9);
    if v_prenom = '' then v_prenom := 'Saver'; end if;

    select to_char(c.start_date, 'DD/MM'), to_char(c.end_date, 'DD/MM')
      into v_cycle_start_str, v_cycle_end_str
      from public.cycles c
     where c.id = v_tx.cycle_id;

    -- Code-review patch #1 — 'Merci. ' removed (7 chars saved) so the
    -- template fits under the 160-char single-SMS cap at worst case
    -- (firstName 9 + 9-digit amount + 32-hex token + default URL prefix).
    return format(
      'SafariCash. %s, votre cycle du %s au %s est clos. Vous avez recu %s FCFA. Detail: %s.',
      v_prenom, v_cycle_start_str, v_cycle_end_str,
      to_char(v_amount, 'FM999999999'), v_url
    );
  end if;

  -- p_template_key = 'dispute_ack'
  -- Dispute reference = first 8 chars of the most recent disputes.id for
  -- this transaction (Story 10.2 will wire the row creation).
  select substring(d.id::text from 1 for 8)
    into v_dispute_ref
    from public.disputes d
   where d.transaction_id = p_transaction_id
   order by d.flagged_at desc
   limit 1;

  if v_dispute_ref is null then
    -- Defensive — Story 10.2 should always create a disputes row before
    -- calling format_sms_body('dispute_ack', ...). Fall back to a stable
    -- placeholder rather than NULL-leaking into the SMS body.
    v_dispute_ref := 'pending';
  end if;

  return format(
    'SafariCash. Votre signalement a ete recu. Reponse sous 48h. Reference: %s.',
    v_dispute_ref
  );
end;
$function$;

comment on function public.format_sms_body(text, uuid) is
  'Story 10.5: + the opt_out_confirmation static template (member-scoped, returns before the transaction fetch). Story 7.5 settlement + 10.2 dispute_ack + 6.3 receipt templates PRESERVED.';

-- Re-state the grants (CREATE OR REPLACE preserves them, but keeping the
-- migration self-contained for db:reset cycles — Story 7.5 CR patch #4).
grant execute on function public.format_sms_body(text, uuid) to authenticated, service_role;
revoke execute on function public.format_sms_body(text, uuid) from public;

-- ---------------------------------------------------------------------------
-- 2. sms_queue.template_key CHECK — + 'opt_out_confirmation'.
--    NOT VALID + a separate VALIDATE so the ADD CONSTRAINT does not take a
--    full-table validating lock-scan (the 20260512000001 pattern).
-- ---------------------------------------------------------------------------

alter table public.sms_queue
  drop constraint sms_queue_template_key_chk;

alter table public.sms_queue
  add constraint sms_queue_template_key_chk
  check (template_key = any (array[
    'first_receipt', 'subsequent_receipt', 'settlement',
    'dispute_ack', 'resend', 'opt_out_confirmation'
  ]))
  not valid;

alter table public.sms_queue
  validate constraint sms_queue_template_key_chk;

comment on constraint sms_queue_template_key_chk on public.sms_queue is
  'Allowed SMS template keys. Story 10.5 added opt_out_confirmation; Story 6.6 added resend; Story 7.5 settlement; Story 10.2 dispute_ack.';

-- ---------------------------------------------------------------------------
-- 3. set_member_sms_opt_out — enqueue the opt-out confirmation SMS.
--    Reproduced from 20260501000004; everything PRESERVED. The new block
--    is the receipt_url-gated confirmation INSERT after the audit emit.
-- ---------------------------------------------------------------------------

create or replace function public.set_member_sms_opt_out(p_member_id uuid, p_via text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_collector_id uuid;
  v_already      boolean;
  v_phone        text;
begin
  if p_via not in ('stop_keyword', 'receipt_url', 'collector_action') then
    raise exception 'invalid_via: % is not a recognised opt-out source', p_via
      using errcode = '22000';
  end if;

  -- Story 10.5 — the decrypted phone is read here, in the SAME row read as
  -- collector_id/sms_opt_out, so the confirmation-SMS recipient is captured
  -- atomically (no second SELECT racing a concurrent anonymise_member).
  select collector_id, sms_opt_out,
         coalesce(public.vault_decrypt(phone_number_encrypted), '')
    into v_collector_id, v_already, v_phone
    from public.members
   where id = p_member_id;

  if v_collector_id is null then
    raise exception 'member_not_found: % does not exist', p_member_id
      using errcode = 'P0002';
  end if;

  -- Idempotent: already opted out → no-op (no second audit event, and —
  -- Story 10.5 — no second confirmation SMS: the enqueue below sits past
  -- this early-return, so a repeated POST /opt-out never double-sends).
  if v_already then
    return;
  end if;

  update public.members
     set sms_opt_out     = true,
         sms_opt_out_at  = now(),
         sms_opt_out_via = p_via,
         updated_at      = now()
   where id = p_member_id;

  -- Cancel any queued sms_queue rows for this member's transactions —
  -- the worker's drain query will skip future enqueues (the trigger
  -- short-circuits via members.sms_opt_out), but rows already inserted
  -- before the opt-out flip should not be dispatched.
  update public.sms_queue sq
     set status        = 'abandoned',
         abandoned_at  = now()
    from public.transactions t
   where t.id = sq.transaction_id
     and t.member_id = p_member_id
     and sq.status = 'queued';

  -- Audit emit via the 5-arg overload (Story 6.2). Sets
  -- request.jwt.claim.sub = p_collector_id internally and delegates
  -- to the 4-arg variant — the canonical serialiser stays in ONE place.
  perform public.audit_append_external(
    'sms.opt_out',
    p_member_id,
    'members',
    jsonb_build_object('via', p_via),
    v_collector_id
  );

  -- Story 10.5 — the FINAL CONFIRMATION SMS. Sent only when the opt-out
  -- came from the receipt-URL action surface (FR32); a STOP-keyword or
  -- collector-action opt-out does not get one. A direct INSERT (NOT the
  -- enqueue_sms_on_transaction trigger, which short-circuits on
  -- sms_opt_out) so it is dispatched despite the flag now being true —
  -- the enqueue_dispute_ack precedent. transaction_id is NULL: the
  -- opt-out is member-scoped. The idempotent early-return above means
  -- this runs exactly once per opt-out. A phone-less saver → no SMS.
  if p_via = 'receipt_url' then
    if v_phone is not null and trim(v_phone) <> '' then
      insert into public.sms_queue (
        collector_id, transaction_id, recipient_phone, body, status,
        template_key, retry_count
      )
      values (
        v_collector_id,
        null,
        v_phone,
        public.format_sms_body('opt_out_confirmation', null),
        'queued',
        'opt_out_confirmation',
        0
      );
    end if;
  end if;
end;
$function$;

comment on function public.set_member_sms_opt_out(uuid, text) is
  'Story 6.5 / FR32 — flips members.sms_opt_out=true, cancels in-flight queued SMS, emits sms.opt_out audit event. Idempotent (no-op on repeat call). Story 10.5: when p_via=''receipt_url'', also enqueues ONE opt_out_confirmation SMS (direct INSERT, ungated, transaction_id NULL). service_role only.';

grant execute on function public.set_member_sms_opt_out(uuid, text) to service_role;
revoke execute on function public.set_member_sms_opt_out(uuid, text) from public;
revoke execute on function public.set_member_sms_opt_out(uuid, text) from authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_receipt_payload — + anonymised_at (the Worker hides the footer
--    opt-out link for an anonymised member). RETURNS TABLE shape changes,
--    so DROP + CREATE. Re-derived from 20260515000002.
-- ---------------------------------------------------------------------------

drop function if exists public.get_receipt_payload(text);

create function public.get_receipt_payload(p_token text)
returns table (
  amount             numeric(12, 0),
  kind               text,
  cycle_day          int,
  created_at         timestamptz,
  member_first_name  text,
  projected_balance  numeric(12, 0),
  daily_amount       numeric(12, 0),
  cycle_start_date   date,
  cycle_end_date     date,
  -- Story 10.5 — lets the Worker hide the opt-out link for an anonymised saver.
  anonymised_at      timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    nullif(public.vault_decrypt(t.amount_encrypted), '')::numeric(12, 0) as amount,
    t.kind::text,
    t.cycle_day,
    t.created_at,
    substring(unaccent(public.vault_decrypt(m.name_encrypted)) from '^[^ ]+') as member_first_name,
    (m.daily_amount * 29) - coalesce(
      (
        select sum(nullif(public.vault_decrypt(t2.amount_encrypted), '')::numeric(12, 0))
          from public.transactions t2
         where t2.cycle_id = t.cycle_id
           and t2.kind = 'advance'
           and t2.undone_at is null
      ),
      0
    ) as projected_balance,
    m.daily_amount,
    c.start_date as cycle_start_date,
    c.end_date   as cycle_end_date,
    m.anonymised_at
  from public.transactions t
  join public.members m on m.id = t.member_id
  join public.cycles  c on c.id = t.cycle_id
  where t.receipt_token = p_token
    and t.undone_at is null;
$$;

comment on function public.get_receipt_payload(text) is
  'Story 10.5 — receipt-page payload + anonymised_at (the Worker hides the opt-out link for an anonymised saver). Story 7.5 cycle dates + Story 6.4 baseline preserved: filters soft-undone rows, service_role only.';

grant execute on function public.get_receipt_payload(text) to service_role;
revoke execute on function public.get_receipt_payload(text) from public;
revoke execute on function public.get_receipt_payload(text) from authenticated;

-- ---------------------------------------------------------------------------
-- 5. get_member_id_from_token — return anonymised_at alongside member_id
--    (the Worker 404s the opt-out routes for an anonymised member). The
--    return type changes from a scalar uuid to a row, so DROP + CREATE.
-- ---------------------------------------------------------------------------

drop function if exists public.get_member_id_from_token(text);

create function public.get_member_id_from_token(p_token text)
returns table (member_id uuid, anonymised_at timestamptz)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.anonymised_at
    from public.transactions t
    join public.members m on m.id = t.member_id
   where t.receipt_token = p_token
     and t.undone_at is null
   limit 1;
$$;

comment on function public.get_member_id_from_token(text) is
  'Story 6.5 / 10.5 — receipt-url Worker opt-out lookup. Returns (member_id, anonymised_at) for a non-undone receipt token, or 0 rows. Story 10.5 added anonymised_at so the Worker can 404 the opt-out routes for an anonymised saver.';

grant execute on function public.get_member_id_from_token(text) to service_role;
revoke execute on function public.get_member_id_from_token(text) from public;
revoke execute on function public.get_member_id_from_token(text) from authenticated;
