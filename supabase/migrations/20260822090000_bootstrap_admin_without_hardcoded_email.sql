-- Убрать e-mail владельца из схемы и сделать выдачу первой админки явной операцией.
--
-- ЧТО БЫЛО. Триггер регистрации выдавал is_admin по совпадению с зашитым адресом:
--
--     insert into public.users (id, account_id, email, is_admin)
--     values (new.id, new_account, new.email, coalesce(new.email,'') = '<адрес владельца>');
--
-- Три беды сразу.
--
--   1. Адрес владельца лежит в схеме и уезжает в каждую копию платформы. Nemo — платформа, которую
--      разворачивают у себя; чужой e-mail в их базе не нужен никому.
--   2. Совпадение проверялось по НЕПОДТВЕРЖДЁННОМУ адресу. На установке с выключенным подтверждением
--      почты достаточно зарегистрироваться под этим адресом, чтобы стать администратором.
--   3. Выдача прав происходила молча, внутри триггера. По журналу видно регистрацию, а не то, что
--      вместе с ней выданы права на всю платформу.
--
-- ЧТО СТАЛО. Триггер больше НИКОГДА не выдаёт прав: is_admin = false для всех без исключения.
-- Первая админка выдаётся отдельным вызовом public.claim_platform_admin(uuid) — от владельца базы,
-- вручную, после подтверждения почты, и только пока администраторов нет вовсе.
--
-- ПОЧЕМУ НЕ ЧЕРЕЗ НАСТРОЙКУ current_setting('nemo.bootstrap_admin_email').
-- Это было первым замыслом, и он опаснее хардкода. Пользовательские параметры с незарегистрированным
-- префиксом в Postgres может выставить ЛЮБАЯ роль в своей сессии обычным SET/set_config, а
-- security definer меняет права выполнения, но сессионные параметры не сбрасывает. Проверка «адрес
-- совпал с параметром» превратилась бы в «адрес совпал с тем, что попросил сам заявитель».
--
-- СОВМЕСТИМОСТЬ. Строки public.users не трогаются: у кого админка есть — остаётся. Миграция
-- forward-only, ранее применённые не переписываются.

-- 1) Регистрация больше не раздаёт прав ----------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_account uuid;
  ref_code    text;
  ref_acc     uuid;
begin
  ref_code := upper(coalesce(new.raw_user_meta_data->>'ref', ''));
  insert into public.accounts (name, referral_code)
  values (coalesce(new.email, 'Nemo'), upper(substr(md5(new.id::text || random()::text), 1, 8)))
  returning id into new_account;

  -- is_admin ЯВНО false, а не «по умолчанию»: значение по умолчанию у столбца можно поменять
  -- следующей миграцией и не заметить, что вместе с ним поменялась выдача прав при регистрации.
  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, false);

  if ref_code <> '' then
    select id into ref_acc from public.accounts where referral_code = ref_code and id <> new_account limit 1;
    if ref_acc is not null then
      update public.accounts set referred_by = ref_acc where id = new_account;
    end if;
  end if;

  -- Подтверждённые при создании (OAuth) оплачиваются сразу, остальные — триггером подтверждения.
  if new.email_confirmed_at is not null then
    perform public.pay_referral_bonus(new_account);
  end if;

  return new;
end;
$$;

-- 2) Первая админка: один раз, вручную, по подтверждённой почте -----------------------------------

create or replace function public.claim_platform_admin(p_user_id uuid)
returns table (user_id uuid, email text, granted boolean, note text)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing int;
  target   record;
begin
  /*
   * ЗАМОК ДО ПОДСЧЁТА.
   *
   * Без него два одновременных вызова оба увидят «администраторов нет» и выдадут права дважды —
   * ровно то, что эта функция обязана исключать. Вызвать её может только владелец функции, так что
   * гонка маловероятна, но «одноразовость» либо гарантируется, либо её нет.
   *
   * Именно advisory, а не lock table public.users: блокировать таблицу пользователей значит
   * останавливать регистрации на время начальной установки.
   */
  perform pg_advisory_xact_lock(hashtext('nemo.claim_platform_admin'));

  -- ОДИН РАЗ. Пока администратор есть, эта функция не выдаёт прав никому: дальше администраторов
  -- назначает администратор, а не процедура начальной установки. Иначе «bootstrap» остаётся вечно
  -- открытой дверью, о которой через полгода никто не помнит.
  select count(*) into existing from public.users where is_admin;
  if existing > 0 then
    return query select p_user_id, null::text, false,
      'администратор уже есть — назначайте через существующего администратора'::text;
    return;
  end if;

  select u.id, u.email, a.email_confirmed_at
    into target
    from public.users u
    join auth.users a on a.id = u.id
   where u.id = p_user_id;

  if not found then
    return query select p_user_id, null::text, false, 'пользователя нет'::text;
    return;
  end if;

  -- ТОЛЬКО ПОДТВЕРЖДЁННЫЙ АДРЕС. Неподтверждённый — это заявка, а не доказательство: на установке с
  -- выключенной проверкой почты назваться можно кем угодно.
  if target.email_confirmed_at is null then
    return query select p_user_id, target.email, false, 'почта не подтверждена'::text;
    return;
  end if;

  update public.users set is_admin = true where id = p_user_id;
  return query select p_user_id, target.email, true, 'выдано'::text;
end;
$$;

/*
 * ПРАВА НА ВЫЗОВ.
 *
 * Новая функция по умолчанию получает execute у PUBLIC — то есть у всех, включая anon. Поэтому
 * revoke from public здесь обязателен и идёт первым; перечисление ролей после него — на случай, если
 * какой-то из них право выдали отдельно.
 *
 * Останется он у ВЛАДЕЛЬЦА ФУНКЦИИ (роли, от имени которой прогоняются миграции — в Supabase это
 * postgres) и у суперпользователя. Не у service_role: он ходит из Edge Functions, то есть из кода,
 * который правится чаще, чем пересматриваются права.
 *
 * Повторный `create or replace` права НЕ сбрасывает — ACL сохраняется. А вот `drop` + `create`
 * вернёт execute к PUBLIC, и revoke придётся повторить. Контракт в agent-hub/auth-rls-contracts.mjs
 * воспроизводит grant/revoke по всем миграциям по порядку именно ради этого случая.
 */
revoke all on function public.claim_platform_admin(uuid) from public;
revoke all on function public.claim_platform_admin(uuid) from anon, authenticated, service_role;

comment on function public.claim_platform_admin(uuid) is
  'Начальная выдача админки. Вызывается владельцем функции (ролью миграций), только по подтверждённой почте, только пока администраторов нет. Порядок: пользователь регистрируется и подтверждает почту → select * from public.claim_platform_admin(''<uuid>'');';
