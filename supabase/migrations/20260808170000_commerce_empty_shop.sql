-- Подтверждённо пустой магазин — это не авария.
--
-- Владелец посмотрел кабинет 125704: товаров там действительно нет. Сторож при этом честно кричал
-- 77 часов, и был прав по своей логике — данных нет. Но «продавец ещё не завёл карточки» и
-- «синхронизация сломалась» требуют разного: первое — вежливой подсказки один раз, второе —
-- тревоги, пока не починят.
--
-- ПОЧЕМУ НЕ status = 'paused'. В воркере стоит комментарий, что статус намеренно остаётся
-- 'active': и очередь, и claim-RPC выбирают только активные каталоги, поэтому пауза выбросила бы
-- магазин из синхронизации НАВСЕГДА — включая тот день, когда продавец добавит первый товар.
-- Шесть пустых вызовов в сутки стоят дешевле, чем магазин, который никогда не оживёт сам.
-- Меняется суждение, а не наблюдение.
alter table public.commerce_catalogs
  add column if not exists empty_confirmed_at timestamptz,
  add column if not exists empty_notified_at  timestamptz;

comment on column public.commerce_catalogs.empty_confirmed_at is
  'Владелец подтвердил, что в кабинете нет товаров. Снимается автоматически, когда товары '
  'появятся: магазин, который опустел ПОСЛЕ того как торговал, — это уже новость.';
comment on column public.commerce_catalogs.empty_notified_at is
  'Когда владельцу один раз предложили добавить первые товары. Вторая такая подсказка — спам.';

-- Отзыв свежести отдаёт то, что нужно для суждения: пустой подтверждённо, пустой ещё нет, или
-- сломанный. Раньше все три выглядели одинаково — «данных нет».
--
-- Через drop, а не create or replace: набор возвращаемых колонок меняется, и Postgres такого
-- замещения не допускает. Обе операции в одной транзакции миграции, поэтому окна без функции нет.
drop function if exists public.commerce_catalog_freshness(uuid[]);

create function public.commerce_catalog_freshness(p_account_ids uuid[])
returns table (
  catalog_id uuid,
  owner_account_id uuid,
  catalog_name text,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_observed_at timestamptz,
  last_sync_error text,
  stale_alerted_at timestamptz,
  empty_confirmed_at timestamptz,
  empty_notified_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.account_id,
    c.name,
    c.created_at,
    c.last_synced_at,
    (select max(s.observed_at)
       from public.commerce_inventory_snapshots s
       join public.commerce_skus k on k.id = s.sku_id
      where k.catalog_id = c.id),
    c.last_sync_error,
    c.stale_alerted_at,
    c.empty_confirmed_at,
    c.empty_notified_at
  from public.commerce_catalogs c
  where c.account_id = any(p_account_ids)
    and c.status = 'active'
  order by c.created_at, c.id
$$;

comment on function public.commerce_catalog_freshness(uuid[]) is
  'Свежесть каталога для сторожа: когда данные последний раз приходили, и отличается ли пустой '
  'магазин от сломанного.';

-- Владелец подтвердил 8 августа 2026, глядя в кабинет. Тревога снимается, наблюдение — нет.
update public.commerce_catalogs
   set empty_confirmed_at = now(),
       stale_alerted_at = null
 where external_shop_id = '125704' and status = 'active' and empty_confirmed_at is null;
