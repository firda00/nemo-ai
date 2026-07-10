-- Strong assignee identity for tasks. Closing a task via DM was authorized by matching the
-- task's assignee_name against the sender's Telegram display_name — a user-settable, non-unique
-- field (spoofable: rename your profile to a colleague's name). We add the assignee's numeric
-- Telegram user id (globally unique, non-spoofable) so completion is authorized by identity,
-- not by display name. Legacy/name-only tasks simply can't be closed via DM (must be done in
-- the group, where the bot verifies the sender's identity directly).
alter table public.tasks add column if not exists assignee_tg_user_id text;
create index if not exists tasks_assignee_uid_idx on public.tasks (assignee_tg_user_id) where status <> 'done';
