-- Категории Uzum по-русски.
--
-- Uzum отдаёт ОДНО имя полки, узбекское: в товарном ответе есть `category` и нет ни `categoryRu`,
-- ни локали. Значит взять русское имя неоткуда, и «забирать оба языка при синхронизации» —
-- не вариант реализации, а несуществующая возможность.
--
-- Остаётся перевод. Он делается один раз на полку и кладётся сюда: у продавца их дюжина, у
-- платформы будут сотни, и переводить одно и то же на каждый рендер списка — трата и модели, и
-- времени владельца.
--
-- КЛЮЧОМ ОСТАЁТСЯ УЗБЕКСКОЕ ИМЯ. Оно приходит от Uzum, по нему сходятся товары, по нему
-- считается комиссия, оно лежит в черновиках. Перевод — только подпись на экране: полка,
-- сменившая имя из-за нового перевода, разошлась бы со своими же товарами.
create table if not exists public.commerce_category_labels (
  category   text primary key check (char_length(category) between 1 and 160),
  label_ru   text check (char_length(label_ru) between 1 and 160),
  label_en   text check (char_length(label_en) between 1 and 160),

  -- Кто назвал. Перевод модели можно молча заменить, слово владельца — нет.
  source     text not null default 'model' check (source in ('model', 'owner')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.commerce_category_labels enable row level security;

-- Справочник платформенный, а не арендаторский: полки Uzum одни и те же для всех продавцов, и
-- перевод, купленный на одном аккаунте, не должен покупаться заново на каждом следующем.
drop policy if exists commerce_category_labels_read on public.commerce_category_labels;
create policy commerce_category_labels_read on public.commerce_category_labels
  for select to authenticated using (true);
revoke insert, update, delete on public.commerce_category_labels from anon, authenticated;
