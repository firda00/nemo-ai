-- min(uuid) в Postgres не существует.
--
-- Строка `select count(*), min(claim_id)` лежала в org_decision_resolve с первой миграции и ни
-- разу не выполнялась: решений не было, начислять свидетельство было нечему. Первый же настоящий
-- прогон резолвера уронил её с 42883.
--
-- Схемные проверки этого поймать не могли — они доказывали, что нельзя записать неизмеримое
-- ожидание и что исход не начисляется дважды, но ни одна не доходила до самого начисления.
-- Путь, который никто не исполнял, сломан по умолчанию.
create or replace function public.org_decision_resolve(
  p_decision_id uuid,
  p_outcome     text,
  p_observed    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_primary uuid;
  v_primaries int;
begin
  if p_outcome not in ('confirmed', 'refuted', 'unmeasurable') then
    raise exception using errcode = '22023', message = 'outcome must be confirmed, refuted or unmeasurable';
  end if;

  update public.org_decisions
     set outcome = p_outcome, observed = coalesce(p_observed, '{}'::jsonb), resolved_at = now()
   where id = p_decision_id and outcome = 'pending'
  returning account_id into v_account;

  if v_account is null then
    return jsonb_build_object('applied', false, 'reason', 'already_resolved_or_missing');
  end if;

  -- array_agg вместо min: у uuid нет порядкового агрегата, а порядок здесь и не нужен —
  -- строка ровно одна, иначе решение необучающее.
  select count(*), (array_agg(claim_id))[1] into v_primaries, v_primary
    from public.org_decision_claims
   where account_id = v_account and decision_id = p_decision_id and role = 'primary';

  if p_outcome = 'unmeasurable' or v_primaries <> 1 then
    return jsonb_build_object('applied', true, 'learned', false,
      'reason', case when p_outcome = 'unmeasurable' then 'unmeasurable' else 'no_single_primary' end);
  end if;

  update public.org_claims
     set evidence_for     = evidence_for     + case when p_outcome = 'confirmed' then 1 else 0 end,
         evidence_against = evidence_against + case when p_outcome = 'refuted'   then 1 else 0 end
   where id = v_primary and account_id = v_account;

  -- Снятие — не по среднему, а по накопленным свидетельствам: пять неудач подряд против одного
  -- слабого коррелированного наблюдения не должны весить одинаково.
  update public.org_claims
     set status = 'retired'
   where id = v_primary and account_id = v_account and status = 'active'
     and evidence_against >= 5 and confidence < 0.300;

  return jsonb_build_object('applied', true, 'learned', true, 'claim_id', v_primary);
end;
$$;

revoke all on function public.org_decision_resolve(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_resolve(uuid, text, jsonb) to service_role;
