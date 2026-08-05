-- An account can have several connected Telegram bots. Storing only notify_chat_id left the
-- sender ambiguous: a digest could go out through a bot the owner never started a chat with,
-- which Telegram rejects, so nothing arrived and no delivery was recorded. Bind the chat to the
-- exact channel that received /start, and record which bot issued each deep link.
alter table public.business_profiles
  add column if not exists notify_channel_id uuid references public.channels(id) on delete set null;

alter table public.commerce_telegram_links
  add column if not exists channel_id uuid references public.channels(id) on delete set null;
