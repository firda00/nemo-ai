-- Платформенные токены Nemo и очередь задач SDR.
--
-- Здесь появляется ВТОРОЙ класс учётных данных рядом с сессией Supabase, и это главный риск всей
-- затеи: долгоживущий ключ, который машина носит с собой. Поэтому три решения приняты жёстко и
-- проверяются кодом, а не соглашением:
--
--   1. DENY BY DEFAULT. Токен не «принадлежит аккаунту и потому может всё» — он может РОВНО то, что
--      перечислено в allowed_actions. Пустой массив означает «ничего», а не «всё».
--   2. Токен НЕ ХРАНИТСЯ. В базе лежит HMAC-SHA256 от него с серверным перцем; сам токен виден
--      один раз при создании. Утечка дампа базы не даёт действующих ключей.
--   3. Собственный лимит частоты у КАЖДОГО токена, поверх подписки аккаунта. Подписка отвечает на
--      «вправе ли этот аккаунт», лимит токена — на «сколько может утёкший ключ до того, как его
--      заметят». Это разные вопросы, и одного ответа на оба недостаточно.
--
-- Все три таблицы — инфраструктура: RLS включён БЕЗ единой политики, доступ только service_role.

create table if not exists public.nemo_api_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- HMAC-SHA256 в hex. Уникален: два токена не могут дать один отпечаток, а поиск по нему —
  -- одно обращение по индексу, а не перебор таблицы на каждом запросе.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Строгий белый список. Пустой массив = токен не может ничего: так безопаснее, чем «не указано
  -- значит всё», и позволяет отключить токен, не удаляя историю.
  allowed_actions text[] not null default '{}'::text[],
  rate_limit_per_minute integer not null default 30 check (rate_limit_per_minute between 1 and 600),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  -- Для ревокации по признаку «этим ключом давно не пользовались» и для аудита.
  last_used_at timestamptz
);

create index if not exists nemo_api_tokens_account_idx on public.nemo_api_tokens (account_id);

alter table public.nemo_api_tokens enable row level security;

-- Счётчик частоты. Отдельная таблица, а не поле в токене: минутные ведра позволяют считать
-- атомарно одним INSERT ... ON CONFLICT, без блокировки строки токена на каждый запрос.
create table if not exists public.nemo_api_token_usage (
  token_id uuid not null references public.nemo_api_tokens(id) on delete cascade,
  minute_bucket timestamptz not null,
  request_count integer not null default 0,
  primary key (token_id, minute_bucket)
);

alter table public.nemo_api_token_usage enable row level security;

/*
 * Атомарный расход лимита частоты.
 *
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING — единственная форма, которая одновременно
 * увеличивает счётчик и возвращает новое значение без гонки. Прочитать-потом-записать здесь
 * означало бы, что десять одновременных вызовов Edge Function увидят одно и то же число и все
 * решат, что лимит не исчерпан.
 */
