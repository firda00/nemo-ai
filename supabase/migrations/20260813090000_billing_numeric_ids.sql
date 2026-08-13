-- Номер счёта и номер платежа — числами.
--
-- Не косметика. Click в своём протоколе работает целыми числами: merchant_trans_id он кладёт в
-- поле заказа, а merchant_prepare_id и merchant_confirm_id возвращает себе в журнал и сверяет как
-- числа. Uuid туда проходит по формату строки, но сертификацию не проходит, и на боевом контуре
-- это означает не «некрасиво», а «касса не подключится».
--
-- Второе, ради чего это стоит делать даже без Click: номер счёта видит человек. «Оплатите счёт
-- 100042» произносится по телефону и сверяется в выписке, а
-- «9329393e-b5ab-4f20-8b8f-ead0ad466148» — нет.
--
-- Uuid остаётся первичным ключом и внутренней ссылкой: он не угадывается перебором, и по нему
-- по-прежнему связаны все внешние ключи. Номер — вторая, публичная координата той же строки.

-- Начинаем с шестизначного: номера 1, 2, 3 выглядят как тестовые и в разговоре с покупателем
-- звучат так же.
create sequence if not exists public.billing_invoice_no_seq start with 100000;
create sequence if not exists public.billing_transaction_no_seq start with 100000;

alter table public.billing_invoices  add column if not exists invoice_no     bigint;
alter table public.billing_transactions add column if not exists transaction_no bigint;

alter table public.billing_invoices     alter column invoice_no     set default nextval('public.billing_invoice_no_seq');
alter table public.billing_transactions alter column transaction_no set default nextval('public.billing_transaction_no_seq');

alter sequence public.billing_invoice_no_seq     owned by public.billing_invoices.invoice_no;
alter sequence public.billing_transaction_no_seq owned by public.billing_transactions.transaction_no;

-- Строки, выставленные до этой миграции, получают номера тем же счётчиком. Пропуск оставил бы
-- счета без публичной координаты, и поиск по номеру молча не находил бы половину.
update public.billing_invoices     set invoice_no     = nextval('public.billing_invoice_no_seq')     where invoice_no is null;
update public.billing_transactions set transaction_no = nextval('public.billing_transaction_no_seq') where transaction_no is null;

alter table public.billing_invoices     alter column invoice_no     set not null;
alter table public.billing_transactions alter column transaction_no set not null;

-- Уникальность обязательна: номер — то, по чему касса находит счёт. Два счёта под одним номером
-- означают платёж, зачисленный не туда.
create unique index if not exists billing_invoices_no_key     on public.billing_invoices (invoice_no);
create unique index if not exists billing_transactions_no_key on public.billing_transactions (transaction_no);

/*
 * merchant_prepare_id больше не выдумывается отдельно.
 *
 * Раньше на Prepare генерировался случайный uuid и клался в merchant_prepare_id — то есть у
 * транзакции было два идентификатора, ни один из которых Click не принимает как число. Теперь
 * подготовку связывает с завершением сам номер транзакции: он уже уникален, уже числовой и уже
 * принадлежит ровно этой строке.
 *
 * Колонка остаётся ради истории: удалять то, чем отвечали провайдеру, значит терять улику в споре.
 */
comment on column public.billing_transactions.merchant_prepare_id is
  'Историческое поле. С 13.08.2026 подготовку с завершением связывает transaction_no.';
