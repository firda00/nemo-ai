-- A snapshot that lost half its page still read as a complete one. The bridge already returns
-- whether it truncated, but only to the extension, in the moment — nothing survived to the row an
-- agent reads hours later. The tariff capture that started this is stored at exactly 8000
-- characters with its last sentence cut in half, and nothing in the row says so.
alter table public.browser_observations
  add column if not exists total_length integer;

comment on column public.browser_observations.total_length is
  'Characters the page actually held. Greater than length(body_text) means this observation is partial.';
