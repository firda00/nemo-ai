-- Общая память организации: то, что компания выяснила, работая.
--
-- Документы, которые загрузил человек, уже раздаются команде через match_knowledge_team. Они
-- истинны по определению — их принёс владелец. Здесь другое: утверждения, которые вывели агенты.
-- Вывод регулярно ошибается, поэтому у него обязаны быть происхождение, счёт свидетельств, срок
-- годности и исход. Без них ошибка становится неотличима от факта уже на следующем прогоне.
--
-- Конструкция и разбор ревью: ORG_MEMORY_DESIGN_RU.md (ревизия 2).

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Во что организация верит
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.org_claims (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id()
                  references public.accounts(id) on delete cascade,

  -- Читаемое отдельно от контекста, в котором родилось. «Клиент платит после демо» — да.
  -- «Он согласился» — нет: через месяц непонятно, кто и на что.
  statement     text not null check (char_length(statement) between 8 and 600),
  kind          text not null check (kind in ('fact', 'preference', 'constraint', 'lesson')),

  -- Свободный ключ вида 'client:uuid', 'channel:telegram'. Ядро не знает, что такое клиент —
  -- только что это ключ. Доменная нейтральность держится на этом.
  subject       text not null check (char_length(subject) between 1 and 120),
  subject_key   text not null check (char_length(subject_key) between 1 and 120),

  -- Старшинство. Слово владельца перебивает вывод агента — тот же принцип, что в Commerce,
  -- где значение владельца старше значения Uzum.
  source        text not null check (source in ('owner', 'agent', 'tool', 'outcome')),
  source_detail jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(source_detail) = 'object'),
  run_ref       uuid,

  -- Минимальная привилегия ВНУТРИ аккаунта. Изоляция арендаторов — не то же самое: факт,
  -- выведенный при работе с одним клиентом, не обязан быть виден агенту, занятому другим.
  audience      text not null default 'account'
                  check (audience in ('account', 'department', 'agent', 'owner_only')),
  audience_ref  uuid,

  -- УВЕРЕННОСТЬ КАК СЧЁТ СВИДЕТЕЛЬСТВ. Колонки для присвоения нет вовсе — это и есть защита
  -- от самоубеждения: агент физически не может поднять себе уверенность, ему нечего записать.
  -- Beta(1,1) на старте даёт 0.5, что здесь означает незнание, а не «пятьдесят на пятьдесят».
  evidence_for     integer not null default 0 check (evidence_for >= 0),
  evidence_against integer not null default 0 check (evidence_against >= 0),
  confidence    numeric(4,3) generated always as (
                  round((1 + evidence_for)::numeric / (2 + evidence_for + evidence_against), 3)
                ) stored,

  valid_from    timestamptz not null default now(),
  valid_until   timestamptz,

  status        text not null default 'active'
                  check (status in ('active', 'retired', 'disputed')),
  supersedes    uuid,

  embedding       public.vector(384),
  embedding_model text not null default 'gte-small',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Опора для составных внешних ключей: межаккаунтная ссылка становится невозможной физически,
  -- а не по договорённости.
  unique (account_id, id),
  constraint org_claims_supersedes_same_account
    foreign key (account_id, supersedes) references public.org_claims (account_id, id)
    on delete set null,
  -- Сужение круга чтения без указания, до кого именно, — это не сужение.
  constraint org_claims_audience_ref_present check (
    (audience in ('account', 'owner_only') and audience_ref is null)
    or (audience in ('department', 'agent') and audience_ref is not null)
  )
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Что организация сделала
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.org_decisions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default public.current_account_id()
                 references public.accounts(id) on delete cascade,

  -- Ссылка на существующий леджер, не новый источник истины. Аудит, не авторизация.
  source       text not null check (source in ('approval', 'recommendation', 'run', 'manual')),
  source_id    uuid,
  summary      text not null check (char_length(summary) between 4 and 400),

  -- Измеримое ожидание. Проверяется схемой, а не договорённостью: предсказание без метрики,
  -- оператора и значения — пожелание, а из пожеланий не учатся.
  expected     jsonb not null,
  horizon_at   timestamptz not null,

  -- Версия политики на момент решения. evolve-agent меняет промпты автоматически (autoMode),
  -- и исход, измеренный через две недели, может относиться к другому агенту.
  policy_ref   jsonb not null default '{}'::jsonb check (jsonb_typeof(policy_ref) = 'object'),

  outcome      text not null default 'pending'
                 check (outcome in ('pending', 'confirmed', 'refuted', 'unmeasurable')),
  observed     jsonb,
  resolved_at  timestamptz,

  created_at   timestamptz not null default now(),

  unique (account_id, id),
  constraint org_decisions_horizon_after_creation check (horizon_at > created_at),
  constraint org_decisions_expected_measurable check (
    jsonb_typeof(expected) = 'object'
    and jsonb_typeof(expected -> 'metric') = 'string'
    and (expected ->> 'op') in ('>=', '>', '<=', '<', '==', '!=')
    and expected ? 'value'
  ),
  constraint org_decisions_resolved_consistent check (
    (outcome = 'pending' and resolved_at is null)
    or (outcome <> 'pending' and resolved_at is not null)
  )
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- На каких убеждениях решение стояло
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Массив uuid[] был бы дешевле и неверен: ни поэлементного внешнего ключа, ни привязки к
-- арендатору, ни метаданных присвоения заслуги. Чужой claim_id вставился бы молча.
create table if not exists public.org_decision_claims (
  account_id   uuid not null,
  decision_id  uuid not null,
  claim_id     uuid not null,

  -- Присвоение заслуги. Пять убеждений и один сработавший текст: плюс всем пятерым — это не
  -- калибровка, а порча памяти. Автоматически двигается только primary, и только одиночный.
  role         text not null default 'context'
                 check (role in ('primary', 'supporting', 'context')),
  weight       numeric(4,3) not null default 1.000 check (weight between 0 and 1),

  -- Чем было убеждение НА МОМЕНТ решения. Иначе исход применится к переписанному смыслу.
  confidence_at_decision numeric(4,3) not null check (confidence_at_decision between 0 and 1),
  statement_hash         text not null check (char_length(statement_hash) between 8 and 128),

  created_at   timestamptz not null default now(),

  primary key (account_id, decision_id, claim_id),
  foreign key (account_id, decision_id) references public.org_decisions (account_id, id) on delete cascade,
  foreign key (account_id, claim_id)    references public.org_claims    (account_id, id) on delete cascade
);

