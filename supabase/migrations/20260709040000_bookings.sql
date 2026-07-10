-- Internal bookings so a booking agent can ALWAYS schedule reliably (no hallucinated "записал"),
-- even when Google Calendar isn't connected. Written by the book_appointment tool. Service-role only.
create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid references public.accounts(id) on delete cascade,
  dialogue_id    uuid,
  customer_name  text,
  phone          text,
  service        text,
  scheduled_at   timestamptz,
  scheduled_text text,        -- the date/time exactly as the customer said (fallback / reference)
  notes          text,
  status         text not null default 'booked',
  created_at     timestamptz not null default now()
);
create index if not exists bookings_account_idx on public.bookings(account_id, created_at desc);
alter table public.bookings enable row level security;
