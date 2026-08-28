-- Daily Telegram morning brief at 08:00 Asia/Tashkent (03:00 UTC).
--
-- Deployment must provision two Vault entries before the first scheduled run:
--   nemo_functions_url = https://<project-ref>.supabase.co/functions/v1
--   nemo_cron_secret   = the same value as the Edge Function CRON_SECRET
-- The dispatcher fails closed when either value is absent and never stores a secret in cron.job.

create extension if not exists pg_net with schema extensions;

create or replace function runtime.invoke_morning_brief_cron()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_functions_url text;
  v_cron_secret text;
  v_request_id bigint;
begin
  select decrypted_secret
    into v_functions_url
    from vault.decrypted_secrets
   where name = 'nemo_functions_url'
   order by created_at desc
   limit 1;

  select decrypted_secret
    into v_cron_secret
    from vault.decrypted_secrets
   where name = 'nemo_cron_secret'
   order by created_at desc
   limit 1;

  if nullif(btrim(v_functions_url), '') is null
     or nullif(btrim(v_cron_secret), '') is null then
    raise exception using
      errcode = '22023',
      message = 'MORNING_BRIEF_CRON_NOT_CONFIGURED';
  end if;

  select net.http_post(
    url := rtrim(v_functions_url, '/') || '/morning-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_cron_secret
    ),
    body := jsonb_build_object(
      'source', 'pg_cron',
      'scheduled_for', clock_timestamp()
    ),
    timeout_milliseconds := 30000
  ) into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function runtime.invoke_morning_brief_cron() from public, anon, authenticated;
grant execute on function runtime.invoke_morning_brief_cron() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
      from cron.job
     where jobname = 'nemo-morning-brief-asia-tashkent';
    perform cron.schedule(
      'nemo-morning-brief-asia-tashkent',
      '0 3 * * *',
      'select runtime.invoke_morning_brief_cron();'
    );
  end if;
end;
$$;
