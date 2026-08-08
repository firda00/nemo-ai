-- Реестр метрик: что система умеет измерять — и о чём честно говорит, что не умеет.
--
-- Наблюдатель был цепочкой if/elsif в SQL: каждая новая сфера требовала правки функции, а список
-- измеримого нигде не existed как данные. Отсюда два следствия, оба плохие. Расширение упиралось
-- в переписывание кода, и — важнее — нельзя было объявить метрику, не соврав: либо она есть в
-- цепочке и считается, либо её нет и регистрация решения падает с 'unknown metric'. Третьего
-- состояния — «знаем о такой метрике, но канала данных под ней нет» — не существовало.
--
-- Теперь оно есть, и это единственный способ говорить о CRM, финансах и HR, не обещая измеримости.
create table if not exists public.org_metrics (
  key           text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  domain        text not null check (domain in ('commerce', 'support', 'crm', 'finance', 'marketing', 'hr')),
  label         text not null check (char_length(label) between 3 and 120),
  unit          text not null check (unit in ('units', 'tiyin', 'minutes', 'percent', 'count')),

  -- Кого измеряем: конкретный товар, каталог, диалог или аккаунт целиком.
  subject_kind  text check (subject_kind in ('sku', 'catalog', 'dialogue', 'account')),

  -- КАК читаем. Стратегия — это форма чтения, а не метрика: «последнее значение колонки X по
  -- субъекту», «сумма по свежему слоту». Метрика, попадающая в известную форму, добавляется одной
  -- строкой. Метрика принципиально новой формы требует кода — и это честный предел, а не «в один
  -- клик всё».
  read_strategy text,
  source_column text,   -- имя колонки, если стратегия читает колонку
  source_value  text,   -- значение фильтра, если стратегия считает строки по признаку

  -- Подключён ли реальный канал данных. Ложь здесь дороже всего: объявленная, но не подключённая
  -- метрика превратила бы громкий отказ при регистрации в тихое 'unmeasurable' через неделю.
  is_wired       boolean not null default false,
  unwired_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Подключённая метрика обязана сказать, как её читать. Неподключённая — чего не хватает.
  -- Молчать не разрешено ни той, ни другой.
  constraint org_metrics_wired_is_readable check (
    (is_wired and read_strategy is not null and subject_kind is not null)
    or (not is_wired)
  ),
  constraint org_metrics_unwired_explains_itself check (
    (not is_wired and unwired_reason is not null and char_length(unwired_reason) >= 10)
    or is_wired
  )
);

alter table public.org_metrics enable row level security;

-- Реестр одинаков для всех арендаторов: это возможности платформы, а не данные аккаунта.
-- Владельцу его видно — иначе «система умеет измерять X» останется словами.
drop policy if exists org_metrics_read on public.org_metrics;
create policy org_metrics_read on public.org_metrics for select to authenticated using (true);
revoke insert, update, delete on public.org_metrics from anon, authenticated;

