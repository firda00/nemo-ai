-- Throttle the expensive group "discussion" (a single @mention fans out to ~6-7 LLM calls).
-- Any group member could repeat it and drain the account's token balance. We record when a
-- discussion last ran on a channel and enforce a cooldown before starting another.
alter table public.channels add column if not exists last_discussion_at timestamptz;
