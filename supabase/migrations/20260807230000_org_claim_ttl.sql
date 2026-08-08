-- Срок годности утверждения.
--
-- Первый живой прогон извлёк из отчёта «за последние 7 дней ни один товар не был продан» и
-- положил это в память навсегда. Утверждение было истинно неделю — и то по ошибке: в тот день
-- продажи читались нулём из-за бага, который мы починили позже. Вечное убеждение, выведенное из
-- моментального снимка, читается следующим прогоном как установленный факт и становится
-- основанием плана. Схема умела valid_until с самого начала; заполнять его было некому.
--
-- Опорное правило живёт в orgMemory.ts, где его можно протестировать: наблюдения стареют,
-- правила — нет. Здесь только возможность записать срок.

-- Снимаем старую сигнатуру целиком, а не добавляем параметр со значением по умолчанию: две
-- перегрузки с одинаковым префиксом аргументов — это вызов, который однажды уйдёт не туда.
drop function if exists public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[]);

create or replace function public.org_claim_record(
  p_account_id    uuid,
  p_statement     text,
  p_kind          text,
  p_subject       text,
  p_subject_key   text,
  p_source        text,
  p_source_detail jsonb default '{}'::jsonb,
  p_run_ref       uuid default null,
  p_audience      text default 'account',
  p_audience_ref  uuid default null,
  p_embedding     public.vector(384) default null,
  p_conflicts     uuid[] default '{}',
  p_valid_until   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_owner_conflict int;
  v_agent_conflict int;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Конфликтующие утверждения ищет вызывающий (это семантика), но проверяет их принадлежность
  -- аккаунту база: подсунутый чужой id не должен ни на что повлиять.
  select count(*) into v_owner_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id
     and c.status = 'active' and c.source = 'owner';

  -- Владелец старше. Агент не переписывает то, что сказал человек.
  if v_owner_conflict > 0 and p_source <> 'owner' then
    return jsonb_build_object('result', 'refused_owner_conflict', 'conflicts', v_owner_conflict);
  end if;

  insert into public.org_claims (
    account_id, statement, kind, subject, subject_key, source, source_detail,
    run_ref, audience, audience_ref, embedding, valid_until
  ) values (
    p_account_id, p_statement, p_kind, p_subject, p_subject_key, p_source,
    coalesce(p_source_detail, '{}'::jsonb), p_run_ref,
    coalesce(p_audience, 'account'), p_audience_ref, p_embedding, p_valid_until
  )
  returning id into v_id;

  -- Два несовместимых вывода агентов не разрешаются молча в пользу нового. Система сообщает,
  -- что верит в два противоречащих утверждения, и отдаёт выбор владельцу.
  select count(*) into v_agent_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id and c.status = 'active';

  if v_agent_conflict > 0 then
    update public.org_claims set status = 'disputed'
     where account_id = p_account_id and (id = any(p_conflicts) or id = v_id);
    return jsonb_build_object('result', 'disputed', 'id', v_id, 'with', v_agent_conflict);
  end if;

  return jsonb_build_object('result', 'inserted', 'id', v_id, 'valid_until', p_valid_until);
end;
$$;

revoke all on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[], timestamptz) to service_role;

-- Отзыв уже фильтрует по valid_until, так что истечение действует само собой и ничего чистить не
-- нужно. Индекс — чтобы фильтр не превращался в перебор, когда просроченных станет много.
create index if not exists org_claims_live_idx
  on public.org_claims (account_id, kind, subject_key, valid_until)
  where status = 'active';

comment on column public.org_claims.valid_until is
  'Когда наблюдение перестаёт быть свидетельством. Пусто только у правил: наблюдения стареют, '
  'правила — нет.';