create index if not exists org_metrics_domain_idx on public.org_metrics (domain, is_wired);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Наблюдатель поверх реестра
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Измеряем только по наблюдениям ПОСЛЕ горизонта: данные, собранные до решения, о его исходе
-- ничего не говорят, а измерить ими и назвать результатом — самый дешёвый способ получить
-- красивую точность ни о чём.
create or replace function public.org_observe_metric(
  p_account_id uuid,
  p_metric     text,
  p_params     jsonb,
  p_after      timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m         public.org_metrics%rowtype;
  v_sku      uuid := nullif(p_params->>'sku_id', '')::uuid;
  v_catalog  uuid := nullif(p_params->>'catalog_id', '')::uuid;
  v_dialogue uuid := nullif(p_params->>'dialogue_id', '')::uuid;
  v_value   numeric;
  v_at      timestamptz;
begin
  select * into m from public.org_metrics where key = p_metric;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_metric', 'metric', p_metric);
  end if;
  if not m.is_wired then
    -- Не ошибка вызова и не свойство мира: под метрикой просто нет канала данных, и мы это знаем.
    return jsonb_build_object('ok', false, 'reason', 'metric_not_wired', 'metric', p_metric,
                              'detail', m.unwired_reason);
  end if;

  -- Принадлежность арендаторам проверяется здесь: функция security definer, RLS её не прикрывает.
  if v_sku is not null then
    perform 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
     where s.id = v_sku and c.account_id = p_account_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account'); end if;
  end if;
  if v_catalog is not null then
    perform 1 from public.commerce_catalogs c where c.id = v_catalog and c.account_id = p_account_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account'); end if;
  end if;
  if v_dialogue is not null then
    perform 1 from public.dialogues d
      join public.agents a on a.id = d.agent_id
     where d.id = v_dialogue and a.account_id = p_account_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account'); end if;
  end if;

  if m.read_strategy in ('commerce_snapshot_latest', 'commerce_slot_sum', 'commerce_slot_count_zero')
     and m.source_column is null then
    return jsonb_build_object('ok', false, 'reason', 'metric_misconfigured', 'metric', p_metric);
  end if;

  -- Имя колонки приходит из таблицы, доступной только service_role, и всё равно проходит через
  -- format('%I'): экранирование идентификатора стоит одну функцию, а доверие к данным — нет.
  if m.read_strategy = 'commerce_snapshot_latest' then
    execute format(
      'select i.%I, i.observed_at from public.commerce_inventory_snapshots i
        where i.sku_id = $1 and i.observed_at > $2 order by i.observed_at desc limit 1',
      m.source_column)
      into v_value, v_at using v_sku, p_after;

  elsif m.read_strategy in ('commerce_slot_sum', 'commerce_slot_count_zero') then
    -- По самому свежему полному слоту: смешивать соседние слоты значит складывать разные моменты
    -- времени и выдавать сумму за состояние.
    execute format(
      'with slot as (
         select max(i.observed_slot) s from public.commerce_inventory_snapshots i
           join public.commerce_skus k on k.id = i.sku_id
          where k.catalog_id = $1 and i.observed_at > $2)
       select %s, max(i.observed_at)
         from public.commerce_inventory_snapshots i
         join public.commerce_skus k on k.id = i.sku_id, slot
        where k.catalog_id = $1 and i.observed_slot = slot.s',
      case when m.read_strategy = 'commerce_slot_sum'
           then format('sum(coalesce(i.%I, 0))', m.source_column)
           else format('count(*) filter (where coalesce(i.%I, 0) = 0)', m.source_column) end)
      into v_value, v_at using v_catalog, p_after;

  elsif m.read_strategy = 'support_first_response_minutes' then
    -- Сколько минут прошло от первого вопроса клиента до первого ответа. Считается только по
    -- ответам ПОСЛЕ горизонта — ответ, данный до решения, о решении ничего не говорит.
    with asked as (
      select min(created_at) at from public.messages
       where dialogue_id = v_dialogue and author = 'customer'
    )
    select extract(epoch from (min(r.created_at) - asked.at)) / 60, min(r.created_at)
      into v_value, v_at
      from public.messages r, asked
     where r.dialogue_id = v_dialogue and r.author = 'agent'
       and r.created_at >= asked.at and r.created_at > p_after
     group by asked.at;

  elsif m.read_strategy = 'support_status_count' then
    select count(*), max(d.updated_at) into v_value, v_at
      from public.dialogues d
      join public.agents a on a.id = d.agent_id
     where a.account_id = p_account_id and d.status = m.source_value and d.updated_at > p_after;
    -- Ноль диалогов в статусе — это измерение, а не отсутствие данных: считать его пропуском
    -- значило бы никогда не подтвердить «очередь разобрана».
    if v_value is not null then
      return jsonb_build_object('ok', true, 'value', v_value,
                                'observed_at', coalesce(v_at, now()), 'metric', p_metric);
    end if;

  else
    return jsonb_build_object('ok', false, 'reason', 'unknown_strategy', 'strategy', m.read_strategy);
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'reason', 'no_observation_after_horizon');
  end if;
  return jsonb_build_object('ok', true, 'value', v_value, 'observed_at', v_at, 'metric', p_metric);
