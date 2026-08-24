-- Заявки с публичных форм /waitlist и экрана входа («запросить доступ»).
-- До этой таблицы формы молча выбрасывали контакты: submit ставил флажок «отправлено»
-- и ничего никуда не записывал — потерянные лиды с собственного лендинга.
--
-- Доступ только через Edge Function `waitlist` (service role): RLS включён БЕЗ политик
-- (та же схема, что sdr_jobs), прямые гранты у anon/authenticated отозваны.
create table if not exists public.waitlist_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null,
  phone text,
  company text,
  leads text,
  note text,
  source text not null default 'waitlist',
  ip_hash text,
  created_at timestamptz not null default now(),
  constraint waitlist_requests_name_check check (name is null or char_length(name) <= 200),
  constraint waitlist_requests_email_check check (char_length(email) between 3 and 320),
  constraint waitlist_requests_phone_check check (phone is null or char_length(phone) <= 200),
  constraint waitlist_requests_company_check check (company is null or char_length(company) <= 200),
  constraint waitlist_requests_leads_check check (leads is null or char_length(leads) <= 200),
  constraint waitlist_requests_note_check check (note is null or char_length(note) <= 1000),
  constraint waitlist_requests_source_check check (source in ('waitlist', 'auth', 'pricing')),
  constraint waitlist_requests_ip_hash_check check (
    ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'
  )
);

alter table public.waitlist_requests enable row level security;
revoke all on table public.waitlist_requests from anon, authenticated;

create index if not exists waitlist_requests_ip_created_idx
  on public.waitlist_requests (ip_hash, created_at desc);
create index if not exists waitlist_requests_email_idx
  on public.waitlist_requests (lower(email));

-- Атомарный приём заявки: advisory-lock на ip_hash делает проверку лимита и вставку одной
-- операцией (count-then-insert двумя запросами обгоняется параллельными сабмитами).
-- Лимит совещательный: ip приходит из заголовка прокси и полностью надёжным не считается.
create or replace function public.waitlist_submit(
  p_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_leads text,
  p_note text,
  p_source text,
  p_ip_hash text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
begin
  if p_email is null or char_length(p_email) not between 3 and 320 then
    raise exception using errcode = '22023', message = 'invalid email';
  end if;
  if p_source not in ('waitlist', 'auth', 'pricing') then
    raise exception using errcode = '22023', message = 'invalid source';
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid ip hash';
  end if;

  if p_ip_hash is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('waitlist:' || p_ip_hash, 0)
    );
  end if;
  -- Второй замок — на email: дедуп ниже иначе не атомарен для двух заявок с разных IP.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('waitlist-email:' || pg_catalog.lower(p_email), 0)
  );

  if p_ip_hash is not null then
    select count(*) into recent
      from public.waitlist_requests
      where ip_hash = p_ip_hash and created_at > pg_catalog.now() - interval '1 hour';
    if recent >= 5 then
      return 'rate_limited';
    end if;
  end if;

  -- Повторная отправка тем же email в течение суток — та же заявка (ретраи, двойной клик).
  if exists (
    select 1 from public.waitlist_requests
    where pg_catalog.lower(email) = pg_catalog.lower(p_email)
      and created_at > pg_catalog.now() - interval '24 hours'
  ) then
    return 'duplicate';
  end if;

  insert into public.waitlist_requests (name, email, phone, company, leads, note, source, ip_hash)
  values (p_name, p_email, p_phone, p_company, p_leads, p_note, p_source, p_ip_hash);
  return 'ok';
end;
$$;

revoke all on function public.waitlist_submit(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
-- revoke снял и дефолтный PUBLIC-грант — вернуть исполнение единственному законному вызывающему.
grant execute on function public.waitlist_submit(text, text, text, text, text, text, text, text)
  to service_role;
