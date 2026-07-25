-- Run telemetry (C0). Three separate holes made every cost and model-mix number unusable:
--
--   1. `usage.cost` was written by 4 of 22 call sites, so total spend read as ~$0.02 on 700k
--      tokens. Every other site inserted the row and left the column at its default.
--   2. `usage.model` is free text and 9 call sites wrote a PIPELINE LABEL into it
--      ('tool', 'media-image', 'research-agent', 'ops-workflow', 'subagent'…), so ~23% of
--      tokens were attributed to models that do not exist.
--   3. `research_runs.tokens` existed but was never set, so no run had a token count and
--      cost-per-run could not be derived at all.
--
-- This adds the missing columns and separates the two meanings. It does not invent costs for
-- historical rows: back-filling a price for a run whose model was never recorded would
-- manufacture exactly the kind of confident-but-wrong number this whole change exists to stop.

alter table public.usage add column if not exists stage   text;
alter table public.usage add column if not exists run_ref uuid;

-- A real model id always carries its provider prefix ("openai/gpt-4o"). Anything without one
-- was a stage label in the wrong column: move it, and stop counting it as a model.
update public.usage
   set stage = model,
       model = null
 where model is not null
   and model not like '%/%'
   and stage is null;

create index if not exists usage_run_ref_idx on public.usage (run_ref) where run_ref is not null;
create index if not exists usage_account_created_idx on public.usage (account_id, created_at desc);

alter table public.research_runs add column if not exists cost numeric not null default 0;

-- Dead-letter sweep for browser tasks. A `run` that comes back pending writes result='running'
-- and nothing ever revisits it: one such row has been running since 18 July. The watchdog
-- closes them out; this partial index keeps that sweep cheap.
create index if not exists tool_runs_pending_idx on public.tool_runs (tool, created_at)
  where result = 'running';
