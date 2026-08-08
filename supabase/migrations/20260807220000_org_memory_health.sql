-- Отличить «памяти пока нет» от «память сломалась и молчит».
--
-- Отзыв утверждений деградирует мягко: не смог — вернул пустой список, прогон пошёл дальше. Это
-- верное поведение (прогон без памяти делает то, что делал вчера; упавший не делает ничего) и
-- оно же беззвучное. Пустой ответ выглядит одинаково в двух совершенно разных случаях: память
-- работает и пуста, или Supabase.ai недоступен и она не заработает никогда.
--
-- Ровно такой отказ мы вчера ловили в Commerce: тишина, читающаяся как спокойствие.
--
-- Ключевое наблюдение, на котором стоит вся конструкция: 'empty' — это УСПЕХ машинерии. Если
-- embedText отработал и запрос вернул ноль строк, путь жив. Сломано — это когда провалы есть,
-- а успехов нет ни одного.
create table if not exists public.org_memory_health (
  account_id  uuid not null references public.accounts(id) on delete cascade,
  day         date not null default (now() at time zone 'UTC')::date,

  -- Отзыв вернул утверждения.
  recalls_ok        integer not null default 0 check (recalls_ok >= 0),
  -- Отзыв отработал и не нашёл ничего. Не отказ: доказательство, что путь цел.
  recalls_empty     integer not null default 0 check (recalls_empty >= 0),
  -- Supabase.ai не отдал вектор. Тот самый случай, ради которого таблица и заведена.
  embed_failed      integer not null default 0 check (embed_failed >= 0),
  -- Вектор получен, но запрос к базе не прошёл.
  query_failed      integer not null default 0 check (query_failed >= 0),

  last_error     text,
  last_failed_at timestamptz,
  updated_at     timestamptz not null default now(),

  primary key (account_id, day)
);

alter table public.org_memory_health enable row level security;

drop policy if exists org_memory_health_read on public.org_memory_health;
create policy org_memory_health_read on public.org_memory_health for select
  using (account_id = public.current_account_id());

revoke insert, update, delete on public.org_memory_health from anon, authenticated;

create index if not exists org_memory_health_recent_idx
  on public.org_memory_health (day desc, account_id);

-- Один upsert на попытку отзыва. Дёшево: строка на аккаунт в сутки, и в режиме воркера отзыв
-- вообще один на прогон — остальные фазы работают от снимка.
create or replace function public.org_memory_health_record(
  p_account_id uuid,
  p_outcome    text,
  p_error      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_account_id is null or p_outcome not in ('ok', 'empty', 'embed_failed', 'query_failed') then
    return;
  end if;
  insert into public.org_memory_health as h (
    account_id, day, recalls_ok, recalls_empty, embed_failed, query_failed, last_error, last_failed_at
  ) values (
    p_account_id, (now() at time zone 'UTC')::date,
    case when p_outcome = 'ok' then 1 else 0 end,
    case when p_outcome = 'empty' then 1 else 0 end,
    case when p_outcome = 'embed_failed' then 1 else 0 end,
    case when p_outcome = 'query_failed' then 1 else 0 end,
    case when p_outcome like '%failed' then left(p_error, 300) end,
    case when p_outcome like '%failed' then now() end
  )
  on conflict (account_id, day) do update set
    recalls_ok     = h.recalls_ok     + excluded.recalls_ok,
    recalls_empty  = h.recalls_empty  + excluded.recalls_empty,
    embed_failed   = h.embed_failed   + excluded.embed_failed,
    query_failed   = h.query_failed   + excluded.query_failed,
    -- Последняя ошибка не затирается успехом: она нужна, чтобы объяснить утренний провал вечером.
    last_error     = coalesce(excluded.last_error, h.last_error),
    last_failed_at = coalesce(excluded.last_failed_at, h.last_failed_at),
    updated_at     = now();
end;
$$;

-- Сводка за окно, для сторожа. Считает по всем аккаунтам: недоступность Supabase.ai — отказ
-- платформы, а не одного арендатора, и увидеть его надо по первому же аккаунту, а не по всем.
create or replace function public.org_memory_health_window(p_days int default 2)
returns table (
  attempts bigint, successes bigint, empties bigint,
  embed_failures bigint, query_failures bigint,
  accounts_affected bigint, last_error text, last_failed_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select
    coalesce(sum(h.recalls_ok + h.recalls_empty + h.embed_failed + h.query_failed), 0),
    coalesce(sum(h.recalls_ok), 0),
    coalesce(sum(h.recalls_empty), 0),
    coalesce(sum(h.embed_failed), 0),
    coalesce(sum(h.query_failed), 0),
    count(*) filter (where h.embed_failed + h.query_failed > 0),
    (array_agg(h.last_error order by h.last_failed_at desc nulls last))[1],
    max(h.last_failed_at)
  from public.org_memory_health h
  where h.day >= ((now() at time zone 'UTC')::date - greatest(1, least(p_days, 30)));
$$;

revoke all on function public.org_memory_health_record(uuid, text, text) from public, anon, authenticated;
grant execute on function public.org_memory_health_record(uuid, text, text) to service_role;
revoke all on function public.org_memory_health_window(int) from public, anon, authenticated;
grant execute on function public.org_memory_health_window(int) to service_role;

comment on column public.org_memory_health.recalls_empty is
  'Отзыв отработал и ничего не нашёл. Это успех машинерии, а не отказ: именно он отличает пустую '
  'память от сломанной.';
