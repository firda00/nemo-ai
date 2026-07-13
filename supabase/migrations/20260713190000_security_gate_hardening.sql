-- Security gate: bound knowledge payloads and serialize agent creation bursts.

alter table public.knowledge_docs
  drop constraint if exists knowledge_docs_content_size_check;
alter table public.knowledge_docs
  add constraint knowledge_docs_content_size_check
  check (content is null or char_length(content) <= 200000) not valid;
alter table public.knowledge_docs validate constraint knowledge_docs_content_size_check;

alter table public.knowledge_docs
  drop constraint if exists knowledge_docs_name_size_check;
alter table public.knowledge_docs
  add constraint knowledge_docs_name_size_check
  check (name is null or char_length(name) <= 255) not valid;
alter table public.knowledge_docs validate constraint knowledge_docs_name_size_check;

create or replace function public.guard_agent_creation_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare recent_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.account_id::text, 913));
  select count(*) into recent_count
  from public.agents
  where account_id = new.account_id
    and created_at >= now() - interval '1 minute';
  if recent_count >= 30 then
    raise exception 'agent creation rate limit exceeded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists agents_creation_rate_guard on public.agents;
create trigger agents_creation_rate_guard
  before insert on public.agents
  for each row execute function public.guard_agent_creation_rate();

revoke execute on function public.guard_agent_creation_rate() from public, anon, authenticated;
