-- Governed autonomous agent evolution. Prompt changes may be applied automatically only
-- after an independent quality/safety review. Every change remains auditable and reversible.
alter table public.agent_evolutions
  add column if not exists auto_applied boolean not null default false,
  add column if not exists review_score integer,
  add column if not exists review_summary text,
  add column if not exists applied_at timestamptz,
  add column if not exists rolled_back_at timestamptz;

alter table public.agent_evolutions
  drop constraint if exists agent_evolutions_review_score_check;
alter table public.agent_evolutions
  add constraint agent_evolutions_review_score_check
  check (review_score is null or review_score between 0 and 100);

create index if not exists agent_evolutions_auto_applied_idx
  on public.agent_evolutions (agent_id, applied_at desc)
  where auto_applied = true;
