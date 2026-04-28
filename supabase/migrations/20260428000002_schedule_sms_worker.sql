-- Story 6.2 — Migration 0038: pg_cron schedule for /functions/v1/sms-worker.
--
-- Runs the worker every 30 seconds via pg_cron + pg_net. The job body looks
-- up the Supabase project URL + service role key from Vault at execution
-- time, so the migration ships safely on a fresh stack where Vault hasn't
-- been seeded yet — the WHERE EXISTS guards skip the http_post when the
-- secrets are missing (allowing local dev / CI to apply the migration
-- without immediately scheduling real network traffic).
--
-- Operator setup (post-deploy on a real environment):
--   1. select vault.create_secret('<https://<project>.supabase.co>', 'project_url');
--   2. select vault.create_secret('<service-role-jwt>', 'service_role_key');
--   3. The next 30-second tick will start invoking the worker.
--
-- The migration is idempotent — re-applying drops the existing schedule and
-- registers it fresh. Use cron.unschedule to remove without re-running.
--
-- See: _bmad-output/implementation-artifacts/6-2-sms-worker-termii-retry.md AC #12.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'sms-worker-drain') then
    perform cron.unschedule('sms-worker-drain');
  end if;

  perform cron.schedule(
    'sms-worker-drain',
    '*/30 * * * * *',
    $cron_body$
      select
        net.http_post(
          url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1),
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
          ),
          body                 := '{}'::jsonb,
          timeout_milliseconds := 55000
        )
      where exists (
        select 1 from vault.decrypted_secrets where name = 'service_role_key'
      )
        and exists (
          select 1 from vault.decrypted_secrets where name = 'project_url'
        );
    $cron_body$
  );
exception when others then
  raise notice 'sms-worker-drain schedule registration failed: %. Re-run the migration after fixing the pg_cron config.', sqlerrm;
end;
$$;
