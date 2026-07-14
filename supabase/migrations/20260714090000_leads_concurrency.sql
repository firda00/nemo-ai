-- Leads concurrency hardening (security gate #29 "Concurrent CRM subagents").
-- Concurrent agent turns on one dialogue previously did read-merge-write on
-- leads.fields (last write silently dropped the other turn's captured fields),
-- could insert duplicate lead rows for one dialogue, and could push the same
-- lead to the external CRM twice. This migration moves the merge, the
-- get-or-create and the CRM-push claim into atomic, serialized SQL.
--
-- Design notes:
-- * Same-dialogue serialization uses pg_advisory_xact_lock instead of a unique
--   index on dialogue_id because production may already hold duplicate rows
--   and follow_ups.lead_id references them (deleting/merging legacy rows is a
--   separate, riskier cleanup). The canonical row is the newest by
--   (created_at desc, id desc); fields hidden in older legacy duplicates stay
--   hidden, which matches the previous reader behavior.
-- * CRM-push claim state lives in typed columns, not in the exported
--   leads.fields JSONB. The claim self-expires after 10 minutes so a crashed
--   function cannot wedge a lead forever; CRM HTTP calls time out well below
--   the lease. Guarantee: single concurrent claimant, at-least-once delivery.
--   An ambiguous provider failure (timeout / network) must NOT release the
--   claim — the runtime lets the lease expire instead, because the remote CRM
--   may have accepted the lead after our timeout fired.
-- * Functions are SECURITY INVOKER and executable by service_role only:
--   every buildReply caller (telegram/whatsapp/instagram/widget processors)
--   already uses a service-role client, and browser roles must not reach a
--   cross-tenant write path. p_account_id is still verified against the
--   dialogue -> agent -> account chain to prevent confused-deputy bugs.

alter table public.leads add column if not exists crm_push_claimed_at timestamptz;
alter table public.leads add column if not exists crm_push_claim uuid;

-- Legacy rows recorded a completed push only inside fields.crm_pushed; promote
-- it to the typed pushed_to_crm column the new claim predicate relies on.
-- Only actual provider markers count — the key was reachable by user-controlled
-- lead-form labels, so any other value is junk and is scrubbed, not honored.
update public.leads set pushed_to_crm = true
  where pushed_to_crm = false and fields->>'crm_pushed' in ('bitrix24', 'amocrm', 'hubspot');
update public.leads set fields = fields - 'crm_pushed'
  where pushed_to_crm = false and fields ? 'crm_pushed';

-- Browser roles only ever READ leads (inbox list + CSV export); every write
-- must go through the RPCs below, or an authenticated client could bypass the
-- serialization, duplicate rows, or forge claim state. Replace the FOR ALL
-- policy with select-only and revoke DML outright.
drop policy if exists leads_acc on public.leads;
drop policy if exists leads_select_acc on public.leads;
create policy leads_select_acc on public.leads for select to authenticated
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );
revoke insert, update, delete on public.leads from anon, authenticated;

-- Deterministic canonical-row selection (newest lead per dialogue).
create index if not exists leads_dialogue_latest_idx
  on public.leads (dialogue_id, created_at desc, id desc);

-- Atomic get-or-create + JSONB merge for one dialogue's lead. Serialized per
-- dialogue, so two concurrent turns cannot lose each other's keys or insert
-- duplicate rows. The incoming patch wins same-key conflicts in lock/commit
-- order (which may differ from customer-message order); disjoint keys are
-- never lost, matching the previous {...existing, ...clean} semantics.
create or replace function public.merge_lead_fields(p_account_id uuid, p_dialogue_id uuid, p_patch jsonb)
returns table (lead_id uuid, lead_fields jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_fields jsonb;
begin
  if p_account_id is null or p_dialogue_id is null then
    raise exception 'merge_lead_fields: account and dialogue are required' using errcode = '22004';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'merge_lead_fields: patch must be a JSON object' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.dialogues d
    join public.agents a on a.id = d.agent_id
    where d.id = p_dialogue_id and a.account_id = p_account_id
  ) then
    raise exception 'merge_lead_fields: dialogue does not belong to account' using errcode = '42501';
  end if;
  -- serialize concurrent turns of the same dialogue (get-or-create must not race)
  perform pg_advisory_xact_lock(hashtextextended(p_dialogue_id::text, 917));
  select l.id into v_id
  from public.leads l
  where l.dialogue_id = p_dialogue_id
  order by l.created_at desc, l.id desc
  limit 1
  for update;
  if v_id is null then
    insert into public.leads (dialogue_id, fields, status)
    values (p_dialogue_id, p_patch, 'new')
    returning id, fields into v_id, v_fields;
  else
    update public.leads set fields = fields || p_patch where id = v_id
    returning fields into v_fields;
  end if;
  return query select v_id, v_fields;
end;
$$;

-- Single-claimant CRM push. Returns a claim token + the row's CURRENT fields
-- (the push must use fresh data, not the caller's snapshot); returns no row
-- when the lead is already pushed or another turn holds a live claim. The
-- provider-valued fields->>'crm_pushed' guard also covers rows written by
-- pre-migration function code during the deploy window (junk values written
-- through a hostile lead-form label must not block the claim).
create or replace function public.claim_lead_crm_push(p_account_id uuid, p_lead_id uuid)
returns table (claim_token uuid, lead_fields jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_fields jsonb;
begin
  if p_account_id is null or p_lead_id is null then
    raise exception 'claim_lead_crm_push: account and lead are required' using errcode = '22004';
  end if;
  update public.leads l
  set crm_push_claim = v_token,
      crm_push_claimed_at = now()
  where l.id = p_lead_id
    and l.pushed_to_crm = false
    and coalesce(l.fields->>'crm_pushed', '') not in ('bitrix24', 'amocrm', 'hubspot')
    and (l.crm_push_claimed_at is null or l.crm_push_claimed_at < now() - interval '10 minutes')
    and exists (
      select 1
      from public.dialogues d
      join public.agents a on a.id = d.agent_id
      where d.id = l.dialogue_id and a.account_id = p_account_id
    )
  returning l.fields into v_fields;
  if not found then
    return;
  end if;
  return query select v_token, v_fields;
end;
$$;

-- Finish a claimed push. p_provider set = success (records the push and keeps
-- the provider visible in fields.crm_pushed for the UI/CSV); p_provider null =
-- definite failure (releases the claim so the next turn retries immediately
-- instead of waiting out the lease). Only the token holder can finish.
create or replace function public.finish_lead_crm_push(p_account_id uuid, p_lead_id uuid, p_token uuid, p_provider text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_account_id is null or p_lead_id is null or p_token is null then
    raise exception 'finish_lead_crm_push: account, lead and token are required' using errcode = '22004';
  end if;
  if p_provider is null then
    update public.leads l
    set crm_push_claim = null,
        crm_push_claimed_at = null
    where l.id = p_lead_id
      and l.crm_push_claim = p_token
      and exists (
        select 1
        from public.dialogues d
        join public.agents a on a.id = d.agent_id
        where d.id = l.dialogue_id and a.account_id = p_account_id
      );
  else
    update public.leads l
    set pushed_to_crm = true,
        crm_push_claim = null,
        crm_push_claimed_at = null,
        fields = l.fields || jsonb_build_object('crm_pushed', left(p_provider, 40))
    where l.id = p_lead_id
      and l.crm_push_claim = p_token
      and exists (
        select 1
        from public.dialogues d
        join public.agents a on a.id = d.agent_id
        where d.id = l.dialogue_id and a.account_id = p_account_id
      );
  end if;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.merge_lead_fields(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.claim_lead_crm_push(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_lead_crm_push(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merge_lead_fields(uuid, uuid, jsonb) to service_role;
grant execute on function public.claim_lead_crm_push(uuid, uuid) to service_role;
grant execute on function public.finish_lead_crm_push(uuid, uuid, uuid, text) to service_role;
