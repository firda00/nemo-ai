alter table public.accounts
  add column if not exists is_production_e2e boolean not null default false;

create unique index if not exists accounts_single_production_e2e_idx
  on public.accounts ((1))
  where is_production_e2e;

revoke update(is_production_e2e) on public.accounts from anon, authenticated;

create or replace function public.guard_production_e2e_external_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb := to_jsonb(new);
  target_account uuid;
begin
  if tg_table_name = 'channels' then
    select account_id into target_account from public.agents where id = (row_data->>'agent_id')::uuid;
  else
    target_account := nullif(row_data->>'account_id', '')::uuid;
  end if;

  if target_account is null or not exists(
    select 1 from public.accounts where id = target_account and is_production_e2e
  ) then
    return new;
  end if;

  if tg_table_name = 'channels' then
    if coalesce(row_data->'credentials', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(row_data->>'secret_token', '') <> '' then
      raise exception using errcode = '42501', message = 'external credentials are disabled for the production test account';
    end if;
    return new;
  end if;

  if tg_table_name = 'business_profiles' then
    if coalesce(row_data->>'phone', '') <> ''
      or coalesce(row_data->>'notify_chat_id', '') <> ''
      or coalesce(row_data->>'tasks_sheet_id', '') <> ''
      or coalesce(row_data->>'planerka_members_sheet_id', '') <> '' then
      raise exception using errcode = '42501', message = 'external destinations are disabled for the production test account';
    end if;
    return new;
  end if;

  if tg_table_name = 'user_consents' then
    if row_data->>'document' in ('marketing_email', 'marketing_telegram') and (row_data->>'granted')::boolean then
      raise exception using errcode = '42501', message = 'marketing is disabled for the production test account';
    end if;
    return new;
  end if;

  raise exception using errcode = '42501', message = 'external configuration is disabled for the production test account';
end;
$$;

revoke all on function public.guard_production_e2e_external_config() from public, anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'provider_keys', 'google_accounts', 'google_oauth_apps', 'social_accounts',
    'custom_tools', 'scheduled_posts', 'follow_ups', 'watched_sources',
    'channels', 'business_profiles', 'user_consents'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('drop trigger if exists production_e2e_external_config_guard on public.%I', table_name);
      execute format('create trigger production_e2e_external_config_guard before insert or update on public.%I for each row execute function public.guard_production_e2e_external_config()', table_name);
    end if;
  end loop;
end;
$$;
