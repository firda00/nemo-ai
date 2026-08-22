-- Касса Uzum Bank Merchant API v1.0.0.
--
-- ЧЕМ ЭТА КАССА ОТЛИЧАЕТСЯ ОТ PAYME И CLICK. У тех две фазы и один журнал —
-- billing_transactions. У Uzum четыре состояния (CREATED → CONFIRMED | REVERSED) и собственные
-- поля протокола: transTime, confirmTime, reverseTime, paymentSource, phone. Задание требует
-- отдельную таблицу под них, и это оправдано: складывать чужие поля в общий журнал значит
-- завести колонки, пустые у двух провайдеров из трёх.
--
-- НО ДЕНЕЖНЫЙ РЕЕСТР ОСТАЁТСЯ ОДИН. uzum_transactions — журнал ПРОТОКОЛА, billing_transactions —
-- реестр ПОПЫТОК ОПЛАТЫ, общий для всех касс. Обе строки создаются и меняются ОДНОЙ функцией в
-- одной транзакции: два последовательных запроса из Edge Function рано или поздно разойдутся —
-- сеть оборвётся между ними, — и тогда по одному журналу платёж есть, по другому нет.
--
-- НАЧИСЛЕНИЕ НЕ ПИШЕТСЯ ЗАНОВО. Права выдаёт apply_invoice_entitlement — та же функция, что у
-- Click и Payme: под блокировкой строки, идемпотентная, продлевающая от greatest(paid_until,
-- now()). Второй путь начисления означал бы вторую реализацию правила «месяц продлевается от
-- остатка, а не от сегодня», и разошлись бы они молча.
--
-- ORDER_ID — ЭТО НАШ INVOICE_NO. Ровно как merchant_trans_id у Click. Банк присылает номер
-- счёта, который покупатель видел; по нему сверяется сумма, срок и то, что счёт ещё не оплачен.

/* ─────────────────────────  Журнал протокола  ───────────────────────── */

