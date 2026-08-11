-- Ценовой совет с кнопками уходит ОДИН раз, а не каждое утро.
--
-- Своей отметки у него быть обязано: digest_sent_at ставится всей утренней сводке разом, а
-- alerted_at принадлежит критическим авариям. Без третьей отметки владелец получал бы одну и ту
-- же кнопку «Принять 58 750» каждый день, включая дни после того, как он её нажал.
alter table public.commerce_recommendations
  add column if not exists advice_sent_at timestamptz;

create index if not exists commerce_recommendations_advice_idx
  on public.commerce_recommendations (status, advice_sent_at)
  where advice_sent_at is null;
