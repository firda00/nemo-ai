-- Оплата счёта должна давать и права, и квоты.
--
-- Замок на ИИ-функции читает billing_subscriptions, а лимиты по токенам и медиа — accounts.plan.
-- Это две разные оси, и до сих пор их заполняли разные системы: план ставил Stripe, подписку —
-- ничто. После Payme и Click получилось бы худшее из двух: замок открыт, а квоты остались
-- бесплатного тарифа, и клиент, заплативший вчера, упирается в лимит сегодня.
--
-- Счёт несёт plan_code с момента выставления, поэтому источник один и тот же — снимок условий.
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

  if v_invoice.entitlement_applied_at is not null then
    return jsonb_build_object('ok', true, 'already_applied', true,
                              'paid_until', v_invoice.applied_paid_until,
                              'invoice_id', v_invoice.id);
  end if;

  if v_invoice.status = 'cancelled' or v_invoice.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'invoice_' || v_invoice.status);
  end if;

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

  -- Квоты идут за подпиской. Тот же снимок, та же транзакция: план и срок не должны расходиться.
  update public.accounts
     set plan = v_invoice.plan_code
   where id = v_invoice.account_id;

  update public.billing_invoices
     set status = 'paid',
         entitlement_applied_at = pg_catalog.now(),
         applied_paid_until = v_until
   where id = v_invoice.id and entitlement_applied_at is null;

  return jsonb_build_object('ok', true, 'already_applied', false,
                            'paid_until', v_until, 'invoice_id', v_invoice.id,
                            'plan_code', v_invoice.plan_code,
                            'granted_days', v_invoice.duration_days);
end;
$$;
