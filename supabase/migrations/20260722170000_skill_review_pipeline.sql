-- Governed custom-skill intake. Uploaded text is private by default; AI may only
-- nominate a shared candidate. A platform admin is required to publish it.
create table if not exists public.skill_submissions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  source_filename text check (char_length(source_filename) <= 180),
  content text not null check (char_length(content) between 1 and 12000),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'private' check (status in ('private','shared_candidate','shared','rejected')),
  compatibility_score smallint check (compatibility_score between 0 and 100),
  analysis jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists skill_submissions_account_created_idx on public.skill_submissions(account_id, created_at desc);
create index if not exists skill_submissions_shared_idx on public.skill_submissions(status, created_at desc) where status = 'shared';
create unique index if not exists skill_submissions_account_hash_uidx on public.skill_submissions(account_id, content_sha256);

alter table public.skill_submissions enable row level security;

drop policy if exists skill_submissions_read on public.skill_submissions;
create policy skill_submissions_read on public.skill_submissions for select to authenticated
  using (account_id = public.current_account_id() or status = 'shared');

-- Direct browser writes are deliberately denied. review-skill validates ownership,
-- treats content as untrusted data and writes with service_role after auth checks.
revoke insert, update, delete on public.skill_submissions from authenticated;
grant select on public.skill_submissions to authenticated;

comment on table public.skill_submissions is 'Private-by-default skill review queue; shared publication requires admin approval.';
