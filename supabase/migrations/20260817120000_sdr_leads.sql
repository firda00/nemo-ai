-- Хранилище лидов SDR-пайплайна (agent-hub/sdr-run.mjs).
--
-- Внутренний инструмент продаж Ustudy IT, а не данные арендатора платформы: доступ только
-- сервисным ключом из доверенного CLI-скрипта. RLS включён БЕЗ единой политики для anon/
-- authenticated намеренно — как и у прочих инфраструктурных таблиц этого проекта (worker lease
-- и подобные): нет политики значит нет доступа никому, кроме service_role.

create table if not exists public.sdr_leads (
  id uuid primary key default gen_random_uuid(),
  place_id text not null,
  dedupe_key text not null unique,
  name text not null,
  normalized_name text not null,
  city text not null,
  address text,
  phone text,
  website text,
  rating numeric,
  reviews integer,
  operational boolean not null default true,
  enrichment jsonb not null default '{}'::jsonb,
  score jsonb,
  found_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sdr_leads_dedupe_key_idx on public.sdr_leads (dedupe_key);
-- Статус лежит внутри score (jsonb), а не отдельной колонкой: он выводится из числа на стороне
-- кода (schemas.ts:statusFor), и хранить его дважды означало бы держать два источника истины.
create index if not exists sdr_leads_status_idx on public.sdr_leads (((score ->> 'status')));
create index if not exists sdr_leads_city_idx on public.sdr_leads (city);

alter table public.sdr_leads enable row level security;

create or replace function public.sdr_leads_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sdr_leads_set_updated_at on public.sdr_leads;
create trigger sdr_leads_set_updated_at
  before update on public.sdr_leads
  for each row execute function public.sdr_leads_touch_updated_at();
