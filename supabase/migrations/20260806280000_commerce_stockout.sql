-- The reorder planner answers "when will this run out". It needs a week of history to know the
-- velocity, and until then it says nothing at all — while 94 of this seller's 140 SKUs are already
-- at zero. Two thirds of the catalogue is not sellable today, and no amount of history is needed
-- to see it: the stock came from Uzum this morning.
--
-- So a third kind of finding, which costs nothing to compute and is true from the first sync.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_kind_check;

alter table public.commerce_recommendations
  add constraint commerce_recommendations_kind_check
  check (kind in ('reorder', 'price_guard', 'missing_data', 'stockout'));

comment on constraint commerce_recommendations_kind_check on public.commerce_recommendations is
  'stockout: the SKU is at zero stock now. Independent of sales history, unlike reorder.';
