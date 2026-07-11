-- Keep channel credentials server-only while allowing the UI to read the
-- non-secret metadata added for team and specialist Telegram connections.
revoke select on public.channels from anon, authenticated;

grant select (
  id,
  agent_id,
  type,
  status,
  created_at,
  sub_agent_id,
  scope,
  label
) on public.channels to anon, authenticated;
