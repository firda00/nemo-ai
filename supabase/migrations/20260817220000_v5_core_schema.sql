-- Ядро схемы V5: собственная телефония и двусторонняя связь с CRM.
--
-- Соответствует §5 спецификации «Nemo AI V5 (Full Production Edition)» с ОДНИМ обязательным
-- отступлением, о котором надо знать заранее.
--
-- ОТСТУПЛЕНИЕ ОТ ТЗ: `references tenants(id)` заменено на `references public.accounts(id)`.
-- Таблицы `tenants` в этой базе НЕТ и никогда не было: тенантом здесь служит `public.accounts`, на
-- неё указывают 63 внешних ключа во всех существующих миграциях. Написать `references tenants(id)`
-- буквально — значит получить отказ применения миграции на первой же строке. ИМЕНА КОЛОНОК при этом
-- сохранены как в ТЗ (`tenant_id`), чтобы Zod-контракты V5 и SQL совпадали поле в поле и между ними
-- не понадобился переходник.
--
-- ЧТО ЗДЕСЬ ХРАНЯТ СЕКРЕТЫ. `telephony_trunks.auth_password_encrypted` и
-- `crm_integrations.credentials_encrypted` — это пароль SIP-регистрации и токены доступа к чужой CRM.
-- Оба поля называются *_encrypted, и это ТРЕБОВАНИЕ, а не пожелание: колонка обязана получать уже
-- зашифрованное значение. База сама шифровать не умеет и проверить не может, поэтому ответственность
-- на том, кто пишет. Утечка первого даёт возможность звонить за счёт владельца, утечка второго — читать
-- и менять его сделки.
--
-- ИЗОЛЯЦИЯ ТЕНАНТОВ. У всех четырёх таблиц RLS включён, и у каждой есть политика по
-- `public.current_account_id()`. Это отличается от таблиц-очередей (`sdr_jobs`, `nemo_api_tokens`), где
-- RLS включён БЕЗ политик и доступ только у service_role: там данные принадлежат платформе, здесь —
-- владельцу аккаунта, и он должен видеть свои звонки в интерфейсе.
--
-- ЖУРНАЛ ЗВОНКОВ ПИШЕТ ТОЛЬКО СЕРВЕР. `telephony_calls` и `crm_sync_logs` доступны владельцу на
-- ЧТЕНИЕ и недоступны на запись: это аудит. Клиент, способный переписать длительность звонка или
-- статус синхронизации, превращает аудит в декорацию.

-- ── 1. SIP-транки ────────────────────────────────────────────────────────────────────────────────

create table if not exists public.telephony_trunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  -- CUSTOM_SIP — транк владельца (BYON), NEMO_RENTED — номер, арендованный у платформы. Разница не
  -- косметическая: за второй платит и отвечает платформа, и правила отключения у них разные.
  trunk_type varchar(20) not null check (trunk_type in ('CUSTOM_SIP', 'NEMO_RENTED')),
  name varchar(64) not null check (length(btrim(name)) between 2 and 64),
  sip_host varchar(255) not null check (length(btrim(sip_host)) > 0),
  sip_port int not null default 5060 check (sip_port between 1 and 65535),
  auth_username varchar(128) not null,
  -- Уже зашифрованное значение. Базе нечем это проверить — см. заголовок файла.
  auth_password_encrypted text not null,
  -- E.164. Регексп тот же, что в SIPTrunkConfigSchema: номер, не прошедший его, не примет ни один
  -- оператор, и узнать об этом на первом же исходящем звонке дороже, чем на вставке строки.
  caller_id varchar(32) not null check (caller_id ~ '^\+?[1-9][0-9]{1,14}$'),
  -- Сколько одновременных разговоров разрешено. Превышение у оператора стоит денег или блокировки
  -- транка целиком, поэтому предел хранится рядом с транком, а не в настройках приложения.
  max_channels int not null default 5 check (max_channels between 1 and 1000),
  status varchar(20) not null default 'ACTIVE'
    check (status in ('ACTIVE', 'REGISTRATION_FAILED', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Два транка с одинаковым именем у одного владельца — гарантированная путаница в интерфейсе выбора
  -- транка для звонка. Между разными владельцами имена не конфликтуют.
  constraint telephony_trunks_name_unique unique (tenant_id, name)
);

create index if not exists telephony_trunks_tenant_idx on public.telephony_trunks (tenant_id);
-- Частичный индекс: планировщик исходящих звонков ищет только годные транки, и держать в индексе
-- отключённые незачем.
create index if not exists telephony_trunks_active_idx
  on public.telephony_trunks (tenant_id) where status = 'ACTIVE';

alter table public.telephony_trunks enable row level security;

drop policy if exists telephony_trunks_tenant on public.telephony_trunks;
create policy telephony_trunks_tenant on public.telephony_trunks for all
  using (tenant_id = public.current_account_id())
  with check (tenant_id = public.current_account_id());

-- ── 2. Журнал звонков ────────────────────────────────────────────────────────────────────────────

create table if not exists public.telephony_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  -- ON DELETE RESTRICT, а не CASCADE: удаление транка НЕ должно уносить историю звонков по нему.
  -- Записи звонков — основание для счетов и для разбора жалоб, и терять их вместе с настройкой
  -- подключения нельзя.
  trunk_id uuid not null references public.telephony_trunks(id) on delete restrict,
  direction varchar(10) not null check (direction in ('INBOUND', 'OUTBOUND')),
  customer_phone varchar(32) not null,
  caller_id varchar(32) not null,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  -- Причина завершения от SIP (NORMAL_CLEARING, USER_BUSY, NO_ANSWER…). Единственный способ отличить
  -- «не взяли трубку» от «оператор отклонил» — без неё оба выглядят как звонок нулевой длины.
  sip_hangup_cause varchar(64),
  recording_url text,
  -- Полная расшифровка репликами. JSONB, а не текст: по ней ищут и её разбирают по ролям.
  full_transcript jsonb,
  -- Разбор звонка по CallAnalyticsSchema. Валидность структуры обеспечивает Zod ДО записи; база
  -- хранит проверенный документ и не дублирует проверку — иначе они разойдутся при первой правке схемы.
  analytics jsonb,
  created_at timestamptz not null default now()
);

