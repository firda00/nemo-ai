-- Подключение памяти: транзакционный выходной ящик.
--
-- persist_worker_research_run завершает прогон одной транзакцией и после неё прогон терминален.
-- Извлекать кандидатов в память до неё — двойная запись при повторе; после — потеря при падении,
-- потому что возвращаться уже некуда; внутри — лишний вызов модели в критической секции под лизом,
-- где он задерживает выдачу отчёта ради необязательного обучения.
--
-- Поэтому здесь появляется только строка задания, в той же транзакции, что и результат. Забрать
-- её и позвать модель — работа отдельного повторяемого воркера.
create or replace function public.persist_worker_research_run(
  p_worker_run_id uuid, p_claim_token uuid, p_account_id uuid, p_task text,
  p_status text, p_department_id uuid, p_run_ref uuid, p_report text,
  p_sources jsonb, p_steps jsonb, p_model text, p_tokens bigint, p_cost numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare persisted_id uuid;
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_worker_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  insert into public.research_runs(account_id, task, status, kind, department_id, run_ref, report, sources, steps, model, tokens, cost)
  values(p_account_id, p_task, p_status, 'team_run', p_department_id, p_run_ref, p_report, p_sources, p_steps, p_model, p_tokens, p_cost)
  returning id into persisted_id;
  update public.autonomous_run_checkpoints
  set state = state || jsonb_build_object(
        'result', p_report,
        'resultId', persisted_id,
        'escalatedCount', (select count(*) from jsonb_array_elements(p_steps) step where coalesce((step->'review'->>'needs_human_review')::boolean, false))
      ),
      phase = 'synth', transition = 'synth', status = 'completed',
      specialist_cursor = jsonb_array_length(p_steps), review_cursor = jsonb_array_length(p_steps),
      claim_token = null, claimed_at = null, last_error = null,
      next_attempt_at = now(), updated_at = now()
  where id = p_worker_run_id and claim_token = p_claim_token and status = 'running';
  if not found then raise exception 'worker claim lost'; end if;

  -- Вся идемпотентность держится на уникальности (account_id, run_ref, event_type): повторное
  -- завершение того же прогона не создаёт второго задания, и do nothing здесь — не небрежность,
  -- а само правило. Провал этой вставки не должен отменять уже посчитанный отчёт: обучение
  -- необязательно, отчёт обязателен.
  begin
    insert into public.org_memory_outbox (account_id, run_ref, event_type, payload)
    values (p_account_id, p_run_ref, 'extract_claims',
            jsonb_build_object('research_run_id', persisted_id, 'checkpoint_id', p_worker_run_id))
    on conflict (account_id, run_ref, event_type) do nothing;
  exception when others then
    null;
  end;

  return persisted_id;
end
$$;

revoke all on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) from public, anon, authenticated;
grant execute on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) to service_role;

-- Забрать задание с лизом. skip locked, потому что два воркера не должны драться за одну строку,
-- а тот, кто опоздал, обязан взять следующую, а не ждать.
create or replace function public.org_memory_outbox_claim(p_limit int default 3, p_lease_seconds int default 300)
returns setof public.org_memory_outbox
language sql
security definer
set search_path = ''
as $$
  update public.org_memory_outbox o
     set status = 'processing', claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select c.id from public.org_memory_outbox c
      where c.status = 'pending'
         -- Брошенное задание возвращается в работу: воркер мог умереть, не отчитавшись.
         or (c.status = 'processing' and c.claimed_at < now() - make_interval(secs => p_lease_seconds))
      order by c.created_at
      limit greatest(1, least(p_limit, 20))
      for update skip locked
   )
  returning o.*;
$$;

create or replace function public.org_memory_outbox_finish(p_id uuid, p_status text, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.org_memory_outbox
     set status = case when p_status in ('done', 'failed') then p_status else 'failed' end,
         processed_at = now(),
         last_error = left(p_error, 500)
   where id = p_id;
$$;

revoke all on function public.org_memory_outbox_claim(int, int) from public, anon, authenticated;
grant execute on function public.org_memory_outbox_claim(int, int) to service_role;
revoke all on function public.org_memory_outbox_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.org_memory_outbox_finish(uuid, text, text) to service_role;

comment on function public.org_memory_outbox_claim(int, int) is
  'Лизует задания извлечения памяти. Обучение отделено от прогона, чтобы падение обучения не '
  'стоило отчёта, а падение прогона не стоило обучения.';
