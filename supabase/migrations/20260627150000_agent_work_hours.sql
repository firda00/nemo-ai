-- Custom work hours: when schedule = 'work-hours', the agent is active only
-- between work_start and work_end (HH:MM, in the agent's timezone). 24/7 = always.
alter table public.agents add column if not exists work_start text;
alter table public.agents add column if not exists work_end   text;
