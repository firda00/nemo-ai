-- Trace retention guard: close the cascade-delete hole left by
-- 20260710120000_messages_system_trace_rls.sql.
--
-- That migration made system_trace audit rows read-only for client roles, but
-- documented one remaining path: FK ON DELETE CASCADE. Deleting a parent agent
-- (agents -> dialogues -> messages) or dialogue (dialogues -> messages) erased
-- the tenant's own audit trail even though direct trace writes/deletes were
-- blocked, because cascaded deletes are not filtered by the child table's
-- DELETE policy.
--
-- Fix: BEFORE DELETE row triggers on both parent tables. A SECURITY DEFINER
-- function (owner = table owner, so RLS on public.messages cannot hide rows
-- from the check) refuses the delete for client roles when the entity still
-- has system_trace rows underneath it. Entities with no traces stay deletable
-- by tenants exactly as before.
--
-- Caller gate (fail closed):
--   * request.jwt.claims role = 'service_role'  -> allowed (runtime/admin
--     Edge Functions; they can archive + clean up).
--   * no JWT claims AND session_user is a direct trusted DB session
--     (postgres / supabase_admin: migrations, dashboard SQL, pg_cron)
--     -> allowed.
--   * everything else — authenticated, anon, or any unknown/missing role
--     arriving through the API authenticator — is guarded. "Guarded" only
--     means the trace check applies; deletes of trace-free entities still
--     succeed, so an unexpected context degrades safely, not destructively.
--
-- Because row triggers also fire on rows deleted BY a cascade, deeper paths
-- (e.g. deleting an account cascades into agents) are covered by the same
-- guard under the same request GUCs.

-- FK join path used by the agents-side check (and generally missing for the
-- dialogues.agent_id FK).
create index if not exists dialogues_agent_id_idx on public.dialogues (agent_id);

create or replace function public.guard_trace_parent_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  has_trace boolean;
begin
  if requester = 'service_role' then
    return old;
  end if;
  if requester is null and session_user in ('postgres', 'supabase_admin') then
    return old;
  end if;

  if tg_table_name = 'agents' then
    select exists (
      select 1
      from public.messages m
      join public.dialogues d on d.id = m.dialogue_id
      where d.agent_id = old.id
        and m.message_type = 'system_trace'
    ) into has_trace;
  elsif tg_table_name = 'dialogues' then
    select exists (
      select 1
      from public.messages m
      where m.dialogue_id = old.id
        and m.message_type = 'system_trace'
    ) into has_trace;
  else
    raise exception 'guard_trace_parent_delete is attached to unexpected table %.%', tg_table_schema, tg_table_name
      using errcode = '42809'; -- wrong_object_type: refuse rather than guess
  end if;

  if has_trace then
    raise exception 'cannot delete % %: it still has system_trace audit rows', tg_table_name, old.id
      using errcode = '42501', -- insufficient_privilege -> PostgREST 403
            hint = 'system_trace rows are the retained audit trail of agent collaboration; an administrator (service role) must archive or remove them first.';
  end if;

  return old;
end;
$$;

drop trigger if exists agents_guard_trace_delete on public.agents;
create trigger agents_guard_trace_delete
  before delete on public.agents
  for each row
  execute function public.guard_trace_parent_delete();

drop trigger if exists dialogues_guard_trace_delete on public.dialogues;
create trigger dialogues_guard_trace_delete
  before delete on public.dialogues
  for each row
  execute function public.guard_trace_parent_delete();