end;
$$;

revoke all on function public.org_observe_metric(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.org_observe_metric(uuid, text, jsonb, timestamptz) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Первое наполнение
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Commerce переезжает как есть: те же пять ключей, что уже работали в цепочке if/elsif.
insert into public.org_metrics (key, domain, label, unit, subject_kind, read_strategy, source_column, is_wired) values
  ('commerce.sku.stock_total',        'commerce', 'Остаток товара',              'units', 'sku',     'commerce_snapshot_latest', 'stock_total',   true),
  ('commerce.sku.sold_units_7d',      'commerce', 'Продано за 7 дней',           'units', 'sku',     'commerce_snapshot_latest', 'sold_units_7d', true),
  ('commerce.sku.price_tiyin',        'commerce', 'Цена на витрине',             'tiyin', 'sku',     'commerce_snapshot_latest', 'price_tiyin',   true),
  ('commerce.catalog.sold_units_7d',  'commerce', 'Продажи каталога за 7 дней',  'units', 'catalog', 'commerce_slot_sum',        'sold_units_7d', true),
  ('commerce.catalog.skus_at_zero',   'commerce', 'Товаров с нулевым остатком',  'count', 'catalog', 'commerce_slot_count_zero', 'stock_total',   true)
on conflict (key) do nothing;

-- Поддержка — второй подключённый домен. Данные не обильные (два диалога), но канал настоящий:
-- Telegram подключён, dialogues и messages пишутся. Это ровно то различие, ради которого реестр
-- и заводился: «мало данных» и «нет канала» — разные вещи.
insert into public.org_metrics (key, domain, label, unit, subject_kind, read_strategy, source_value, is_wired) values
  ('support.dialogue.first_response_minutes', 'support', 'Время первого ответа', 'minutes', 'dialogue', 'support_first_response_minutes', null,             true),
  ('support.account.awaiting_operator',       'support', 'Ждут оператора',       'count',   'account',  'support_status_count',            'needs_operator', true)
on conflict (key) do nothing;

-- Остальные сферы система знает по имени и честно говорит, чего не хватает. Ни одна из них не
-- пройдёт регистрацию решения, пока причина не исчезнет.
insert into public.org_metrics (key, domain, label, unit, is_wired, unwired_reason) values
  ('crm.deals.closed',            'crm',       'Закрытых сделок',        'count',   false, 'Нет канала: сделки живут во внешней CRM, а коннектор только пишет наружу и не читает обратно.'),
  ('crm.deals.conversion',        'crm',       'Конверсия в сделку',     'percent', false, 'Нет канала: воронка ведётся во внешней CRM, обратного чтения нет.'),
  ('finance.cashflow',            'finance',   'Денежный поток',         'tiyin',   false, 'Нет канала: банковские выписки и 1С не подключены.'),
  ('finance.unpaid_invoices_age', 'finance',   'Возраст дебиторки',      'count',   false, 'Нет канала: счета не заводятся в Nemo и не читаются извне.'),
  ('marketing.roas',              'marketing', 'Возврат на рекламу',     'percent', false, 'Нет канала: рекламные кабинеты не подключены, расходы неизвестны.'),
  ('marketing.cac',               'marketing', 'Стоимость привлечения',  'tiyin',   false, 'Нет канала: нужны и расходы на рекламу, и источник заявки — нет ни того, ни другого.'),
  ('hr.time_to_hire',             'hr',        'Срок закрытия вакансии', 'count',   false, 'Нет канала: вакансии и кандидаты в Nemo не ведутся.')
on conflict (key) do nothing;

comment on table public.org_metrics is
  'Что система умеет измерять. is_wired = false означает «знаем о метрике, канала данных нет» — '
  'единственный способ говорить о сфере, не обещая измеримости.';
comment on column public.org_metrics.read_strategy is
  'Форма чтения, а не метрика. Метрика известной формы добавляется строкой; принципиально новая '
  'форма требует кода — это честный предел расширения.';
