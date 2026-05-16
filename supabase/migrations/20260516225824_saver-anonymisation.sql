-- Story 10.4 — saver anonymisation (right-to-deletion, FR48 / AR13).
--
-- The right-to-deletion is implemented as ANONYMISATION, not hard-delete:
-- the members row is RETAINED so every transaction referencing the saver
-- keeps its member_id FK and its place in the append-only audit hash chain,
-- but the PII (name, phone) is irreversibly destroyed.
--
-- This migration ships:
--   1. members.anonymised_at — the anonymisation marker (NULL = not
--      anonymised; NOT NULL = irreversibly anonymised). It is the
--      audit_emit() trigger signal AND the anonymise_member() idempotency
--      guard. Story 10.5 reads it to gate its opt-out surface.
--   2. The members.sms_opt_out_via CHECK extended with 'anonymisation' —
--      accurate provenance, distinct from a saver/collector opt-out.
--   3. audit_emit() — a (members, UPDATE) member.anonymised branch. The body
--      is reproduced from the CURRENT definition (20260516213715, Story
--      10.3) preserving EVERY branch (2.5 actor-JWT fallback, 3.3
--      cycle.transitioned, 4.5 transaction.undone, 10.1 dispute.flagged,
--      10.3 dispute.resolved). ONLY the member.anonymised CASE line is new.
--      The audit_log.event_type CHECK (migration 0003) is the regex
--      `^[a-z][a-z_]*\.[a-z][a-z_]*$` — 'member.anonymised' already passes,
--      no constraint change. The audit_members trigger already fires AFTER
--      INSERT OR UPDATE OR DELETE — no trigger change.
--   4. members_decrypted — exposes anonymised_at (explicit projection: a new
--      column on members is NOT auto-exposed).
--   5. anonymise_member(p_member_id) — the SECURITY DEFINER RPC. Overwrites
--      the member's two Vault secrets IN PLACE via vault.update_secret with
--      salted hashes derived from collector_id||member_id (NOT the plaintext
--      PII — a hash of the low-entropy phone with the non-secret collector_id
--      salt would be brute-forceable; hashing server-side identifiers is
--      irreversible by construction). Clears phone_number_hash, sets
--      sms_opt_out, stamps anonymised_at, abandons queued SMS. One members
--      UPDATE drives the member.anonymised audit event.
--
-- See: _bmad-output/implementation-artifacts/10-4-saver-anonymisation-edge-function.md

set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. The anonymisation marker.
-- ---------------------------------------------------------------------------

alter table public.members
  add column anonymised_at timestamptz null;

comment on column public.members.anonymised_at is
  'Story 10.4 / FR48 — stamped by anonymise_member() when the saver PII is irreversibly anonymised. NULL = not anonymised. The audit_emit() member.anonymised trigger signal + the idempotency guard.';

-- ---------------------------------------------------------------------------
-- 2. sms_opt_out_via gains 'anonymisation'.
-- ---------------------------------------------------------------------------

alter table public.members
  drop constraint members_sms_opt_out_via_check;

alter table public.members
  add constraint members_sms_opt_out_via_check
  check (sms_opt_out_via is null
         or sms_opt_out_via in ('stop_keyword', 'receipt_url', 'collector_action', 'anonymisation'));

-- ---------------------------------------------------------------------------
-- 3. audit_emit() — + the (members, UPDATE) member.anonymised branch.
--    Reproduced from 20260516213715 (Story 10.3); ONLY the member.anonymised
--    CASE line is added (placed before the generic members/UPDATE line).
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
    -- Story 10.4 — saver anonymisation: anonymised_at NULL -> NOT NULL.
    when v_entity_table = 'members'      and v_op = 'UPDATE'
         and (v_payload->>'anonymised_at') is not null
         and (to_jsonb(old)->>'anonymised_at') is null   then 'member.anonymised'
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
  'AFTER INSERT/UPDATE/DELETE trigger function. Story 10.4: (members, UPDATE) -> member.anonymised (anonymised_at NULL->NOT NULL). Story 10.3 dispute.resolved + 10.1 dispute.flagged + 4.5 transaction.undone + 3.3 cycle.transitioned + 2.5 actor-JWT fallback PRESERVED. Hash chain unchanged.';

revoke execute on function public.audit_emit() from public;

-- ---------------------------------------------------------------------------
-- 4. members_decrypted — expose anonymised_at.
--    Re-derived from 20260513000003 + m.anonymised_at.
-- ---------------------------------------------------------------------------

create or replace view public.members_decrypted
with (security_invoker = true)
as
select
  m.id,
  m.collector_id,
  public.vault_decrypt(m.name_encrypted)         as name,
  public.vault_decrypt(m.phone_number_encrypted) as phone_number,
  m.daily_amount,
  m.status,
  m.created_at,
  m.updated_at,
  m.sms_opt_out,
  m.anonymised_at
