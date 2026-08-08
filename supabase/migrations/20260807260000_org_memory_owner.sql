-- Экран владельца: разрешение спора и достройка векторов.
--
-- Память, которую нельзя исправить, хуже отсутствующей: система верит во что-то, действует по
-- этому и не оставляет способа возразить. Отзыв у владельца уже был (org_claim_retire); не
-- хватало двух вещей — способа разрешить спор и гарантии, что сказанное владельцем вообще будет
-- найдено при отзыве.

-- Спор — это состояние, в которое система переводит два несовместимых вывода агентов, вместо того
-- чтобы молча выбрать один. Разрешает его человек: выбранное становится активным, а остальные
-- утверждения того же спора снимаются — иначе «разрешение» оставляло бы противоречие на месте.
create or replace function public.org_claim_affirm(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid := public.current_account_id();
  v_kind    text;
  v_subject text;
  v_retired int := 0;
begin
  if v_account is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;

  update public.org_claims
     set status = 'active',
         source_detail = source_detail || jsonb_build_object('affirmed_by', 'owner')
   where id = p_claim_id and account_id = v_account and status <> 'retired'
  returning kind, subject_key into v_kind, v_subject;

  if v_kind is null then
    return jsonb_build_object('affirmed', false, 'reason', 'not_found_or_retired');
  end if;

  update public.org_claims
     set status = 'retired',
         source_detail = source_detail || jsonb_build_object('retired_reason', 'спор разрешён владельцем в пользу другого утверждения')
   where account_id = v_account and id <> p_claim_id
     and status = 'disputed' and kind = v_kind and subject_key = v_subject;
  get diagnostics v_retired = row_count;

  return jsonb_build_object('affirmed', true, 'retired_rivals', v_retired);
end;
$$;

revoke all on function public.org_claim_affirm(uuid) from public, anon;
grant execute on function public.org_claim_affirm(uuid) to authenticated, service_role;

-- Утверждение без вектора невидимо для отзыва: match_org_claims фильтрует `embedding is not null`.
-- Слово владельца, потерявшееся из-за недоступного Supabase.ai, — худший вид потери, поэтому оно
-- записывается в любом случае, а вектор достраивается позже. Эта функция отдаёт очередь на
-- достройку; сам вектор считает воркер, у которого есть рантайм.
create or replace function public.org_claims_missing_embedding(p_limit int default 20)
returns table (id uuid, account_id uuid, statement text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.account_id, c.statement
    from public.org_claims c
   where c.embedding is null and c.status <> 'retired'
   order by c.created_at
   limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.org_claim_set_embedding(p_claim_id uuid, p_embedding public.vector(384))
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.org_claims set embedding = p_embedding
   where id = p_claim_id and embedding is null
  returning true;
$$;

revoke all on function public.org_claims_missing_embedding(int) from public, anon, authenticated;
grant execute on function public.org_claims_missing_embedding(int) to service_role;
revoke all on function public.org_claim_set_embedding(uuid, public.vector) from public, anon, authenticated;
grant execute on function public.org_claim_set_embedding(uuid, public.vector) to service_role;

create index if not exists org_claims_needs_embedding_idx
  on public.org_claims (created_at) where embedding is null and status <> 'retired';

comment on function public.org_claim_affirm(uuid) is
  'Владелец разрешает спор: выбранное становится активным, соперники по тому же предмету снимаются.';
