-- Turn free-form feedback into a small, account-scoped support workflow.
-- Existing rows stay valid and appear as new, uncategorised messages.
alter table public.customer_feedback
  add column if not exists topic text,
  add column if not exists status text not null default 'new',
  add column if not exists contact_requested boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table public.customer_feedback
  drop constraint if exists customer_feedback_topic_check,
  add constraint customer_feedback_topic_check check (
    topic is null or topic in ('agent_quality', 'speed', 'technical', 'billing', 'onboarding', 'other')
  ),
  drop constraint if exists customer_feedback_status_check,
  add constraint customer_feedback_status_check check (status in ('new', 'reviewing', 'resolved'));

create index if not exists customer_feedback_status_created_idx
  on public.customer_feedback(status, created_at desc);

