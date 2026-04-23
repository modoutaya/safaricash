-- Story 2.6 — Migration 0019: SECURITY DEFINER delete_member RPC.
--
-- Atomic hard-delete for FR11. Cascades through 5 tables in dependency
-- order under a per-member advisory lock so concurrent deletes are
-- serialised:
--   1. disputes        (references transactions.id; DELETE first to free FK)
--   2. sms_queue       (references transactions.id with on delete restrict)
--   3. transactions    (references members.id with on delete restrict)
--   4. cycles          (references members.id with on delete restrict)
--   5. members         (the actual target row)
--
-- Each DELETE fires the audit_log trigger (migration 0007 + actor JWT fix
-- from migration 0017), so the cascade is fully traceable on the
-- per-collector audit chain. Audit walker can reconstruct the full
-- deletion narrative from the chain.
--
-- Vault secrets (vault.decrypted_secrets referenced by name_encrypted /
-- phone_number_encrypted on the deleted member, and amount_encrypted on
-- the deleted transactions) are intentionally NOT touched here. Epic 10's
-- saver-delete Edge Function owns saver-PII anonymisation. The audit_log
-- payload still references the secret_ids, which is the architecture's
-- intent (line 459: "hard-delete with anonymisation [where anonymisation
-- lands in Epic 10]").
--
-- Concurrency: per-member advisory lock class_id 0x5AFC, distinct from:
--   0x5AFA — audit chain (migration 0007)
--   0x5AFB — cycle restart (migration 0018)
--   0x5AFC — member delete (this migration)
--
-- See: _bmad-output/implementation-artifacts/2-6-delete-member-confirmation.md
-- AC #6 + Task 0.

set check_function_bodies = off;

create or replace function public.delete_member(
  p_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_collector_id uuid;
  v_member_owner uuid;
begin
  v_collector_id := auth.uid();
  if v_collector_id is null then
    raise exception 'auth_required: caller is not authenticated' using errcode = '28000';
  end if;

  -- Per-member serialisation. class_id 0x5AFC is reserved for delete ops.
  perform pg_advisory_xact_lock(0x5AFC, hashtext(p_id::text));

  -- Ownership check — fail fast with a stable error code if the member
  -- does not exist OR is owned by a different collector.
  select collector_id
    into v_member_owner
    from public.members
   where id = p_id;

  if v_member_owner is null then
    raise exception 'not_found: member % does not exist', p_id
      using errcode = 'P0002';
  end if;

  if v_member_owner <> v_collector_id then
    raise exception 'unauthorized: member % is not owned by caller', p_id
      using errcode = '28000';
  end if;

  -- 1. disputes referencing this member's transactions.
  delete from public.disputes
   where transaction_id in (
     select id from public.transactions where member_id = p_id
   );

  -- 2. sms_queue referencing this member's transactions.
  delete from public.sms_queue
   where transaction_id in (
     select id from public.transactions where member_id = p_id
   );

  -- 3. transactions — fires `transaction.deleted` audit per row.
  delete from public.transactions where member_id = p_id;

  -- 4. cycles — fires `cycle.deleted` audit per row.
  delete from public.cycles where member_id = p_id;

  -- 5. The member itself — fires `member.deleted` audit.
  delete from public.members where id = p_id;
end;
$$;

grant execute on function public.delete_member(uuid) to authenticated;

comment on function public.delete_member(uuid) is
  'Atomic member hard-delete (Story 2.6 / FR11). Cascades disputes → sms_queue → transactions → cycles → members in one transaction under a per-member advisory lock. Vault secrets stay untouched (Epic 10 owns saver-PII anonymisation). Audit member.deleted + cascading transaction.deleted + cycle.deleted events fire via the migration 0007 trigger. Raises 28000 (unauthorized), P0002 (not_found).';
