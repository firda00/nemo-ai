-- Team-shared RAG (release 2026-07). A department becomes a first-class
-- knowledge owner: knowledge_docs.owner_type gains a working 'team' branch
-- (owner_id = department id) with tenant-scoped RLS, and retrieval gets an
-- account-aware RPC that reads the agent's own docs plus its department's
-- shared docs. The RPC verifies every owner id against p_account_id
-- (fail-closed) and joins through knowledge_docs, so a stale owner column on
-- knowledge_chunks can never leak another owner's content.

-- 1) two-branch document policy: browser CRUD stays tenant-scoped per branch.
--    (The previous policy only recognized agent owners, which made any other
--    owner_type unreachable.)
drop policy if exists knowledge_acc on public.knowledge_docs;
create policy knowledge_acc on public.knowledge_docs for all
  using (
    (owner_type = 'agent' and owner_id in (select id from public.agents where account_id = public.current_account_id()))
    or (owner_type = 'team' and owner_id in (select id from public.departments where account_id = public.current_account_id()))
  )
  with check (
    (owner_type = 'agent' and owner_id in (select id from public.agents where account_id = public.current_account_id()))
    or (owner_type = 'team' and owner_id in (select id from public.departments where account_id = public.current_account_id()))
  );

-- owner_type is now load-bearing: constrain new rows to the known kinds without
-- failing the migration on unaudited legacy values (NOT VALID skips old rows).
alter table public.knowledge_docs drop constraint if exists knowledge_docs_owner_type_check;
alter table public.knowledge_docs add constraint knowledge_docs_owner_type_check
  check (owner_type in ('agent', 'team', 'account')) not valid;

-- 2) chunks inherit the truth from their parent doc (corrects stale copies).
update public.knowledge_chunks c
   set owner_type = d.owner_type, owner_id = d.owner_id
  from public.knowledge_docs d
 where c.doc_id = d.id
   and (c.owner_type is distinct from d.owner_type or c.owner_id is distinct from d.owner_id);

-- 3) tenant integrity for the team graph: a department may only lead agents of
--    its own account, and a sub-agent's department must belong to the
--    sub-agent's account. RLS alone checks account_id columns but not these
--    relationships, and service-role runtime queries traverse them.
--    Pre-existing cross-tenant rows are remediated first (the triggers below
--    only protect future writes): a mismatched lead link is severed and
--    cross-tenant sub-agents are removed — such rows are corrupt by definition
--    and must not stay reachable from either tenant.
update public.departments d
   set main_agent_id = null
 where d.main_agent_id is not null
   and exists (select 1 from public.agents a where a.id = d.main_agent_id and a.account_id <> d.account_id);

delete from public.sub_agents s
 where exists (select 1 from public.departments d where d.id = s.department_id and d.account_id <> s.account_id);

create or replace function public.enforce_department_tenant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acc uuid;
begin
  if new.main_agent_id is null then
    return new;
  end if;
  select account_id into v_acc from public.agents where id = new.main_agent_id;
  if v_acc is null or v_acc <> new.account_id then
    raise exception 'department lead must belong to the department''s account' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_sub_agent_tenant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acc uuid;
begin
  select account_id into v_acc from public.departments where id = new.department_id;
  if v_acc is null or v_acc <> new.account_id then
    raise exception 'sub-agent department must belong to the sub-agent''s account' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists departments_tenant_guard on public.departments;
create trigger departments_tenant_guard
  before insert or update of main_agent_id, account_id on public.departments
  for each row execute function public.enforce_department_tenant();

drop trigger if exists sub_agents_tenant_guard on public.sub_agents;
create trigger sub_agents_tenant_guard
  before insert or update of department_id, account_id on public.sub_agents
  for each row execute function public.enforce_sub_agent_tenant();

-- 4) account-aware team retrieval. Both owner branches are independently
--    verified against p_account_id; unverified ids contribute nothing (fail
--    closed). The join on knowledge_docs makes the DOCUMENT's current owner the
--    source of truth, not the chunk's copied columns. match_knowledge (single
--    owner) is kept unchanged for rollout compatibility and rollback.
create or replace function public.match_knowledge_team(
  p_account_id uuid,
  p_agent_id uuid,
  p_department_id uuid,
  p_query vector(384),
  p_k int default 6
)
returns table(content text, similarity double precision)
language sql stable security definer set search_path = public as $$
  select c.content, 1 - (c.embedding <=> p_query) as similarity
  from public.knowledge_chunks c
  join public.knowledge_docs d on d.id = c.doc_id
  where c.embedding is not null
    and (
      (p_agent_id is not null and d.owner_type = 'agent' and d.owner_id = p_agent_id
        and exists (select 1 from public.agents a where a.id = p_agent_id and a.account_id = p_account_id))
      or
      (p_department_id is not null and d.owner_type = 'team' and d.owner_id = p_department_id
        and exists (select 1 from public.departments t where t.id = p_department_id and t.account_id = p_account_id))
    )
  order by c.embedding <=> p_query
  limit greatest(1, least(p_k, 20))
$$;

revoke all on function public.match_knowledge_team(uuid, uuid, uuid, vector, int) from public, anon, authenticated;
grant execute on function public.match_knowledge_team(uuid, uuid, uuid, vector, int) to service_role;
