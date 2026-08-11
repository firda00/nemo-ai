-- Состояние доступа аккаунта. ТОЛЬКО состояние: ни платежей, ни провайдеров здесь нет.
--
-- Таблица транзакций и вебхуки Payme/Click ждут ревью Codex по правилу CLAUDE.md — на платёжном
-- контуре ошибка стоит денег клиента. Замку они не нужны: он спрашивает «оплачено ли», а не «чем
-- и когда заплатили».
create table if not exists public.billing_subscriptions (
  account_id     uuid primary key references public.accounts(id) on delete cascade,
  status         text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'cancelled')),
  plan_code      text,
  trial_ends_at  timestamptz,
  paid_until     timestamptz,
  -- Кто именно заплатил. Заполнится, когда появится платёжный модуль; пока служит тем, что
  -- фиксирует: провайдер будет не один.
  provider       text check (provider in ('payme', 'click')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.billing_subscriptions enable row level security;

-- Владелец видит свой срок — иначе «истекло» станет для него новостью в момент отказа.
drop policy if exists billing_subscriptions_read on public.billing_subscriptions;
create policy billing_subscriptions_read on public.billing_subscriptions for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));

-- Писать может только сервер. Продлить себе подписку из браузера нельзя.
revoke insert, update, delete on public.billing_subscriptions from anon, authenticated;

-- Существующие аккаунты получают триал от даты СВОЕГО создания, а не от сегодняшнего дня. Иначе
-- выкат биллинга подарил бы три свежих дня всем, включая тех, кто зарегистрировался в июле.
insert into public.billing_subscriptions (account_id, status, trial_ends_at)
select a.id, 'trial', a.created_at + interval '3 days'
from public.accounts a
on conflict (account_id) do nothing;
