-- Счёт — то, за что заплатили. Транзакция — то, чем заплатили. Это разные вещи.
--
-- Первый вариант схемы обходился одной таблицей транзакций с уникальностью
-- (provider, provider_transaction_id). Codex показал, чего она не защищает, и это не теория:
--
--   • Две попытки оплаты в Click дают РАЗНЫЕ click_trans_id при одном merchant_trans_id. Обе
--     проходят уникальность, обе завершаются, обе продлевают подписку. Один платёж — два периода.
--   • Тот же счёт можно оплатить дважды: один раз через Payme, другой через Click. Уникальность,
--     заведённая внутри провайдера, о втором провайдере не знает ничего.
--   • Два ретрая одного PerformTransaction оба увидят «строка уже есть, значит успех» и оба
--     продлят срок. Идемпотентность СТРОКИ не есть идемпотентность НАЧИСЛЕНИЯ.
--
-- Поэтому появляется счёт: единица того, что куплено. Начисление привязано к нему и случается
-- ровно один раз, чем бы и сколько раз за него ни платили.
create table if not exists public.billing_invoices (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,

  -- СНИМОК УСЛОВИЙ на момент выставления. Не ссылка на прайс: цена в справочнике завтра
  -- изменится, а покупатель заплатил по сегодняшней. Проверять сумму платежа надо против того,
  -- что он видел, а не против того, что стало.
  plan_code     text not null check (char_length(plan_code) between 1 and 40),
  amount_tiyin  bigint not null check (amount_tiyin > 0),
  currency      text not null default 'UZS' check (currency = 'UZS'),
  duration_days integer not null check (duration_days between 1 and 400),

  status        text not null default 'pending' check (status in ('pending', 'paid', 'cancelled', 'expired')),

  -- Единственная защита от двойного начисления. Не «признак оплаты», а отметка о том, что права
  -- УЖЕ выданы: только запрос, переводящий её из null, продлевает срок.
  entitlement_applied_at timestamptz,
  -- Что именно выдали. Без этого «продлили на месяц» — слова: при разборе спора нужно знать, до
  -- какой даты довели и от какой считали.
  applied_paid_until     timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Счёт, за который не заплатили, не должен ждать вечно: провайдер тоже закрывает свои.
  expires_at timestamptz not null default now() + interval '2 days',

  -- Выдали права — обязаны сказать, до какой даты. Одно без другого означает потерянную улику.
  constraint billing_invoices_applied_is_explained
    check ((entitlement_applied_at is null) = (applied_paid_until is null))
);

create index if not exists billing_invoices_account_idx on public.billing_invoices (account_id, created_at desc);
create index if not exists billing_invoices_open_idx on public.billing_invoices (status, expires_at) where status = 'pending';

alter table public.billing_invoices enable row level security;

-- Владелец видит свои счета: срок, сумма и статус — то, что он вправе проверить сам.
drop policy if exists billing_invoices_read on public.billing_invoices;
create policy billing_invoices_read on public.billing_invoices for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));
revoke insert, update, delete on public.billing_invoices from anon, authenticated;

/*
 * Условия счёта неизменны после выставления.
 *
 * Иначе защита по сумме бессмысленна: достаточно поправить amount_tiyin под пришедший платёж, и
 * проверка «сумма совпала» совпадёт с чем угодно. Менять разрешено только статус и отметки о
 * начислении — то есть ход исполнения, а не сам договор.
 */
create or replace function public.billing_invoices_freeze_terms()
returns trigger
language plpgsql
as $$
begin
  if new.account_id is distinct from old.account_id
     or new.plan_code is distinct from old.plan_code
     or new.amount_tiyin is distinct from old.amount_tiyin
     or new.currency is distinct from old.currency
     or new.duration_days is distinct from old.duration_days
  then
    raise exception 'invoice terms are immutable once issued (invoice %)', old.id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists billing_invoices_freeze on public.billing_invoices;
create trigger billing_invoices_freeze before update on public.billing_invoices
  for each row execute function public.billing_invoices_freeze_terms();

/*
 * Начисление прав по счёту. Ровно один раз, чем бы за него ни платили.
 *
 * Вся работа — в одной транзакции с блокировкой строки счёта. Два одновременных вызова: первый
 * берёт блокировку и переводит entitlement_applied_at из null, второй ждёт, видит уже
 * проставленную отметку и возвращает ТОТ ЖЕ результат, ничего не продлевая. Повтор — не ошибка:
 * провайдеры ретраят по протоколу, и ответ на ретрай обязан совпадать с ответом на оригинал.
 *
 * Арифметика срока:
 *   greatest(coalesce(paid_until, now()), now()) + N дней
 *
 * От now() всегда — крадёт остаток у того, кто продлил заранее: двадцать оставшихся дней плюс
 * тридцать купленных дали бы тридцать. От paid_until всегда — продлевает в прошлое тому, кто
 * вернулся после перерыва: платёж прошёл, а замок не открылся.
 */