-- Ровно одна главная гипотеза на решение. Без этого автоматическое обучение выключено —
-- и это правильное поведение по умолчанию, а не ограничение.
create unique index if not exists org_decision_claims_one_primary_idx
  on public.org_decision_claims (account_id, decision_id) where role = 'primary';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Идемпотентность извлечения
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- persist_worker_research_run завершает прогон атомарно, и после неё прогон терминален.
-- Извлекать кандидатов до транзакции — двойная запись при повторе; после — потеря при падении;
-- внутри — лишний вызов модели в критической секции под лизом. Значит, выходной ящик.
create table if not exists public.org_memory_outbox (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  run_ref      uuid not null,
  event_type   text not null check (event_type in ('extract_claims', 'resolve_outcome')),
  payload      jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status       text not null default 'pending'
                 check (status in ('pending', 'processing', 'done', 'failed')),
  attempts     integer not null default 0 check (attempts >= 0),
  claimed_at   timestamptz,
  processed_at timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  -- Вся идемпотентность держится на этой строке.
  unique (account_id, run_ref, event_type)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Индексы
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Намеренно БЕЗ индекса HNSW по embedding. Он плохо дружит с предфильтром по аккаунту и теряет
-- полноту, а «отбор первым» в SQL не гарантирует порядок исполнения. На сотнях утверждений
-- точная сортировка по уже суженному множеству дешевле. Замер до выбора стратегии, а не после.
create index if not exists org_claims_recall_idx
  on public.org_claims (account_id, kind, subject_key) where status = 'active';
create index if not exists org_claims_run_idx
  on public.org_claims (account_id, run_ref) where run_ref is not null;
create index if not exists org_decisions_due_idx
  on public.org_decisions (account_id, horizon_at) where outcome = 'pending';
create index if not exists org_outbox_due_idx
  on public.org_memory_outbox (status, created_at) where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Изоляция
-- ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.org_claims          enable row level security;
alter table public.org_decisions       enable row level security;
alter table public.org_decision_claims enable row level security;
alter table public.org_memory_outbox   enable row level security;

-- Владелец ВИДИТ, во что система верит. Неисправляемая память хуже отсутствующей, а исправить
-- можно только то, что видно.
drop policy if exists org_claims_read on public.org_claims;
create policy org_claims_read on public.org_claims for select
  using (account_id = public.current_account_id());

drop policy if exists org_decisions_read on public.org_decisions;
create policy org_decisions_read on public.org_decisions for select
  using (account_id = public.current_account_id());

drop policy if exists org_decision_claims_read on public.org_decision_claims;
create policy org_decision_claims_read on public.org_decision_claims for select
  using (account_id = public.current_account_id());

-- Но НЕ пишет напрямую: source='owner' нельзя подделать задним числом, а счётчики свидетельств
-- нельзя выкрутить. Образец — approval_requests.
revoke insert, update, delete on public.org_claims          from anon, authenticated;
revoke insert, update, delete on public.org_decisions       from anon, authenticated;
revoke insert, update, delete on public.org_decision_claims from anon, authenticated;
revoke all                    on public.org_memory_outbox   from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.org_claims_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists org_claims_touch_trg on public.org_claims;
create trigger org_claims_touch_trg before update on public.org_claims
  for each row execute function public.org_claims_touch();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Поиск
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Принимает kind и subject_key, в отличие от первой редакции конструкции: без них маршрутизация
-- по фазам нереализуема, а фильтрация top-k после выборки молча теряет релевантное.
--
-- p_account_id здесь — УТВЕРЖДЕНИЕ, а не граница доступа: security definer и service role
-- обходят RLS. Границу ставит вызывающий; для воркера — org_claims_recall_for_run ниже.
create or replace function public.match_org_claims(
  p_account_id    uuid,
  p_query         public.vector(384),
  p_kinds         text[] default null,
  p_subject_key   text default null,
  p_agent_id      uuid default null,
  p_department_id uuid default null,
  p_k             int default 8
)
returns table (
  id uuid, statement text, kind text, subject text, source text,
  confidence numeric, evidence_for int, evidence_against int, similarity double precision
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.statement, c.kind, c.subject, c.source,
         c.confidence, c.evidence_for, c.evidence_against,
         -- Оператор назван схемой явно: при search_path = '' он иначе не резолвится, а ронять
         -- пустой путь ради оператора значит менять границу безопасности ради синтаксиса.
         1 - (c.embedding operator(public.<=>) p_query)
    from public.org_claims c
   where c.account_id = p_account_id
     and c.status = 'active'
     and c.embedding is not null
     and (c.valid_until is null or c.valid_until > now())
     and (p_kinds is null or c.kind = any(p_kinds))
     and (p_subject_key is null or c.subject_key = p_subject_key)
     -- owner_only не попадает агентам ни при каких параметрах.
     and (
       c.audience = 'account'
       or (c.audience = 'agent' and c.audience_ref = p_agent_id)
       or (c.audience = 'department' and c.audience_ref = p_department_id)
     )
   order by c.embedding operator(public.<=>) p_query
   limit greatest(1, least(p_k, 20))
$$;

-- Безопасный вход для воркера: аккаунт ВЫВОДИТСЯ из захваченного чекпоинта, а не принимается
-- рядом с ним. Личность прогона и аккаунт как два независимых параметра — это приглашение
-- к подмене одного из них.
create or replace function public.org_claims_recall_for_run(
  p_checkpoint_id uuid,
  p_claim_token   uuid,
  p_query         public.vector(384),
  p_kinds         text[] default null,
  p_subject_key   text default null,
  p_k             int default 8
)
returns table (
  id uuid, statement text, kind text, subject text, source text,
  confidence numeric, evidence_for int, evidence_against int, similarity double precision
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account uuid;
begin
  select r.account_id into v_account
    from public.autonomous_run_checkpoints r
   where r.id = p_checkpoint_id and r.claim_token = p_claim_token and r.status = 'running';
  if v_account is null then
    raise exception using errcode = '42501', message = 'worker claim lost';
  end if;
  return query select * from public.match_org_claims(v_account, p_query, p_kinds, p_subject_key, null, null, p_k);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Запись
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Целостность живёт здесь; семантика (дедуп по эмбеддингу, отсев императивов) — в orgMemory.ts,
-- где её можно протестировать вне Deno.
--
-- Возвращает, что произошло: 'inserted' | 'reinforced' | 'refused_owner_conflict' | 'disputed'.
create or replace function public.org_claim_record(
  p_account_id    uuid,
  p_statement     text,
  p_kind          text,
  p_subject       text,
  p_subject_key   text,
  p_source        text,
  p_source_detail jsonb default '{}'::jsonb,
  p_run_ref       uuid default null,
  p_audience      text default 'account',
  p_audience_ref  uuid default null,
  p_embedding     public.vector(384) default null,
  p_conflicts     uuid[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_owner_conflict int;
  v_agent_conflict int;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Конфликтующие утверждения ищет вызывающий (это семантика), но проверяет их принадлежность
  -- аккаунту база: подсунутый чужой id не должен ни на что повлиять.
  select count(*) into v_owner_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id
     and c.status = 'active' and c.source = 'owner';

  -- Владелец старше. Агент не переписывает то, что сказал человек.
  if v_owner_conflict > 0 and p_source <> 'owner' then
    return jsonb_build_object('result', 'refused_owner_conflict', 'conflicts', v_owner_conflict);
  end if;

  insert into public.org_claims (
    account_id, statement, kind, subject, subject_key, source, source_detail,
    run_ref, audience, audience_ref, embedding
  ) values (
    p_account_id, p_statement, p_kind, p_subject, p_subject_key, p_source,
    coalesce(p_source_detail, '{}'::jsonb), p_run_ref,
    coalesce(p_audience, 'account'), p_audience_ref, p_embedding
  )
  returning id into v_id;

  -- Два несовместимых вывода агентов не разрешаются молча в пользу нового. Система сообщает,
  -- что верит в два противоречащих утверждения, и отдаёт выбор владельцу.
  select count(*) into v_agent_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id and c.status = 'active';

  if v_agent_conflict > 0 then
    update public.org_claims set status = 'disputed'
     where account_id = p_account_id and (id = any(p_conflicts) or id = v_id);
    return jsonb_build_object('result', 'disputed', 'id', v_id, 'with', v_agent_conflict);
  end if;

  return jsonb_build_object('result', 'inserted', 'id', v_id);
end;
$$;

-- Владелец снимает неверное утверждение. Авторизация по членству в аккаунте: сегодня в каждом
-- аккаунте ровно один пользователь, поэтому «член» и есть владелец. Когда появятся команды,
-- сюда понадобится роль — отдельным решением, а не молчаливым расширением этой проверки.
create or replace function public.org_claim_retire(p_claim_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid := public.current_account_id();
  v_updated int;
begin
  if v_account is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;
  update public.org_claims
     set status = 'retired',
         source_detail = source_detail || jsonb_build_object('retired_reason', coalesce(p_reason, ''), 'retired_by', 'owner')
   where id = p_claim_id and account_id = v_account and status <> 'retired';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('retired', v_updated);
end;
$$;

-- Отзыв целого прогона. Прогон оказался мусорным — все порождённые им убеждения снимаются
-- одним запросом. Без этого плохой прогон отравляет память навсегда.
create or replace function public.org_claims_retract_run(p_account_id uuid, p_run_ref uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_updated int;
begin
  update public.org_claims set status = 'retired'
   where account_id = p_account_id and run_ref = p_run_ref and status <> 'retired';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('retired', v_updated);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Исход
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Идемпотентно по построению: переход pending → решённое и начисление свидетельства происходят
-- в одном операторе. Повтор cron не начислит дважды, потому что второй раз строка уже не pending.
--
-- Свидетельство получает ТОЛЬКО одиночная главная гипотеза. Решение, где primary не назначен или
-- их несколько, остаётся зарегистрированным, но необучающим — и это честнее, чем раздать плюс
-- всем связанным убеждениям и назвать это калибровкой.
create or replace function public.org_decision_resolve(
  p_decision_id uuid,
  p_outcome     text,
  p_observed    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid;
  v_primary uuid;
  v_primaries int;
begin
  if p_outcome not in ('confirmed', 'refuted', 'unmeasurable') then
    raise exception using errcode = '22023', message = 'outcome must be confirmed, refuted or unmeasurable';
  end if;

  update public.org_decisions
     set outcome = p_outcome, observed = coalesce(p_observed, '{}'::jsonb), resolved_at = now()
   where id = p_decision_id and outcome = 'pending'
  returning account_id into v_account;

  if v_account is null then
    return jsonb_build_object('applied', false, 'reason', 'already_resolved_or_missing');
  end if;

  select count(*), min(claim_id) into v_primaries, v_primary
    from public.org_decision_claims
   where account_id = v_account and decision_id = p_decision_id and role = 'primary';

  if p_outcome = 'unmeasurable' or v_primaries <> 1 then
    return jsonb_build_object('applied', true, 'learned', false,
      'reason', case when p_outcome = 'unmeasurable' then 'unmeasurable' else 'no_single_primary' end);
  end if;

  update public.org_claims
     set evidence_for     = evidence_for     + case when p_outcome = 'confirmed' then 1 else 0 end,
         evidence_against = evidence_against + case when p_outcome = 'refuted'   then 1 else 0 end
   where id = v_primary and account_id = v_account;

  -- Снятие — не по среднему, а по накопленным свидетельствам: пять неудач подряд против одного
  -- слабого коррелированного наблюдения не должны весить одинаково.
  update public.org_claims
     set status = 'retired'
   where id = v_primary and account_id = v_account and status = 'active'
     and evidence_against >= 5 and confidence < 0.300;

  return jsonb_build_object('applied', true, 'learned', true, 'claim_id', v_primary);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Права
-- ─────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.match_org_claims(uuid, public.vector, text[], text, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.match_org_claims(uuid, public.vector, text[], text, uuid, uuid, int) to service_role;

revoke all on function public.org_claims_recall_for_run(uuid, uuid, public.vector, text[], text, int) from public, anon, authenticated;
grant execute on function public.org_claims_recall_for_run(uuid, uuid, public.vector, text[], text, int) to service_role;

revoke all on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[]) from public, anon, authenticated;
grant execute on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[]) to service_role;

revoke all on function public.org_claims_retract_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.org_claims_retract_run(uuid, uuid) to service_role;

revoke all on function public.org_decision_resolve(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_resolve(uuid, text, jsonb) to service_role;

-- Единственная функция, доступная владельцу напрямую: он должен уметь опровергнуть то,
-- во что система верит, не проходя через агента.
revoke all on function public.org_claim_retire(uuid, text) from public, anon;
grant execute on function public.org_claim_retire(uuid, text) to authenticated, service_role;

comment on table public.org_claims is
  'Что организация вывела, работая. В отличие от knowledge_* — опровержимо, поэтому несёт '
  'происхождение, счёт свидетельств и срок годности.';
comment on column public.org_claims.confidence is
  'Вычисляемая из свидетельств. Присвоить нельзя — колонки для этого нет, и это защита от '
  'самоубеждения, а не удобство.';
comment on table public.org_decision_claims is
  'Нить обучения: без неё известно, что ошиблись, но не какое убеждение подвело.';
