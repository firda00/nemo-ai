-- Resumable long-audio transcription jobs (5-hour recordings).
-- Job state previously lived as JSON in the PUBLIC media bucket — partial
-- transcripts were reachable by URL and concurrent 'continue' calls could
-- double-transcribe and double-bill. This table is service-role only (RLS on,
-- no policies), claims are atomic (single conditional UPDATE with a lease),
-- and finalize is idempotent (status+billed_at guard: exactly one biller).
create table if not exists public.transcribe_jobs (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts(id) on delete cascade,
  user_id         uuid not null,
  file_name       text not null,           -- Gemini File API name (for cleanup)
  file_uri        text not null,           -- Gemini File API uri
  mime            text not null,
  language        text not null default 'auto',
  windows_done    int  not null default 0,
  max_windows     int  not null default 7, -- derived from validated duration; hard 5h bound
  transcript      text not null default '',
  provider_tokens bigint not null default 0,
  status          text not null default 'pending', -- pending | done | failed
  claimed_at      timestamptz,             -- 3-minute processing lease
  claim_token     uuid,                    -- proves lease OWNERSHIP: every write must match
  billed_at       timestamptz,             -- set exactly once by the finalizer
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists transcribe_jobs_account_idx on public.transcribe_jobs (account_id, created_at desc);

-- Service-role only: RLS enabled with NO anon/authenticated policies. The edge
-- function verifies the caller's account before touching a job.
alter table public.transcribe_jobs enable row level security;

-- Transactional finalize: verify the claim token, persist the final transcript,
-- record usage and decrement the balance IN ONE TRANSACTION, then mark the job
-- done+billed. Exactly one caller can win (status+billed_at+token guard); any
-- failure rolls back the whole finalize so it stays retryable — a job is never
-- marked billed unless usage and the balance change committed with it.
create or replace function public.finalize_transcribe_job(
  p_job_id uuid,
  p_account_id uuid,
  p_claim_token uuid,
  p_windows_done int,
  p_transcript text,
  p_provider_tokens bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_billable bigint;
  v_updated integer;
begin
  if p_job_id is null or p_account_id is null or p_claim_token is null then
    raise exception 'finalize_transcribe_job: job, account and claim token are required' using errcode = '22004';
  end if;
  v_billable := greatest(coalesce(p_provider_tokens, 0), ceil(length(coalesce(p_transcript, ''))::numeric / 4)::bigint, 1);
  update public.transcribe_jobs
     set status = 'done',
         billed_at = now(),
         windows_done = p_windows_done,
         transcript = coalesce(p_transcript, ''),
         provider_tokens = coalesce(p_provider_tokens, 0),
         claimed_at = null,
         claim_token = null,
         updated_at = now()
   where id = p_job_id
     and account_id = p_account_id
     and status = 'pending'
     and billed_at is null
     and claim_token = p_claim_token;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return null; -- lost the race, stale token, or job already finished
  end if;
  insert into public.usage (account_id, tokens, model)
  values (p_account_id, v_billable, 'audio-transcription:gemini-file');
  -- usage stores RAW LLM tokens; the balance is charged in CREDITS through the
  -- existing converter (ceil(raw/1000)) so this path bills exactly like every
  -- other Edge Function — inside this transaction
  perform public.decrement_token_balance(p_account_id, v_billable);
  return v_billable;
end;
$$;

revoke all on function public.finalize_transcribe_job(uuid, uuid, uuid, int, text, bigint) from public, anon, authenticated;
grant execute on function public.finalize_transcribe_job(uuid, uuid, uuid, int, text, bigint) to service_role;
