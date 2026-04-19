-- Story 1.2 — Migration 0002: row-level security per-collector isolation.
--
-- Enforces FR46 + NFR-S5: every read/write on user-owned tables is restricted
-- to rows where collector_id = auth.uid() (or, for users, id = auth.uid()).
-- FORCE ROW LEVEL SECURITY ensures even the table owner respects policies, so
-- a future Edge Function running under the owner role cannot leak data.
--
-- audit_log gets a SELECT policy only — writes happen exclusively via the
-- SECURITY DEFINER trigger from 0007 (NFR-S6 append-only).
--
-- No super_admin bypass policy at MVP. Admin access is via Supabase Studio +
-- service_role (architecture.md § Admin Provisioning Tool).
--
-- See: architecture.md § Authentication & Security.

-- ---------------------------------------------------------------------------
-- Enable + force RLS on every user-owned table.
-- ---------------------------------------------------------------------------

alter table public.users        enable row level security;
alter table public.users        force row level security;

alter table public.members      enable row level security;
alter table public.members      force row level security;

alter table public.cycles       enable row level security;
alter table public.cycles       force row level security;

alter table public.transactions enable row level security;
alter table public.transactions force row level security;

alter table public.sms_queue    enable row level security;
alter table public.sms_queue    force row level security;

alter table public.disputes     enable row level security;
alter table public.disputes     force row level security;

alter table public.audit_log    enable row level security;
alter table public.audit_log    force row level security;

-- ---------------------------------------------------------------------------
-- users — a collector sees and updates only their own row.
-- ---------------------------------------------------------------------------

create policy users_self_all
  on public.users
  as permissive
  for all
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- members / cycles / transactions / sms_queue / disputes
-- — collector_id = auth.uid() per-row isolation.
-- ---------------------------------------------------------------------------

create policy members_collector_isolation
  on public.members
  as permissive
  for all
  to authenticated
  using (collector_id = auth.uid())
  with check (collector_id = auth.uid());

create policy cycles_collector_isolation
  on public.cycles
  as permissive
  for all
  to authenticated
  using (collector_id = auth.uid())
  with check (collector_id = auth.uid());

create policy transactions_collector_isolation
  on public.transactions
  as permissive
  for all
  to authenticated
  using (collector_id = auth.uid())
  with check (collector_id = auth.uid());

create policy sms_queue_collector_isolation
  on public.sms_queue
  as permissive
  for all
  to authenticated
  using (collector_id = auth.uid())
  with check (collector_id = auth.uid());

create policy disputes_collector_isolation
  on public.disputes
  as permissive
  for all
  to authenticated
  using (collector_id = auth.uid())
  with check (collector_id = auth.uid());

-- ---------------------------------------------------------------------------
-- audit_log — read-only for the owning collector.
-- Writes are intentionally NOT allowed via policy: only the SECURITY DEFINER
-- trigger in 0007 inserts rows. NFR-S6 requires append-only / mutation-resistant.
-- 0003 additionally REVOKEs INSERT/UPDATE/DELETE from authenticated/anon.
-- ---------------------------------------------------------------------------

create policy audit_log_collector_select
  on public.audit_log
  as permissive
  for select
  to authenticated
  using (collector_id = auth.uid());
