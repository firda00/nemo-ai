-- Provider credentials may only enter the database through the server-side
-- connection functions. Existing legacy rows remain readable so they can be
-- rotated without an outage; every new or updated row must be ciphertext.

revoke insert, update, delete on public.provider_keys from anon, authenticated;

alter table public.provider_keys
  drop constraint if exists provider_keys_ciphertext_only;

alter table public.provider_keys
  add constraint provider_keys_ciphertext_only
  check (api_key ~ '^enc:v[12]:[^:]+:[^:]+$') not valid;

do $$
begin
  if not exists (
    select 1
    from public.provider_keys
    where api_key !~ '^enc:v[12]:[^:]+:[^:]+$'
  ) then
    alter table public.provider_keys
      validate constraint provider_keys_ciphertext_only;
  end if;
end
$$;
