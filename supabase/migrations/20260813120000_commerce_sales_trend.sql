-- Находка нового вида: спрос упал или остановился.
--
-- Одно окно продаж не отличает медленный товар от умирающего. Два окна отличают, и это разные
-- дни для владельца: в первом случае делать нечего, во втором деньги лежат на складе, а покупатель
-- ушёл к соседу.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_kind_check;

alter table public.commerce_recommendations
  add constraint commerce_recommendations_kind_check
  check (kind in ('reorder', 'price_guard', 'missing_data', 'stockout', 'deadstock', 'sales_trend'));

comment on constraint commerce_recommendations_kind_check on public.commerce_recommendations is
  'sales_trend — падение или остановка продаж по сравнению с предыдущей неделей. Считается '
  'вычитанием двух окон (7 и 14 дней) и НЕ выставляется, когда любое из окон обрезано '
  'постраничной выборкой: разность двух неполных чисел выглядит как обвал.';