from public.members m;

comment on view public.members_decrypted is
  'Decrypted projection of members. security_invoker = true → caller RLS on members applies (per-collector isolation). Story 10.4: exposes anonymised_at so callers (e.g. Story 10.5) can detect an anonymised saver.';

grant select on public.members_decrypted to authenticated;

-- ---------------------------------------------------------------------------
-- 5. anonymise_member(p_member_id) — the right-to-deletion RPC.
--    SECURITY DEFINER, service_role only. Idempotent + not-found-safe.
-- ---------------------------------------------------------------------------

create or replace function public.anonymise_member(p_member_id uuid)
returns table(status text, member_id uuid)
language plpgsql
security definer
set search_path = public, extensions, vault, pg_temp
as $$
declare
  v_collector_id   uuid;
  v_name_secret    uuid;
  v_phone_secret   uuid;
  v_anonymised_at  timestamptz;
  v_name_hash      text;
  v_phone_hash     text;
begin
  -- `for update` locks the member row: a concurrent second anonymise_member
  -- call blocks here until the first commits, then reads anonymised_at as
  -- NOT NULL and correctly returns 'already_anonymised' (no double Vault
  -- write, no misleading 'anonymised' status from the race loser).
  select collector_id, name_encrypted, phone_number_encrypted, anonymised_at
    into v_collector_id, v_name_secret, v_phone_secret, v_anonymised_at
    from public.members
   where id = p_member_id
   for update;

  -- Unknown member — return a status, do NOT raise (the Edge Function maps
  -- this to a 404-style response, not a 500).
  if v_collector_id is null then
    return query select 'not_found'::text, p_member_id;
    return;
  end if;

  -- Idempotent: already anonymised → no-op, no second Vault write / audit event.
  if v_anonymised_at is not null then
    return query select 'already_anonymised'::text, p_member_id;
    return;
  end if;

  -- The replacement hashes are derived from SERVER-SIDE identifiers only
  -- (collector_id + member_id) — never the plaintext name/phone. So there is
  -- nothing to brute-force: the anonymisation is irreversible by construction.
  v_name_hash :=
    'SAVER_' || substr(
      encode(extensions.digest('name:' || v_collector_id::text || ':' || p_member_id::text, 'sha256'), 'hex'),
      1, 12);
  v_phone_hash :=
    encode(extensions.digest('phone:' || v_collector_id::text || ':' || p_member_id::text, 'sha256'), 'hex');

  -- Overwrite the two Vault secrets IN PLACE — re-encrypts the secret content,
  -- destroying the prior plaintext. The members.*_encrypted uuid pointers are
  -- unchanged; only the secret content behind them changes.
  perform vault.update_secret(v_name_secret, v_name_hash);
  perform vault.update_secret(v_phone_secret, v_phone_hash);

  -- ONE members UPDATE → the audit_members trigger fires once → audit_emit()
  -- detects anonymised_at NULL->NOT NULL → a single member.anonymised event.
  -- members.status is intentionally left unchanged (anonymised_at is the
  -- sole marker; flipping status would drop the member from dashboard/cycle
  -- queries — out of scope).
  update public.members
     set phone_number_hash = null,
         sms_opt_out       = true,
         sms_opt_out_at    = now(),
         sms_opt_out_via   = 'anonymisation',
         anonymised_at     = now(),
         updated_at        = now()
   where id = p_member_id
     and anonymised_at is null;

  -- Cancel any queued sms_queue rows for this member's transactions — the
  -- enqueue path short-circuits on members.sms_opt_out for future SMS, but
  -- rows queued before the flip should not be dispatched. (The
  -- set_member_sms_opt_out cancellation pattern.)
  update public.sms_queue sq
     set status       = 'abandoned',
         abandoned_at = now()
    from public.transactions t
   where t.id = sq.transaction_id
     and t.member_id = p_member_id
     and sq.status = 'queued';

  return query select 'anonymised'::text, p_member_id;
end;
$$;

comment on function public.anonymise_member(uuid) is
  'Story 10.4 / FR48 — irreversibly anonymises a saver: overwrites the name/phone Vault secrets in place with salted hashes (derived from collector_id||member_id, not the plaintext PII), clears phone_number_hash, sets sms_opt_out, stamps anonymised_at, abandons queued SMS. One members UPDATE chains a member.anonymised audit event. Idempotent (already_anonymised) + not-found-safe. service_role only.';

grant execute on function public.anonymise_member(uuid) to service_role;
revoke execute on function public.anonymise_member(uuid) from public;
revoke execute on function public.anonymise_member(uuid) from authenticated;
