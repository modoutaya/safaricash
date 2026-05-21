-- Story 12.5 PR A — settle formula refactor (MINIMAL SCOPE).
--
-- Business model correction (pilot feedback 2026-05-21):
-- `daily_amount` is a UX suggestion / saver-set objective, NOT a daily
-- contractual obligation. Savers cotise freely. The collector returns
-- what was actually versed minus a fixed commission of `daily_amount`
-- minus mid-cycle advances minus any opening_balance debt carried over.
--
--   NEW payout = contributedTotal − dailyAmount − Σadvances − opening_balance
--
-- where contributedTotal = Σ kind ∈ {contribution, rattrapage} amounts
-- booked in the cycle (undone excluded).
--
-- PRE-12.5 formula (replaced):
--   OLD payout = dailyAmount × (cycleLength − 1) − Σadvances − opening_balance
-- assumed the saver paid daily × contribDays every cycle which the
-- founder confirmed was never the actual model in the field.
--
-- SCOPE REDUCED (after 2 CI failures): this migration touches ONLY
-- `commit_cycle_settlement`. The follow-up PR C of the 12.5 refactor
-- will update `format_sms_body` and `get_receipt_payload` together with
-- the UI label change (projected → current). Until then, the SMS
-- receipt's "Solde projete" line and the worker receipt page's
-- projected_balance column STILL show the OLD projection — wrong but
-- internally consistent. The settle commit itself uses the correct
-- formula so the actual payout is right.
--
-- Latest pre-12.5 version of these functions: migration 20260521084835.

set check_function_bodies = off;

create or replace function public.commit_cycle_settlement(
  p_member_id        uuid,
  p_cycle_id         uuid,
  p_expected_payout  bigint
)
returns table (
  settlement_transaction_id  uuid,
  settled_payout             bigint,
  settled_at                 timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Story 12.5 — declarations mirror Phase A's commit_cycle_settlement
  -- byte-for-byte except for v_contributed_total (new). The previous
  -- draft of this migration substituted `record` for `%rowtype` and
  -- `text` for `uuid`, both of which produced runtime failures.
  v_collector_id        uuid;
  v_cycle               public.cycles%rowtype;
  v_member              public.members%rowtype;
  v_cycle_length        integer;
  v_advances_sum        bigint;
  v_contributed_total   bigint;
  v_opening_balance     bigint;
  v_computed_payout     bigint;
  v_amount_secret       uuid;
  v_tx_id               uuid;
  v_settled_at          timestamptz;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    -- errcode 28000 matches Phase A (contract test #9 pins this code).
    raise exception 'cycle_settlement: auth required' using errcode = '28000';
  end if;

  -- FOR UPDATE locks the cycle row for the txn — prevents a concurrent
  -- settle from racing. Phase A had this; my earlier draft dropped it.
  select * into v_cycle from public.cycles where id = p_cycle_id for update;
  if not found then
    raise exception 'cycle_settlement: cycle not found or not owned' using errcode = 'P0002';
  end if;
  if v_cycle.collector_id <> v_collector_id then
    raise exception 'cycle_settlement: cycle not found or not owned' using errcode = 'P0002';
  end if;
  if v_cycle.member_id <> p_member_id then
    raise exception 'cycle_settlement: cycle/member mismatch' using errcode = 'P0002';
  end if;
  if v_cycle.status <> 'completed' then
    raise exception 'cycle_settlement: cycle not in completed status (got %s)', v_cycle.status
      using errcode = 'P0002',
            detail = format('cycle_id=%s status=%s', p_cycle_id, v_cycle.status);
  end if;

  select * into v_member from public.members where id = p_member_id;
  if not found then
    raise exception 'cycle_settlement: cycle/member mismatch' using errcode = 'P0002';
  end if;

  v_cycle_length := (v_cycle.end_date - v_cycle.start_date) + 1;

  -- Story 12.5 — sum actual contributions + rattrapage of THIS cycle.
  -- The collector physically holds this much money for this saver.
  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_contributed_total
    from public.transactions t
   where t.cycle_id = p_cycle_id
     and t.kind in ('contribution', 'rattrapage')
     and t.undone_at is null;

  select coalesce(sum(public.vault_decrypt(t.amount_encrypted)::numeric(12, 0)), 0)::bigint
    into v_advances_sum
    from public.transactions t
   where t.cycle_id = p_cycle_id and t.kind = 'advance' and t.undone_at is null;

  v_opening_balance := public.compute_opening_balance(p_member_id, p_cycle_id);

  -- Story 12.5 — new formula. Mirrors TS settle() exactly.
  v_computed_payout := v_contributed_total
                       - v_member.daily_amount::bigint
                       - v_advances_sum
                       - v_opening_balance;

  -- NFR-R3 zero-tolerance cross-check.
  if v_computed_payout <> p_expected_payout then
    raise exception 'cycle_settlement: payout mismatch (client=%s, server=%s)',
                    p_expected_payout, v_computed_payout
      using errcode = 'P0002',
            detail = format(
              'client_payout=%s server_payout=%s contributed_total=%s commission=%s advances=%s opening_balance=%s',
              p_expected_payout, v_computed_payout, v_contributed_total,
              v_member.daily_amount, v_advances_sum, v_opening_balance
            );
  end if;

  v_amount_secret := public.vault_encrypt(v_computed_payout::text);

  insert into public.transactions (
    collector_id, member_id, cycle_id, kind, amount_encrypted, cycle_day, source
  ) values (
    v_collector_id, p_member_id, p_cycle_id, 'settlement',
    v_amount_secret, v_cycle_length, 'online'
  )
  returning id into v_tx_id;

  v_settled_at := now();
  update public.cycles
     set status = 'settled', settled_at = v_settled_at, updated_at = v_settled_at
   where id = p_cycle_id;

  return query select v_tx_id, v_computed_payout, v_settled_at;
end;
$$;

grant execute on function public.commit_cycle_settlement(uuid, uuid, bigint) to authenticated;

comment on function public.commit_cycle_settlement(uuid, uuid, bigint) is
  'Story 12.5 (PR A): atomic settlement commit with NEW formula — payout = contributedTotal − dailyAmount − Σadvances − opening_balance. The pre-12.5 formula assumed daily × contribDays which doesn''t match the cotisation-libre model. Client TS settle() must mirror this exactly or the NFR-R3 cross-check fires. NB: format_sms_body and get_receipt_payload still use the OLD projected formula for the receipt SMS / receipt URL page — PR C of 12.5 aligns those.';
