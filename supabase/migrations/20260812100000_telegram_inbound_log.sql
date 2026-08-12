-- Что вообще приходит в вебхук. Форма сообщения, а не содержимое.
--
-- Три дня подряд фотография «не доходила», и отличить «Telegram не доставил» от «мы отбросили
-- раньше ветки» было нечем: tg_updates пишется только в очередной ветке, после нескольких ранних
-- выходов, а логи аналитики отстают на минуты и однажды уже заставили меня пять раз подряд
-- сказать владельцу неправду.
--
-- Эта таблица пишется ПЕРВЫМ действием после проверки подписи — до дедупа, до кнопок, до
-- очереди. Если строки нет, значит запроса не было. Другого толкования у пустоты здесь не
-- останется.
--
-- Содержимое не хранится: только флаги формы. Переписка владельца с ботом — его дело, и
-- диагностике достаточно знать, что пришло фото с подписью, а не что на нём написано.
create table if not exists public.tg_inbound_log (
  id          bigint generated always as identity primary key,
  channel_id  uuid not null references public.channels(id) on delete cascade,
  update_id   bigint,
  kind        text not null,
  has_photo   boolean not null default false,
  has_document boolean not null default false,
  has_voice   boolean not null default false,
  has_text    boolean not null default false,
  has_caption boolean not null default false,
  chat_id     text,
  received_at timestamptz not null default now()
);

create index if not exists tg_inbound_log_recent_idx on public.tg_inbound_log (received_at desc);

alter table public.tg_inbound_log enable row level security;
revoke all on public.tg_inbound_log from anon, authenticated;

-- Неделя. Диагностика, живущая вечно, превращается в свалку, а вопрос «дошло ли вчера» дольше
-- недели никто не задаёт.
create or replace function public.tg_inbound_log_purge(p_older_than interval default interval '7 days')
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.tg_inbound_log where received_at < pg_catalog.now() - p_older_than returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.tg_inbound_log_purge(interval) from public, anon, authenticated;
grant execute on function public.tg_inbound_log_purge(interval) to service_role;
