-- An alert had no way to stop being true. `dismissed` means the owner said no, `accepted` means
-- they acted, `expired` means it aged out — none of them fit "the margin recovered and Nemo no
-- longer raises this". So a price_guard row from a run before the margin model was corrected sat
-- open indefinitely, telling the owner to raise a price that no longer needed raising.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_status_check;

alter table public.commerce_recommendations
  add constraint commerce_recommendations_status_check
  check (status in ('open', 'dismissed', 'accepted', 'expired', 'resolved'));

alter table public.commerce_recommendations
  add column if not exists resolved_at timestamptz;

comment on column public.commerce_recommendations.resolved_at is
  'When a sync stopped raising this alert. Set by the worker, never by the owner — dismissed is the owner''s verb.';

-- Everything currently open was computed by the old margin model, which charged a returned unit
-- its full retail price. The next sync re-raises whatever is still true; leaving these open would
-- keep the corrected SKUs under an alert they have already cleared.
update public.commerce_recommendations
   set status = 'resolved', resolved_at = now()
 where status = 'open'
   and kind = 'price_guard';
