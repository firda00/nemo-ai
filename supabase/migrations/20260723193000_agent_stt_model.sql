-- Explicit STT engine selection for Telegram voice transcription.
alter table public.agents
  add column if not exists stt_model text not null default 'auto';

alter table public.agents
  drop constraint if exists agents_stt_model_check;

alter table public.agents
  add constraint agents_stt_model_check
  check (stt_model in ('auto', 'ovozify-whisper-small-uz', 'gemini-openrouter'));