create table if not exists public.uzum_transactions (
  id         uuid primary key default gen_random_uuid(),

  -- Идентификатор БАНКА. UUID в их протоколе, но хранится текстом: чужой формат идентификатора
  -- не наше дело, а uuid-колонка отвергла бы валидный для банка, но нестандартный для нас ключ.
  trans_id   text not null unique check (char_length(trans_id) between 1 and 120),

  -- То, что прислал банк в params.order_id. Хранится КАК ПРИШЛО, для разбора спора.
  order_id   text not null check (char_length(order_id) between 1 and 120),

  /*
   * Счёт, за который платят. НЕ NULL и restrict.
   *
   * Задание просило только account_id. Одного account_id мало: он говорит, чей это платёж, но не
   * говорит, за что. Без счёта нечего сверять — ни сумму, ни срок, ни то, что за него уже
   * заплатили, — и «оплата тарифа» сводится к «пришли деньги от этого аккаунта».
   */
  invoice_id uuid not null references public.billing_invoices(id) on delete restrict,
  account_id uuid not null references public.accounts(id) on delete cascade,

  -- В ТИЙИНАХ, как их присылает банк. Никаких пересчётов из сумов: Uzum, в отличие от Click,
  -- шлёт целое число тийинов, и умножение на сто здесь означало бы стократную сумму.
  amount     bigint not null check (amount > 0),

  status     text not null check (status in ('CREATED', 'CONFIRMED', 'REVERSED', 'FAILED')),
  service_id bigint not null,

  -- Отметки времени банка — epoch в миллисекундах, как в протоколе. Хранятся как пришли, чтобы
  -- ответ /status возвращал ровно то, что банк однажды получил.
  trans_time   bigint,
  confirm_time bigint,
  reverse_time bigint,

  payment_source text check (payment_source is null or char_length(payment_source) <= 60),
  phone          text check (phone is null or char_length(phone) <= 32),

  -- Тело запроса на создание. Именно create, а не последнее пришедшее: перезапись превратила бы
  -- улику в снимок последнего действия, а спорят обычно о том, с чего всё началось.
  raw_payload jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists uzum_transactions_invoice_idx on public.uzum_transactions (invoice_id);
create index if not exists uzum_transactions_account_idx on public.uzum_transactions (account_id, created_at desc);
create index if not exists uzum_transactions_order_idx on public.uzum_transactions (order_id);

/*
 * ОДНА ЖИВАЯ ТРАНЗАКЦИЯ НА СЧЁТ.
 *
 * unique(trans_id) не запрещает завести ВТОРУЮ транзакцию с другим transId на тот же счёт — а
 * это ровно тот случай, из-за которого в billing_invoices вообще появились счета: две попытки
 * оплаты, обе подтверждаются, один платёж даёт два периода. Начисление защищено на счёте, но
 * банк при этом получил бы два CONFIRMED и списал деньги дважды.
 *
 * Частичный: отменённые и провалившиеся не мешают заплатить снова.
 */
create unique index if not exists uzum_transactions_live_invoice_idx
  on public.uzum_transactions (invoice_id)
  where status in ('CREATED', 'CONFIRMED');

alter table public.uzum_transactions enable row level security;

/*
 * ЗАКРЫТА ПОЛНОСТЬЮ.
 *
 * Ни одной политики: при включённом RLS это означает «никому», а service_role RLS обходит. Так
 * же закрыт billing_transactions. Владельцу счета показывать здесь нечего — статус оплаты он
 * видит в billing_invoices, а телефон и источник платежа это данные банка, а не его кабинета.
 *
 * revoke сверх RLS не лишний: RLS не действует на владельца таблицы, и права выданные роли
 * напрямую пережили бы включение RLS незамеченными.
 */
revoke all on public.uzum_transactions from anon, authenticated;
grant all on public.uzum_transactions to service_role;

comment on table public.uzum_transactions is
  'Журнал протокола Uzum Bank Merchant API. Денежный реестр — billing_transactions, начисление — apply_invoice_entitlement.';

/* ─────────────────  Общий реестр знает о третьей кассе  ───────────────── */

alter table public.billing_transactions drop constraint if exists billing_transactions_provider_check;
alter table public.billing_transactions
  add constraint billing_transactions_provider_check check (provider in ('payme', 'click', 'uzum'));

alter table public.billing_subscriptions drop constraint if exists billing_subscriptions_provider_check;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_provider_check check (provider is null or provider in ('payme', 'click', 'uzum'));

/* ─────────────────────  Отмена уже начисленного  ───────────────────── */

-- Отметка о том, что права ОТОБРАНЫ. Отдельная от entitlement_applied_at, а не обнуление её:
-- обнулив, мы сделали бы счёт снова оплачиваемым и стёрли улику о том, что деньги приходили.
alter table public.billing_invoices add column if not exists entitlement_revoked_at timestamptz;

/*
 * Обратная операция к apply_invoice_entitlement.
 *
 * ЗАЧЕМ ОНА ВООБЩЕ. Uzum умеет /reverse ПОСЛЕ /confirm — банк возвращает деньги покупателю. Если
 * оставить подписку продлённой, отмена платежа становится способом получить тариф бесплатно.
 *
 * ПОЧЕМУ ВЫЧИТАЕТСЯ duration_days, А НЕ ВОССТАНАВЛИВАЕТСЯ ПРЕЖНЯЯ ДАТА. Между начислением и
 * отменой мог пройти ещё один платёж. Вернув сохранённое «было до», мы отобрали бы и его. Сложение
 * дней коммутативно, поэтому вычесть ровно свои дни правильно при любом порядке событий.
 *
 * ПОЧЕМУ НЕ НИЖЕ now(). Отрицательный остаток — это долг, которого в подписке нет: замок либо
 * открыт, либо закрыт. Уводя дату в прошлое дальше сегодняшнего дня, мы создали бы аккаунт,
 * который не откроется даже после следующей оплаты, пока не «отработает» минус.
 */
create or replace function public.revoke_invoice_entitlement(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_until   timestamptz;
  v_plan    text;
begin
  select * into v_invoice from public.billing_invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Повторная отмена ничего не отнимает второй раз.
  if v_invoice.entitlement_revoked_at is not null then
    return jsonb_build_object('ok', true, 'already_revoked', true, 'invoice_id', v_invoice.id);
  end if;

  -- Начисления не было — отменять нечего, счёт просто закрывается.
  if v_invoice.entitlement_applied_at is null then
    update public.billing_invoices
       set status = 'cancelled', entitlement_revoked_at = pg_catalog.now()
     where id = v_invoice.id;
    return jsonb_build_object('ok', true, 'already_revoked', false, 'granted_days', 0,
                              'invoice_id', v_invoice.id);
  end if;

  select pg_catalog.greatest(
           pg_catalog.now(),
           paid_until - pg_catalog.make_interval(days => v_invoice.duration_days)
         )
    into v_until
    from public.billing_subscriptions
   where account_id = v_invoice.account_id
     for update;

  if v_until is null then
    return jsonb_build_object('ok', false, 'reason', 'no_subscription');
  end if;

  -- Счёт закрывается ДО пересчёта тарифа: иначе он сам попадёт в выборку «какой тариф остался».
  update public.billing_invoices
     set status = 'cancelled', entitlement_revoked_at = pg_catalog.now()
   where id = v_invoice.id;

  /*
   * ТАРИФ ВОЗВРАЩАЕТСЯ К ПРЕДЫДУЩЕМУ ОПЛАЧЕННОМУ, А НЕ ОСТАЁТСЯ ОТМЕНЁННЫМ.
   *
   * Вычесть дни мало. Купили Starter, потом Business, Business вернули — дни сойдутся, а plan_code
   * останется Business, и покупатель продолжит пользоваться возможностями, за которые ему вернули
   * деньги. Берётся последний по времени начисления счёт, который начислен и НЕ отозван.
   *
   * Дни при этом вычитаются ровно свои: сложение коммутативно, поэтому порядок отмен на сумму
   * оставшихся дней не влияет.
   */
  select plan_code into v_plan
    from public.billing_invoices
   where account_id = v_invoice.account_id
     and entitlement_applied_at is not null
     and entitlement_revoked_at is null
   order by entitlement_applied_at desc
   limit 1;

  update public.billing_subscriptions
     set paid_until = v_until,
         /*
          * Срок кончился ровно сейчас — подписка больше не активна.
          *
          * Статус берётся из РАЗРЕШЁННОГО схемой набора (trial, active, past_due, cancelled).
          * Первая версия писала сюда 'expired' — значения, которого в ограничении нет, и возврат
          * подтверждённого платежа откатывался бы целиком на constraint violation. Проверка по
          * тексту такого не ловит: она видит слово, а не набор допустимых.
          */
         status = case when v_until <= pg_catalog.now() then 'cancelled' else 'active' end,
         plan_code = coalesce(v_plan, plan_code),
         updated_at = pg_catalog.now()
   where account_id = v_invoice.account_id;

  return jsonb_build_object('ok', true, 'already_revoked', false,
                            'granted_days', v_invoice.duration_days,
                            'plan_code', v_plan,
                            'paid_until', v_until, 'invoice_id', v_invoice.id);
end;
$$;

revoke all on function public.revoke_invoice_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.revoke_invoice_entitlement(uuid) to service_role;

/* ─────────────────────  Переходы состояний Uzum  ─────────────────────
 *
 * ВСЁ ДЕЛАЕТСЯ ЗДЕСЬ, А НЕ В EDGE FUNCTION. Между двумя запросами из функции может оборваться
 * связь, истечь время выполнения, приехать второй запрос того же банка. Проверка состояния,
 * перевод состояния и начисление обязаны быть одной транзакцией — иначе появляется окно, в
 * котором транзакция уже CONFIRMED, а права не выданы (или наоборот).
 *
 * Каждая функция возвращает jsonb: { ok, error_code, ... }. error_code — строка протокола Uzum,
 * и решение о ней принимается ТАМ, ГДЕ ВИДНО СОСТОЯНИЕ, а не в HTTP-слое по домыслу.
 */

/* Найти счёт по order_id. Номер или uuid — та же пара форм, что у invoiceRefFrom для Click. */
create or replace function public.uzum_find_invoice(p_order_id text)
returns public.billing_invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_text    text := pg_catalog.btrim(pg_catalog.coalesce(p_order_id, ''));
begin
  if v_text ~ '^[0-9]{1,18}$' then
    select * into v_invoice from public.billing_invoices where invoice_no = v_text::bigint;
  /*
   * UUID РАЗБИРАЕТСЯ ПО ТОЧНОЙ ФОРМЕ, а не «36 знаков из цифр, букв a-f и дефисов».
   *
   * Свободная форма пропускала строку из тридцати шести дефисов: она проходит проверку, а дальше
   * cast к uuid бросает исключение — и банк получает 99999 «внутренняя ошибка» там, где ответ
   * должен быть «такого счёта нет».
   */
  elsif v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_invoice from public.billing_invoices where id = v_text::uuid;
  end if;
  return v_invoice;
end;
$$;

revoke all on function public.uzum_find_invoice(text) from public, anon, authenticated;
grant execute on function public.uzum_find_invoice(text) to service_role;

/*
 * /check — можно ли платить по этому order_id.
 *
 * Сумму банк на этом шаге не присылает, поэтому проверяется всё остальное: счёт существует, не
 * оплачен, не отменён, не просрочен. Отвечать «ок» на закрытый счёт значит позволить банку
 * начать оплату, которую мы обязаны будем отклонить на /create, — покупатель увидит отказ уже
 * после того, как ввёл карту.
 */
create or replace function public.uzum_check_order(p_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
begin
  v_invoice := public.uzum_find_invoice(p_order_id);
  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10007');
  end if;
  if v_invoice.entitlement_applied_at is not null or v_invoice.status = 'paid' then
    return jsonb_build_object('ok', false, 'error_code', '10008');
  end if;
  if v_invoice.status in ('cancelled', 'expired') then
    return jsonb_build_object('ok', false, 'error_code', '10009');
  end if;
  if v_invoice.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error_code', '10009');
  end if;
  return jsonb_build_object('ok', true, 'invoice_id', v_invoice.id,
                            'account_id', v_invoice.account_id,
                            'amount', v_invoice.amount_tiyin,
                            'plan_code', v_invoice.plan_code);
end;
$$;

revoke all on function public.uzum_check_order(text) from public, anon, authenticated;
grant execute on function public.uzum_check_order(text) to service_role;

/*
 * /create — завести транзакцию под счёт.
 *
 * СУММА СВЕРЯЕТСЯ ЗДЕСЬ, и это главное, чего не было в задании. Без сверки достаточно создать
 * транзакцию на один тийин и подтвердить её, чтобы получить полный тариф: /confirm сам суммы не
 * знает, он лишь доводит до конца то, что создано. Код 10011 — штатный «неверная сумма».
 */
create or replace function public.uzum_create_transaction(
  p_trans_id   text,
  p_order_id   text,
  p_amount     bigint,
  p_service_id bigint,
  p_trans_time bigint,
  p_payment_source text,
  p_phone      text,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice   public.billing_invoices%rowtype;
  v_existing  public.uzum_transactions%rowtype;
  v_constraint text;
begin
  -- Повтор с тем же transId — раньше всего остального: банк ретраит, и ответ обязан быть тем же,
  -- каким бы ни стало состояние счёта с прошлого раза.
  select * into v_existing from public.uzum_transactions where trans_id = p_trans_id;
  if v_existing.id is not null then
    return jsonb_build_object('ok', false, 'error_code', '10010');
  end if;

  v_invoice := public.uzum_find_invoice(p_order_id);
  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10007');
  end if;

  /*
   * СЧЁТ БЛОКИРУЕТСЯ ДО ПРОВЕРОК, А НЕ ПОСЛЕ.
   *
   * uzum_find_invoice читает без блокировки. Между этим чтением и вставкой другой провайдер —
   * Payme или Click — успевает закрыть тот же счёт: наша транзакция всё равно станет CREATED, а
   * следующий /confirm упрётся в уже начисленный счёт и навсегда останется в CREATED. Повторное
   * чтение под блокировкой закрывает это окно.
   */
  select * into v_invoice from public.billing_invoices where id = v_invoice.id for update;

  if v_invoice.entitlement_applied_at is not null or v_invoice.status = 'paid' then
    return jsonb_build_object('ok', false, 'error_code', '10008');
  end if;
  if v_invoice.status in ('cancelled', 'expired') or v_invoice.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error_code', '10009');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> v_invoice.amount_tiyin then
    return jsonb_build_object('ok', false, 'error_code', '10011');
  end if;

  begin
    insert into public.uzum_transactions
      (trans_id, order_id, invoice_id, account_id, amount, status, service_id,
       trans_time, payment_source, phone, raw_payload)
    values
      (p_trans_id, p_order_id, v_invoice.id, v_invoice.account_id, p_amount, 'CREATED', p_service_id,
       p_trans_time, p_payment_source, p_phone, p_payload);

    -- Общий реестр пополняется ТОЙ ЖЕ транзакцией. state=1 — «создана», как у Payme и Click.
    insert into public.billing_transactions
      (provider, provider_transaction_id, invoice_id, account_id, amount_tiyin, state)
    values ('uzum', p_trans_id, v_invoice.id, v_invoice.account_id, p_amount, 1);
  exception
    /*
     * Гонка двух /create. Различается по ИМЕНИ ограничения, а не по повторному чтению.
     *
     * Первая версия ловила любой unique_violation и объявляла его «по брони уже есть транзакция».
     * Так под 10008 пряталось бы что угодно: сбитая последовательность, будущий индекс, чужое
     * ограничение. Банк получал бы осмысленный код на нашу поломку, и искать её стали бы у него.
     */
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'uzum_transactions_trans_id_key' then
        return jsonb_build_object('ok', false, 'error_code', '10010');
      elsif v_constraint = 'uzum_transactions_live_invoice_idx'
         or v_constraint = 'billing_transactions_provider_provider_transaction_id_key' then
        return jsonb_build_object('ok', false, 'error_code', '10008');
      end if;
      -- Незнакомое ограничение — наша поломка, и говорится об этом прямо.
      return jsonb_build_object('ok', false, 'error_code', '99999', 'reason', v_constraint);
  end;

  return jsonb_build_object('ok', true, 'invoice_id', v_invoice.id, 'amount', p_amount);
end;
$$;

revoke all on function public.uzum_create_transaction(text, text, bigint, bigint, bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.uzum_create_transaction(text, text, bigint, bigint, bigint, text, text, jsonb) to service_role;

/*
 * /confirm — деньги списаны, выдать права.
 *
 * Блокировка строки транзакции ПЕРВОЙ: одновременные /confirm и /reverse обязаны выстроиться в
 * очередь, иначе оба прочитают CREATED и оба выполнятся — деньги вернутся покупателю, а тариф
 * останется выданным.
 */
create or replace function public.uzum_confirm_transaction(
  p_trans_id text,
  p_confirm_time bigint,
  p_payment_source text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx      public.uzum_transactions%rowtype;
  v_invoice public.billing_invoices%rowtype;
  v_applied jsonb;
begin
  select * into v_tx from public.uzum_transactions where trans_id = p_trans_id for update;
  if v_tx.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10014');
  end if;
  if v_tx.status = 'CONFIRMED' then
    return jsonb_build_object('ok', false, 'error_code', '10016');
  end if;
  if v_tx.status in ('REVERSED', 'FAILED') then
    return jsonb_build_object('ok', false, 'error_code', '10015');
  end if;

  /*
   * СРОК СЧЁТА ПРОВЕРЯЕТСЯ ЗАНОВО, И ЭТО НЕ ПОВТОР ПРОВЕРКИ ИЗ /create.
   *
   * У транзакции нет собственного времени жизни: она висит CREATED, пока банк не придёт. Срок ей
   * задаёт счёт — а apply_invoice_entitlement на expires_at не смотрит вовсе, ей достаточно, что
   * начисления ещё не было. Без этой проверки транзакцию, созданную полгода назад по счёту,
   * который давно протух, можно подтвердить сегодня и получить тариф по прошлогодней цене.
   *
   * Просроченная переводится в FAILED здесь же: оставить её CREATED значит позволить банку
   * повторять попытку вечно.
   */
  select * into v_invoice from public.billing_invoices where id = v_tx.invoice_id for update;
  if v_invoice.id is null
     or v_invoice.status in ('cancelled', 'expired')
     or (v_invoice.entitlement_applied_at is null and v_invoice.expires_at <= pg_catalog.now())
  then
    update public.uzum_transactions
       set status = 'FAILED', updated_at = pg_catalog.now()
     where id = v_tx.id;
    update public.billing_transactions
       set state = -1, cancelled_at = pg_catalog.now()
     where provider = 'uzum' and provider_transaction_id = p_trans_id;
    return jsonb_build_object('ok', false, 'error_code', '10015', 'reason', 'invoice_expired');
  end if;

  v_applied := public.apply_invoice_entitlement(v_tx.invoice_id);
  if not (v_applied->>'ok')::boolean then
    -- Счёт закрылся между /create и /confirm. Права не выданы, и транзакция обязана это
    -- отразить: оставить её CREATED значит позволить банку повторять попытку вечно.
    update public.uzum_transactions
       set status = 'FAILED', updated_at = pg_catalog.now()
     where id = v_tx.id;
    update public.billing_transactions
       set state = -1, cancelled_at = pg_catalog.now()
     where provider = 'uzum' and provider_transaction_id = p_trans_id;
    return jsonb_build_object('ok', false, 'error_code', '10015', 'reason', v_applied->>'reason');
  end if;

  /*
   * Источник платежа и телефон дописываются ЗДЕСЬ.
   *
   * Банк присылает их на подтверждении, а не на создании: на /create он ещё не знает, чем
   * заплатят. Сохраняя только create-значения, мы получили бы две колонки, всегда пустые, — и
   * узнали бы об этом при первом же разборе спора, когда понадобится ответить «чем платили».
   *
   * coalesce, а не перезапись: повторный запрос без этих полей не должен стирать уже записанные.
   */
  update public.uzum_transactions
     set status = 'CONFIRMED',
         confirm_time = p_confirm_time,
         payment_source = coalesce(p_payment_source, payment_source),
         phone = coalesce(p_phone, phone),
         updated_at = pg_catalog.now()
   where id = v_tx.id;
  update public.billing_transactions
     set state = 2, performed_at = pg_catalog.now()
   where provider = 'uzum' and provider_transaction_id = p_trans_id;

  return jsonb_build_object('ok', true, 'amount', v_tx.amount, 'order_id', v_tx.order_id,
                            'paid_until', v_applied->>'paid_until');
end;
$$;

revoke all on function public.uzum_confirm_transaction(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.uzum_confirm_transaction(text, bigint, text, text) to service_role;

/*
 * /reverse — деньги возвращены покупателю.
 *
 * Отменяется и ПОДТВЕРЖДЁННАЯ транзакция: банк это умеет, и оставить в такой момент подписку
 * продлённой значит сделать возврат способом получить тариф даром.
 */
create or replace function public.uzum_reverse_transaction(p_trans_id text, p_reverse_time bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx      public.uzum_transactions%rowtype;
  v_revoked jsonb := '{}'::jsonb;
begin
  select * into v_tx from public.uzum_transactions where trans_id = p_trans_id for update;
  if v_tx.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10014');
  end if;
  if v_tx.status = 'REVERSED' then
    return jsonb_build_object('ok', false, 'error_code', '10018');
  end if;
  -- Провалившуюся отменять нечего: денег по ней не было. Штатный код именно для этого — 10017.
  if v_tx.status = 'FAILED' then
    return jsonb_build_object('ok', false, 'error_code', '10017');
  end if;

  if v_tx.status = 'CONFIRMED' then
    v_revoked := public.revoke_invoice_entitlement(v_tx.invoice_id);
    if not (v_revoked->>'ok')::boolean then
      return jsonb_build_object('ok', false, 'error_code', '99999', 'reason', v_revoked->>'reason');
    end if;
  else
    -- Не подтверждённую отменяем вместе со счётом: покупатель ушёл, счёт больше не ждёт оплаты.
    update public.billing_invoices
       set status = 'cancelled'
     where id = v_tx.invoice_id and entitlement_applied_at is null;
  end if;

  update public.billing_transactions
     set state = case when v_tx.status = 'CONFIRMED' then -2 else -1 end,
         cancelled_at = pg_catalog.now()
   where provider = 'uzum' and provider_transaction_id = p_trans_id;

  update public.uzum_transactions
     set status = 'REVERSED', reverse_time = p_reverse_time, updated_at = pg_catalog.now()
   where id = v_tx.id;

  return jsonb_build_object('ok', true, 'amount', v_tx.amount, 'order_id', v_tx.order_id,
                            'reverted_days', v_revoked->>'granted_days');
end;
$$;

revoke all on function public.uzum_reverse_transaction(text, bigint) from public, anon, authenticated;
grant execute on function public.uzum_reverse_transaction(text, bigint) to service_role;
