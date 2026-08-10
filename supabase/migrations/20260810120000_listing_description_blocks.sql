-- Описание карточки перестало быть абзацем.
--
-- Продающая карточка на Uzum состоит из четырёх блоков: крючок, введение, преимущества буллетами,
-- характеристики. Восьмисот символов на это не хватает — предел ставился под «1-3 предложения» и
-- вместе с ними же и устарел.
--
-- Предел остаётся: строка без границы однажды приедет мегабайтом от сломавшейся модели. Просто он
-- теперь описывает тот текст, который мы действительно хотим получить.
alter table public.commerce_listing_drafts
  drop constraint if exists commerce_listing_drafts_description_ru_check,
  drop constraint if exists commerce_listing_drafts_description_uz_check;

alter table public.commerce_listing_drafts
  add constraint commerce_listing_drafts_description_ru_check
    check (char_length(description_ru) <= 2200),
  add constraint commerce_listing_drafts_description_uz_check
    check (char_length(description_uz) <= 2200);