create or replace function public.apply_invoice_entitlement(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_base    timestamptz;
  v_until   timestamptz;
begin
  select * into v_invoice from public.billing_invoices where id = p_invoice_id for update;

  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Уже начислено: возвращаем прежний ответ, не трогая срок. Это и есть точка, где ретрай
  -- перестаёт быть вторым платежом.
  if v_invoice.entitlement_applied_at is not null then
    return jsonb_build_object('ok', true, 'already_applied', true,
                              'paid_until', v_invoice.applied_paid_until,
                              'invoice_id', v_invoice.id);
  end if;

  if v_invoice.status = 'cancelled' or v_invoice.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'invoice_' || v_invoice.status);
  end if;

  -- Подписка блокируется тоже: два счёта одного аккаунта, начисляемые одновременно, иначе
  -- прочитали бы одно и то же paid_until и один затёр бы другой.
  insert into public.billing_subscriptions (account_id, status)
  values (v_invoice.account_id, 'trial')
  on conflict (account_id) do nothing;

  select greatest(coalesce(paid_until, pg_catalog.now()), pg_catalog.now())
    into v_base
    from public.billing_subscriptions
   where account_id = v_invoice.account_id
     for update;

  v_until := v_base + pg_catalog.make_interval(days => v_invoice.duration_days);

  update public.billing_subscriptions
     set status = 'active',
         paid_until = v_until,
         plan_code = v_invoice.plan_code,
         updated_at = pg_catalog.now()
   where account_id = v_invoice.account_id;

  update public.billing_invoices
     set status = 'paid',
         entitlement_applied_at = pg_catalog.now(),
         applied_paid_until = v_until
   where id = v_invoice.id and entitlement_applied_at is null;

  return jsonb_build_object('ok', true, 'already_applied', false,
                            'paid_until', v_until, 'invoice_id', v_invoice.id,
                            'granted_days', v_invoice.duration_days);
end;
$$;

revoke all on function public.apply_invoice_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.apply_invoice_entitlement(uuid) to service_role;

/*
 * Право на пробный период — за магазином, а не за почтой.
 *
 * Триал, привязанный к созданию аккаунта, обходится заведением новой почты каждые три дня: это
 * стоит ноль и повторяется бесконечно. Привязка к магазину Uzum поднимает цену обхода с «новый
 * ящик» до «другой настоящий магазин» и при этом не мешает никому из честных: свой магазин у
 * продавца один и тот же, под какой бы почтой он ни вошёл.
 */
create table if not exists public.billing_trial_claims (
  shop_id    text primary key check (char_length(shop_id) between 1 and 120),
  account_id uuid not null references public.accounts(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

create index if not exists billing_trial_claims_account_idx on public.billing_trial_claims (account_id);

alter table public.billing_trial_claims enable row level security;
revoke all on public.billing_trial_claims from anon, authenticated;

/*
 * Закрепляет магазин за аккаунтом. Первый успевший владеет им.
 *
 * Возвращает true, если магазин теперь за этим аккаунтом (и в том числе если был за ним раньше),
 * false — если он уже занят другим. Отказ здесь НЕ должен ломать подключение каталога: продавец
 * может подключать второй магазин, и это законно. Отказ означает лишь, что нового пробного
 * периода за этот магазин не будет.
 */
create or replace function public.claim_shop_trial(p_account_id uuid, p_shop_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_account_id is null or coalesce(p_shop_id, '') = '' then
    return false;
  end if;
  insert into public.billing_trial_claims (shop_id, account_id)
  values (p_shop_id, p_account_id)
  on conflict (shop_id) do nothing;

  select account_id into v_owner from public.billing_trial_claims where shop_id = p_shop_id;
  return v_owner = p_account_id;
end;
$$;

/*
 * Заслужил ли аккаунт пробный период.
 *
 * Аккаунт БЕЗ подключённого магазина триал получает: иначе новый продавец не смог бы даже
 * посмотреть продукт до подключения Uzum, а это первый экран онбординга.
 *
 * Аккаунт с магазином получает триал, только если магазин закреплён за ним. Магазин, уже
 * отработавший триал под другим аккаунтом, второго не даёт.
 */
create or replace function public.trial_allowed_for_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.commerce_catalogs c
      join public.billing_trial_claims t on t.shop_id = c.external_shop_id
     where c.account_id = p_account_id
       and t.account_id <> p_account_id
  );
$$;

revoke all on function public.claim_shop_trial(uuid, text) from public, anon, authenticated;
revoke all on function public.trial_allowed_for_account(uuid) from public, anon;
grant execute on function public.claim_shop_trial(uuid, text) to service_role;
grant execute on function public.trial_allowed_for_account(uuid) to service_role, authenticated;

-- Уже подключённые магазины закрепляются за своими аккаунтами: иначе первый же чужой аккаунт,
-- подключивший тот же магазин, отобрал бы у них право на триал.
insert into public.billing_trial_claims (shop_id, account_id, claimed_at)
select distinct on (c.external_shop_id) c.external_shop_id, c.account_id, c.created_at
from public.commerce_catalogs c
where coalesce(c.external_shop_id, '') <> ''
order by c.external_shop_id, c.created_at
on conflict (shop_id) do nothing;
