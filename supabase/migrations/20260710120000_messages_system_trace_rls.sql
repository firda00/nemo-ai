-- Messages write hardening: protect system_trace audit rows from client tampering.
--
-- system_trace rows are the operator-facing audit trail of how agents collaborated
-- on a reply. They are written ONLY by the agent runtime through service_role
-- (buildReply in supabase/functions/_shared/agent.ts — its callers telegram-webhook,
-- whatsapp-webhook and widget-webhook all use SUPABASE_SERVICE_ROLE_KEY clients).
-- Before this migration, the single messages_acc FOR ALL policy (from
-- 20260624150000_review_fixes.sql) let any authenticated tenant client
-- INSERT/UPDATE/DELETE its own system_trace rows — i.e. forge or erase the audit
-- trail of its own account.
--
-- New model — tenant scope is byte-identical to the old policy:
--   * SELECT: whole tenant scope, all message_type values. The dialogues panel
--     keeps rendering traces and RLS-filtered realtime events keep flowing.
--   * INSERT / UPDATE / DELETE: tenant scope AND message_type = 'chat'. Clients
--     may only write chat rows. This is backward compatible today: the frontend
--     performs no direct messages writes, and the two Edge Functions that write
--     with the CALLER'S JWT (operator-send, test-agent) insert without
--     message_type, so the column default 'chat' satisfies the new policy.
--     UPDATE checks both the old row (USING) and the new row (WITH CHECK), so a
--     trace row cannot be edited AND a chat row cannot be rewritten into a fake
--     trace. internal_monologue rows get the same protection (clients should
--     never write those either). service_role bypasses RLS as before.
--   * Policies are TO authenticated: anon was already fully blocked in practice
--     (current_account_id() is null without a session); now it is explicit.
--
-- Known limitation (documented, intentionally out of scope): this blocks DIRECT
-- trace-row mutation only. A tenant can still lose traces by deleting the parent
-- agent/dialogue (FK ON DELETE CASCADE — cascades are not filtered by the child
-- table's DELETE policy). Immutable retention would need a separate append-only
-- audit table or soft deletes.

drop policy if exists messages_acc on public.messages;
drop policy if exists messages_select_acc on public.messages;
drop policy if exists messages_insert_chat on public.messages;
drop policy if exists messages_update_chat on public.messages;
drop policy if exists messages_delete_chat on public.messages;

create policy messages_select_acc on public.messages for select
  to authenticated
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

create policy messages_insert_chat on public.messages for insert
  to authenticated
  with check (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

create policy messages_update_chat on public.messages for update
  to authenticated
  using (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  )
  with check (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

create policy messages_delete_chat on public.messages for delete
  to authenticated
  using (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );
