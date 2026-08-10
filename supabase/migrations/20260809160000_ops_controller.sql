-- Операционный контролёр: закрывает то, что можно закрыть однозначно, и следит за остальным.
--
-- Роль задумывалась шире — «ведает учётом, чинит хвосты, будит кампанию». Проверка живой базы
-- показала, что чинить нечего: подвисших прогонов, заданий, решений и векторов ровно ноль, а
-- напоминание о себестоимости уже стоит в утренней сводке. Единственный настоящий пробел —
-- просроченные предложения: два висели в pending четыре дня, потому что фонового задания на них
-- нет вовсе.
--
-- Поэтому контролёр вышел узким, и это честный размер, а не урезанный. Он делает ровно две вещи:
-- закрывает просроченное и считает остальное, чтобы «сегодня всё чисто» перестало быть
-- предположением. Инварианты сегодня нули — но узнать об обратном было неоткуда.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Что чинится однозначно
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Предложение с истёкшим сроком уже недействительно: apply_commerce_economics_proposal требует
-- expires_at > now(). Статус 'pending' у него — это не состояние, а забытая метка, и она врёт
-- владельцу в списке «ждёт вашей кнопки».
--
-- Ставится 'expired', а не 'rejected': владелец его не отклонял, у него вышло время. Ложный
-- ярлык в леджере — ровно то, от чего эта система избавляется.
create or replace function public.ops_sweep_stale()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_expired int;
begin
  update public.commerce_economics_proposals
     set status = 'expired'
   where status = 'pending' and expires_at < now();
  get diagnostics v_expired = row_count;
  return jsonb_build_object('proposals_expired', v_expired);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Что только считается
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Ни одна из этих категорий не чинится автоматически, и намеренно. У прогонов и заданий есть свои
-- лизы — вмешаться значило бы отобрать работу у живого воркера. Решение за горизонтом чинит
-- резолвер, вектор достраивает воркер памяти. Если счётчик перестал быть нулём, сломан ТОТ
-- механизм, и чинить надо его, а не последствие.
--
-- Истёкшие убеждения сюда не входят: отзыв их уже не видит, а на экране владельца они показаны
-- отдельным состоянием — это не долг, а история.
create or replace function public.ops_stuck_report()
returns table (kind text, stuck bigint, oldest_hours numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select 'proposals_overdue',
         count(*), round(max(extract(epoch from (now() - p.expires_at)) / 3600)::numeric, 1)
    from public.commerce_economics_proposals p
   where p.status = 'pending' and p.expires_at < now()
  union all
  select 'sync_runs_running',
         count(*), round(max(extract(epoch from (now() - r.claimed_at)) / 3600)::numeric, 1)
    from public.commerce_sync_runs r
   where r.status = 'running' and r.claimed_at < now() - interval '1 hour'
  union all
  select 'memory_jobs_processing',
         count(*), round(max(extract(epoch from (now() - o.claimed_at)) / 3600)::numeric, 1)
    from public.org_memory_outbox o
   where o.status = 'processing' and o.claimed_at < now() - interval '1 hour'
  union all
  select 'decisions_past_horizon',
         count(*), round(max(extract(epoch from (now() - d.horizon_at)) / 3600)::numeric, 1)
    from public.org_decisions d
   where d.outcome = 'pending' and d.horizon_at < now() - interval '2 hours'
  union all
  select 'claims_without_vector',
         count(*), round(max(extract(epoch from (now() - c.created_at)) / 3600)::numeric, 1)
    from public.org_claims c
   where c.embedding is null and c.status <> 'retired' and c.created_at < now() - interval '1 hour'
  union all
  select 'findings_open_over_week',
         count(*), round(max(extract(epoch from (now() - f.first_detected_at)) / 3600)::numeric, 1)
    from public.commerce_recommendations f
   where f.status = 'open' and f.first_detected_at < now() - interval '7 days';
$$;

revoke all on function public.ops_sweep_stale() from public, anon, authenticated;
grant execute on function public.ops_sweep_stale() to service_role;
revoke all on function public.ops_stuck_report() from public, anon, authenticated;
grant execute on function public.ops_stuck_report() to service_role;

comment on function public.ops_sweep_stale() is
  'Закрывает просроченные предложения. Единственное, что чинится однозначно: они уже недействительны, '
  'и pending у них — забытая метка, которая врёт владельцу.';
comment on function public.ops_stuck_report() is
  'Счётчики застрявшего. Ничего не чинит: у каждой категории есть свой механизм, и ненулевой '
  'счётчик означает поломку ТОГО механизма, а не необходимость убрать последствие.';
