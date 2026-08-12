-- Транзакция — то, ЧЕМ заплатили. Счёт — то, ЗА ЧТО. Одна строка на попытку провайдера.
--
-- Начисление привязано к счёту и защищено там (entitlement_applied_at). Эта таблица нужна для
-- другого: помнить состояние конкретной попытки, чтобы отвечать провайдеру одинаково на повтор и
-- не создавать вторую транзакцию под тем же номером.
create table if not exists public.billing_transactions (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('payme', 'click')),

  -- Идентификатор ПРОВАЙДЕРА, не наш. У Payme это params.id, у Click — click_trans_id.
  provider_transaction_id text not null check (char_length(provider_transaction_id) between 1 and 120),

  invoice_id    uuid not null references public.billing_invoices(id) on delete restrict,
  account_id    uuid not null references public.accounts(id) on delete cascade,

  -- Сумма попытки. Хранится, чтобы повтор с изменившейся суммой был виден как чужая транзакция
  -- под знакомым номером, а не принят по старому успешному ответу.
  amount_tiyin  bigint not null check (amount_tiyin > 0),

  -- Состояния Payme: 1 создана, 2 выполнена, -1 отменена, -2 отменена после выполнения.
  -- Click живёт теми же числами: 1 после Prepare, 2 после Complete.
  state         integer not null default 1 check (state in (1, 2, -1, -2)),

  -- Своя часть Click: merchant_prepare_id, которым Complete связывается со своим Prepare.
  merchant_prepare_id text,

  cancel_reason integer,
  created_at    timestamptz not null default now(),
  performed_at  timestamptz,
  cancelled_at  timestamptz,

  -- Повтор запроса не создаёт вторую строку. Это ответ на ретраи провайдера, а НЕ защита от
  -- двойного начисления: двойное начисление ловится на счёте, потому что двух разных транзакций
  -- на один счёт эта уникальность не запрещает.
  unique (provider, provider_transaction_id)
);

create index if not exists billing_transactions_invoice_idx on public.billing_transactions (invoice_id);
create index if not exists billing_transactions_account_idx on public.billing_transactions (account_id, created_at desc);

-- ОДИН СЧЁТ — ОДНА ВЫПОЛНЕННАЯ ТРАНЗАКЦИЯ.
--
-- Вот та защита, которой уникальность по провайдеру не даёт: две попытки Click с разными
-- click_trans_id по одному счёту, или оплата одного счёта и через Payme, и через Click. Частичный
-- уникальный индекс делает вторую выполненную транзакцию невозможной на уровне базы.
create unique index if not exists billing_transactions_one_performed_per_invoice
  on public.billing_transactions (invoice_id) where state = 2;

alter table public.billing_transactions enable row level security;

-- Владелец видит свои платежи: сумму, дату и состояние. Это его деньги.
drop policy if exists billing_transactions_read on public.billing_transactions;
create policy billing_transactions_read on public.billing_transactions for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));
revoke insert, update, delete on public.billing_transactions from anon, authenticated;
