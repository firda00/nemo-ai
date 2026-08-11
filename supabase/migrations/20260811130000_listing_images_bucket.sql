-- Приватный бакет для фотографий товара.
--
-- Приватный, а не публичный: фото нового товара — коммерческая тайна продавца до публикации, и
-- ссылка, которую можно угадать перебором, отдала бы его ассортимент кому угодно. Модель ходит за
-- картинкой по подписанному адресу, живущему минуты.
--
-- ВРЕМЕННЫЙ по смыслу: файл нужен ровно на время одной генерации. Уборка живёт отдельной задачей
-- (см. commerce_purge_listing_images ниже) — бакет, из которого никто не выносит мусор, растёт
-- молча и обнаруживается счётом за хранение.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-temp-images',
  'listing-temp-images',
  false,
  -- Восемь мегабайт: снимок с телефона проходит, а видео и сканы каталогов — нет.
  8 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Путь начинается с account_id — это и есть граница между арендаторами. Заголовок политики
-- сравнивает первый сегмент пути с аккаунтом пользователя, поэтому чужую папку не прочитать и
-- не пополнить, даже зная имя файла.
drop policy if exists listing_images_insert on storage.objects;
create policy listing_images_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'listing-temp-images'
    and (storage.foldername(name))[1] = (select u.account_id::text from public.users u where u.id = auth.uid())
  );

drop policy if exists listing_images_read on storage.objects;
create policy listing_images_read on storage.objects for select to authenticated
  using (
    bucket_id = 'listing-temp-images'
    and (storage.foldername(name))[1] = (select u.account_id::text from public.users u where u.id = auth.uid())
  );

drop policy if exists listing_images_delete on storage.objects;
create policy listing_images_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'listing-temp-images'
    and (storage.foldername(name))[1] = (select u.account_id::text from public.users u where u.id = auth.uid())
  );

/*
 * Уборка. Файл переживает генерацию на сутки — на случай повторной попытки — и удаляется.
 *
 * Сутки, а не час: владелец, у которого не получилось с первого раза, переделывает черновик в тот
 * же день, и заставлять его загружать фото заново значит наказывать за нашу же неудачу.
 */
create or replace function public.commerce_purge_listing_images(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  with gone as (
    delete from storage.objects
    where bucket_id = 'listing-temp-images'
      and created_at < now() - p_older_than
    returning 1
  )
  select count(*) into v_removed from gone;
  return v_removed;
end;
$$;

revoke all on function public.commerce_purge_listing_images(interval) from public, anon, authenticated;
grant execute on function public.commerce_purge_listing_images(interval) to service_role;