create or replace function public.nemo_token_consume_rate(p_token_id uuid, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count integer;
begin
  insert into public.nemo_api_token_usage as u (token_id, minute_bucket, request_count)
  values (p_token_id, v_bucket, 1)
  on conflict (token_id, minute_bucket)
    do update set request_count = u.request_count + 1
  returning u.request_count into v_count;

  return v_count <= p_limit;
end
$$;

-- Ведра старше суток не нужны никому: лимит минутный, а история расхода живёт в аудите задач.
create or replace function public.nemo_token_usage_gc()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.nemo_api_token_usage where minute_bucket < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- ─────────────────────────────  Очередь задач SDR  ─────────────────────────────
--
-- Синхронный прогон здесь невозможен по существу, а не по неудобству: 30–50 лидов это запрос к
-- Overpass, N загрузок чужих сайтов и N вызовов модели — минуты работы, за которые Edge Function
-- успевает быть убитой по времени. Клиент получает job_id сразу, воркер работает отдельно.

create table if not exists public.sdr_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- Каким токеном заведена задача. Нужно для аудита: по утёкшему ключу видно, что он успел создать.
  token_id uuid references public.nemo_api_tokens(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  params jsonb not null,
  -- Сколько кредитов списано при постановке. Хранится, чтобы вернуть РОВНО столько при провале.
  reserved_tokens bigint not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  -- Срок аренды: воркер, упавший молча, не должен держать задачу навсегда.
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  stats jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists sdr_jobs_account_idx on public.sdr_jobs (account_id, created_at desc);
create index if not exists sdr_jobs_queue_idx on public.sdr_jobs (status, created_at)
  where status in ('queued', 'running');

alter table public.sdr_jobs enable row level security;

-- Лиды, найденные задачей, привязываются к ней: иначе «прогон прошёл» и «вот его лиды» — два
-- несвязанных факта, и по job_id нельзя отдать результат.
alter table public.sdr_leads add column if not exists job_id uuid references public.sdr_jobs(id) on delete set null;
create index if not exists sdr_leads_job_idx on public.sdr_leads (job_id);

/*
 * Постановка задачи и списание кредитов ОДНОЙ транзакцией.
 *
 * Раздельно это две ошибки сразу: списали и не поставили — деньги за ничего; поставили и не
 * списали — бесплатный прогон в обход тарифа. Баланс аккаунта берётся FOR UPDATE, поэтому два
 * одновременных вызова не могут оба увидеть достаточный остаток.
 */
create or replace function public.enqueue_sdr_job(
  p_account_id uuid,
  p_token_id uuid,
  p_params jsonb,
  p_cost bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_job_id uuid;
begin
  if p_cost < 0 then raise exception 'invalid cost'; end if;

  select token_balance into v_balance from public.accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'account_not_found'); end if;

  if v_balance < p_cost then
    return jsonb_build_object('ok', false, 'error', 'insufficient_credits',
                              'balance', v_balance, 'required', p_cost);
  end if;

  update public.accounts set token_balance = token_balance - p_cost where id = p_account_id;

  insert into public.sdr_jobs (account_id, token_id, params, reserved_tokens)
  values (p_account_id, p_token_id, p_params, p_cost)
  returning id into v_job_id;

  return jsonb_build_object('ok', true, 'job_id', v_job_id, 'reserved', p_cost);
end
$$;

/*
 * Взять задачу в работу.
 *
 * FOR UPDATE SKIP LOCKED — тот же приём, что у остальных воркеров этого проекта: два воркера,
 * запущенные одновременно, разберут РАЗНЫЕ задачи, а не подерутся за одну. Задача с истёкшей
 * арендой возвращается в оборот: воркер мог быть убит между «взял» и «закончил».
 */
create or replace function public.claim_sdr_job(p_lease_seconds integer default 900)
returns setof public.sdr_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.sdr_jobs;
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  with candidate as (
    select id
    from public.sdr_jobs
    where attempts < 3
      and (
        status = 'queued'
        or (status = 'running' and lease_expires_at < now())
      )
    order by created_at
    for update skip locked
    limit 1
  )
  update public.sdr_jobs j
  set status = 'running',
      claim_token = gen_random_uuid(),
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempts = j.attempts + 1,
      updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.* into claimed;

  if claimed.id is not null then return next claimed; end if;
end
$$;

/** Продление аренды. Долгий прогон не должен выглядеть как умерший воркер. */
create or replace function public.heartbeat_sdr_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  update public.sdr_jobs
  set lease_expires_at = now() + make_interval(secs => v_lease), updated_at = now()
  where id = p_job_id and claim_token = p_claim_token and status = 'running';
  return found;
end
$$;

/*
 * Завершение задачи. Кредиты за ПРОВАЛ возвращаются.
 *
 * Аренда проверяется по claim_token: воркер, у которого задачу уже отобрали по истечении срока,
 * не должен дописать свой результат поверх работы того, кто взял её после него.
 */
create or replace function public.finish_sdr_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_stats jsonb default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.sdr_jobs;
begin
  if p_status not in ('completed', 'failed', 'queued') then raise exception 'invalid status'; end if;

  select * into v_job from public.sdr_jobs
  where id = p_job_id and claim_token = p_claim_token and status = 'running'
  for update;
  if not found then return false; end if;

  -- Возврат только при окончательном провале. Возврат на каждой неудачной попытке означал бы, что
  -- три повтора списывают один раз, а возвращают трижды.
  if p_status = 'failed' and v_job.reserved_tokens > 0 then
    update public.accounts set token_balance = token_balance + v_job.reserved_tokens
    where id = v_job.account_id;
  end if;

  update public.sdr_jobs
  set status = p_status,
      stats = coalesce(p_stats, stats),
      error = p_error,
      claim_token = case when p_status = 'queued' then null else claim_token end,
      lease_expires_at = case when p_status = 'queued' then null else lease_expires_at end,
      finished_at = case when p_status in ('completed', 'failed') then now() else null end,
      updated_at = now()
  where id = p_job_id;

  return true;
end
$$;

create or replace function public.sdr_jobs_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sdr_jobs_set_updated_at on public.sdr_jobs;
create trigger sdr_jobs_set_updated_at
  before update on public.sdr_jobs
  for each row execute function public.sdr_jobs_touch_updated_at();
