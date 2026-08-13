-- A decision record is separate from any executor. Approval alone never performs an action.
create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  source text not null check (source in ('browser', 'agent', 'workflow')),
  action_type text not null,
  summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists approval_requests_account_pending_idx on public.approval_requests(account_id, status, created_at desc);
alter table public.approval_requests enable row level security;
revoke all on public.approval_requests from anon, authenticated;
