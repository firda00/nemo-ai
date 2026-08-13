-- Отправка карточки в Uzum: выключатель и журнал попыток.
--
-- Отправки пока нет — внешние адреса создания товара Uzum закрывает 403 для ключа продавца
-- (проверено: 200 на рабочих маршрутах чтения, 403 на девяти адресах создания). Всё, что здесь
-- заводится, — контур ВОКРУГ отправки: чем она включается, что о каждой попытке остаётся и что
-- владелец прочитает вместо «ошибка».
--
-- Заводится это до самой отправки намеренно. Журнал, дописанный после того, как отправка
-- заработала, не помнит первых попыток — а именно первые и разбирают, когда карточка не доехала.

-- Режим отправки живёт у пилота: это уже строка на аккаунт, где хранится состояние коммерции.
alter table public.commerce_pilots
  add column if not exists auto_submit_to_moderation boolean not null default true;

comment on column public.commerce_pilots.auto_submit_to_moderation is
  'true — «Полная автономия»: готовая карточка уходит на модерацию сама. false — «Ручной '
  'контроль»: владелец подтверждает каждую в один клик. Значение по умолчанию true выбрано '
  'владельцем продукта; оно показывается при первом запуске, а не обнаруживается постфактум.';

/*
 * Журнал попыток отправки.
 *
 * Одна строка на попытку, а не на черновик: попыток бывает несколько, и разбирать спор
 * «почему товар не появился» приходится именно по ним. Ответ площадки хранится ЦЕЛИКОМ в том
 * виде, в каком пришёл, — пересказ ответа своими словами теряет ровно ту деталь, ради которой
 * в журнал и заглядывают.
 */
create table if not exists public.commerce_listing_submissions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.commerce_listing_drafts(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,

  -- Кто решил отправлять: тумблер или человек. Без этого нельзя отличить «автономия отправила
  -- не то» от «владелец отправил не то», а это разные разговоры.
  mode text not null check (mode in ('auto', 'manual')),
  -- Чем отправляли. Пока только официальный API; расширение появится здесь же, когда появится.
  transport text not null check (transport in ('uzum_api', 'extension')),

  -- refused — до площадки не дошли (не хватило данных, нет прав, замок подписки);
  -- failed — дошли, площадка отказала; sent — площадка приняла.
  status text not null check (status in ('refused', 'failed', 'sent')),
  http_status integer,
  -- Причина машинным словом: по ней считается статистика, не разбирая текст.
  reason text check (char_length(reason) <= 60),
  -- Ответ площадки как есть, обрезанный по длине, а не по смыслу.
  provider_response text check (char_length(provider_response) <= 4000),
  -- Что владелец увидел на экране. Хранится, чтобы через месяц не гадать, какими словами
  -- ему объяснили отказ.
  owner_message text check (char_length(owner_message) <= 600),

  external_product_id text check (char_length(external_product_id) <= 120),
  attempted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists commerce_listing_submissions_draft_idx
  on public.commerce_listing_submissions(draft_id, created_at desc);
create index if not exists commerce_listing_submissions_account_idx
  on public.commerce_listing_submissions(account_id, created_at desc);

alter table public.commerce_listing_submissions enable row level security;

-- Владелец видит свои попытки: это его товар и его отказы.
drop policy if exists commerce_listing_submissions_read on public.commerce_listing_submissions;
create policy commerce_listing_submissions_read on public.commerce_listing_submissions
  for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));
revoke insert, update, delete on public.commerce_listing_submissions from anon, authenticated;

/*
 * Отправленный черновик — отдельное состояние.
 *
 * 'ready' означает «владелец одобрил», и это не то же самое, что «ушло на модерацию»: между ними
 * стоит площадка, которая может и отказать. Одно состояние на оба смысла привело бы к повторным
 * отправкам одной карточки — она же «ready».
 */
alter table public.commerce_listing_drafts
  drop constraint if exists commerce_listing_drafts_status_check;
alter table public.commerce_listing_drafts
  add constraint commerce_listing_drafts_status_check
  check (status in ('draft', 'ready', 'discarded', 'submitted'));

alter table public.commerce_listing_drafts
  add column if not exists submitted_at timestamptz;

-- Прежнее правило говорило «ready ровно тогда, когда есть approved_at». Отправленная карточка
-- тоже одобрена — иначе её бы не отправили, — поэтому правило переписано на оба состояния.
alter table public.commerce_listing_drafts
  drop constraint if exists commerce_listing_drafts_check;
alter table public.commerce_listing_drafts
  add constraint commerce_listing_drafts_approved_is_explained
  check ((status in ('ready', 'submitted')) = (approved_at is not null));