create index if not exists telephony_calls_tenant_created_idx
  on public.telephony_calls (tenant_id, created_at desc);
create index if not exists telephony_calls_trunk_idx on public.telephony_calls (trunk_id);
-- Поиск истории по номеру клиента: «о чём мы с ним говорили в прошлый раз» — первый вопрос менеджера
-- перед повторным звонком.
create index if not exists telephony_calls_phone_idx
  on public.telephony_calls (tenant_id, customer_phone);

alter table public.telephony_calls enable row level security;

-- ТОЛЬКО ЧТЕНИЕ для владельца. Журнал звонков — аудит и основание для счёта; клиент, способный
-- переписать длительность или подменить расшифровку, обесценивает и то, и другое. Пишет service_role.
drop policy if exists telephony_calls_tenant_read on public.telephony_calls;
create policy telephony_calls_tenant_read on public.telephony_calls for select
  using (tenant_id = public.current_account_id());

-- ── 3. Интеграции с CRM ──────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  provider varchar(20) not null check (provider in ('AMOCRM', 'HUBSPOT')),
  account_domain varchar(255) not null check (length(btrim(account_domain)) > 0),
  -- Токены доступа к чужой CRM, уже зашифрованные. JSONB, потому что у amoCRM и HubSpot разный набор
  -- полей (у первой long-lived token и subdomain, у второй access/refresh и portal id).
  credentials_encrypted jsonb not null,
  -- Соответствие «наш статус лида» → «стадия воронки в их CRM». Без него синхронизация складывает
  -- все сделки в первую попавшуюся стадию, и владелец видит кашу вместо воронки.
  stage_mappings jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Одна интеграция на провайдера у владельца: две записи для amoCRM означают два конкурирующих
  -- набора токенов, и какой из них применится — вопрос порядка строк.
  constraint unique_tenant_crm unique (tenant_id, provider)
);

create index if not exists crm_integrations_tenant_idx on public.crm_integrations (tenant_id);

alter table public.crm_integrations enable row level security;

drop policy if exists crm_integrations_tenant on public.crm_integrations;
create policy crm_integrations_tenant on public.crm_integrations for all
  using (tenant_id = public.current_account_id())
  with check (tenant_id = public.current_account_id());

-- ── 4. Аудит синхронизации ───────────────────────────────────────────────────────────────────────

create table if not exists public.crm_sync_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  /*
   * КЛЮЧ ИДЕМПОТЕНТНОСТИ — главное в этой таблице, и UNIQUE здесь несёт логику, а не гигиену.
   *
   * Вебхуки CRM приходят повторно: amoCRM переспрашивает при таймауте, HubSpot дублирует при
   * повторной доставке, а наш исходящий вызов повторяется при сетевом сбое. Без уникального ключа
   * повторная доставка создаёт ВТОРУЮ сделку по тому же звонку — и менеджер звонит одному человеку
   * дважды. Уникальность на уровне базы — единственная защита, которая работает при нескольких
   * воркерах одновременно: проверка «а нет ли уже такой записи» перед вставкой проигрывает гонку.
   */
  idempotency_key varchar(128) not null unique check (length(btrim(idempotency_key)) > 0),
  provider varchar(20) not null check (provider in ('AMOCRM', 'HUBSPOT')),
  -- INBOUND — событие пришло от CRM, OUTBOUND — мы отправили в CRM. Одна таблица на оба направления
  -- намеренно: разбираются они всегда вместе, по одной сделке и в одном порядке времени.
  direction varchar(10) not null check (direction in ('INBOUND', 'OUTBOUND')),
  payload jsonb not null,
  status varchar(20) not null default 'PROCESSED'
    check (status in ('PROCESSED', 'FAILED', 'RETRYING')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists crm_sync_logs_tenant_created_idx
  on public.crm_sync_logs (tenant_id, created_at desc);
-- Частичный индекс под разбор незавершённого: строк со статусом RETRYING всегда мало, и держать в
-- индексе успешные (то есть почти все) незачем.
create index if not exists crm_sync_logs_retry_idx
  on public.crm_sync_logs (created_at) where status = 'RETRYING';

alter table public.crm_sync_logs enable row level security;

-- Аудит: владельцу видно, менять нельзя. Пишет service_role.
drop policy if exists crm_sync_logs_tenant_read on public.crm_sync_logs;
create policy crm_sync_logs_tenant_read on public.crm_sync_logs for select
  using (tenant_id = public.current_account_id());

-- ── Автоматическое updated_at ────────────────────────────────────────────────────────────────────
--
-- Триггером, а не значением по умолчанию: default срабатывает только на вставке, и строка, изменённая
-- через год, продолжала бы показывать дату создания. По этому полю решают, когда перепроверять
-- регистрацию транка.

create or replace function public.v5_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists telephony_trunks_set_updated_at on public.telephony_trunks;
create trigger telephony_trunks_set_updated_at
  before update on public.telephony_trunks
  for each row execute function public.v5_touch_updated_at();

drop trigger if exists crm_integrations_set_updated_at on public.crm_integrations;
create trigger crm_integrations_set_updated_at
  before update on public.crm_integrations
  for each row execute function public.v5_touch_updated_at();
