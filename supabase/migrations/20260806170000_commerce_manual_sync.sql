-- Manual "sync now" needs a memory, or a seller waiting for a shop to appear will hold the
-- button down and hammer Uzum on their own key — the account that gets rate-limited is theirs,
-- not ours. One timestamp per account is enough; the pilot row already exists per account.
alter table public.commerce_pilots
  add column if not exists last_manual_sync_at timestamptz;

-- Claims the manual sync slot atomically. Two tabs pressing the button at the same instant
-- must not both pass the check: the UPDATE's own WHERE clause is the lock.
create or replace function public.claim_commerce_manual_sync(p_account uuid, p_cooldown_seconds integer default 600)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pilot public.commerce_pilots;
  v_claimed boolean := false;
begin
  select * into v_pilot from public.commerce_pilots where account_id = p_account;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_pilot');
  end if;
  if v_pilot.status <> 'active' or v_pilot.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'pilot_inactive');
  end if;

  update public.commerce_pilots
  set last_manual_sync_at = now()
  where account_id = p_account
    and (last_manual_sync_at is null or last_manual_sync_at <= now() - make_interval(secs => p_cooldown_seconds));
  get diagnostics v_claimed = row_count;

  if not v_claimed then
    return jsonb_build_object(
      'ok', false,
      'reason', 'cooldown',
      'retry_after_seconds',
      ceil(extract(epoch from (v_pilot.last_manual_sync_at + make_interval(secs => p_cooldown_seconds) - now())))
    );
  end if;

  -- Give this account's failed runs another chance. Scoped to the caller's catalogues: a manual
  -- retry must never reset another tenant's runs.
  update public.commerce_sync_runs r
  set status = 'queued', claim_token = null, claimed_at = null, completed_at = null, error = null
  from public.commerce_catalogs c
  where c.id = r.catalog_id
    and c.account_id = p_account
    and r.status = 'failed'
    and r.scheduled_for > now() - interval '24 hours';

  return jsonb_build_object('ok', true, 'requeued', (
    select count(*) from public.commerce_sync_runs r2
    join public.commerce_catalogs c2 on c2.id = r2.catalog_id
    where c2.account_id = p_account and r2.status = 'queued'
  ));
end
$$;

revoke all on function public.claim_commerce_manual_sync(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_commerce_manual_sync(uuid, integer) to service_role;
