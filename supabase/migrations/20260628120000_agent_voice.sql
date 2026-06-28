-- Voice (TTS/STT) per agent — config only for now; synthesis activates when a
-- voice provider key is connected. Voice selection is chosen by the user.
alter table public.agents add column if not exists voice_enabled boolean not null default false;
alter table public.agents add column if not exists voice_mode    text;   -- tts | stt | both
alter table public.agents add column if not exists voice_id      text;   -- selected voice
