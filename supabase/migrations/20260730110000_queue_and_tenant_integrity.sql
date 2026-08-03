-- Keep queue internals and server-generated agent state inaccessible to browser roles.
revoke all on function public.q_send(jsonb) from public, anon, authenticated;
revoke all on function public.q_read(int, int) from public, anon, authenticated;
revoke all on function public.q_delete(bigint) from public, anon, authenticated;
revoke all on function public.q_len() from public, anon, authenticated;
grant execute on function public.q_send(jsonb), public.q_read(int, int), public.q_delete(bigint), public.q_len() to service_role;

-- account_id must agree with every referenced agent and dialogue. RLS alone cannot
-- validate this because the referenced UUIDs are supplied by the caller.
create or replace function public.enforce_agent_memory_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.agents
    where id = new.agent_id and account_id = new.account_id
  ) then
    raise exception 'agent does not belong to memory account';
  end if;

  if new.dialogue_id is not null and not exists (
    select 1
    from public.dialogues d
    join public.agents a on a.id = d.agent_id
    where d.id = new.dialogue_id
      and d.agent_id = new.agent_id
      and a.account_id = new.account_id
  ) then
    raise exception 'dialogue does not belong to memory agent/account';
  end if;

  return new;
end
$$;

drop trigger if exists agent_memory_tenant_guard on public.agent_memory;
create trigger agent_memory_tenant_guard
before insert or update on public.agent_memory
for each row execute function public.enforce_agent_memory_tenant();
revoke all on function public.enforce_agent_memory_tenant() from public, anon, authenticated;
revoke insert, update, delete on public.agent_memory from anon, authenticated;

create or replace function public.enforce_agent_evolution_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.agents
    where id = new.agent_id and account_id = new.account_id
  ) then
    raise exception 'agent does not belong to evolution account';
  end if;

  return new;
end
$$;

drop trigger if exists agent_evolutions_tenant_guard on public.agent_evolutions;
create trigger agent_evolutions_tenant_guard
before insert or update on public.agent_evolutions
for each row execute function public.enforce_agent_evolution_tenant();
revoke all on function public.enforce_agent_evolution_tenant() from public, anon, authenticated;
revoke insert, update, delete on public.agent_evolutions from anon, authenticated;
