-- Перенос карточки через расширение браузера: свой тумблер и свои причины отказа.
--
-- Тумблер ОТДЕЛЬНЫЙ от auto_submit_to_moderation намеренно. Это разные способы с разным риском:
-- официальный API живёт по договору с площадкой, расширение работает вашей сессией в кабинете и,
-- скорее всего, противоречит правилам продавца. Один переключатель на оба означал бы, что человек,
-- включивший автономию по API, незаметно для себя включил и автоматизацию кабинета.
alter table public.commerce_pilots
  add column if not exists auto_extension_submit boolean not null default false;

comment on column public.commerce_pilots.auto_extension_submit is
  'Перенос карточек в кабинет Uzum через расширение браузера. По умолчанию ВЫКЛЮЧЕН: способ '
  'вероятно нарушает правила продавца Uzum, и включать его человек должен сам, а не обнаружить '
  'включённым. Не путать с auto_submit_to_moderation — это официальный API.';

/*
 * Причины, с которыми возвращается расширение.
 *
 * human_needed — увидели капчу или незнакомый экран и остановились. Это ОТКАЗ, а не поломка:
 *   карточка цела, решение за владельцем.
 * form_changed — разметка кабинета разошлась с нашей: поле или кнопка не найдены.
 * selectors_missing — разметка ещё не заполнена вовсе.
 *
 * Хранятся в том же журнале, что и попытки через API. Две таблицы дали бы две несходящиеся
 * статистики «сколько карточек доехало», и складывать их пришлось бы руками.
 */
comment on column public.commerce_listing_submissions.reason is
  'Причина машинным словом. От API: no_write_access, provider_rejected, provider_unavailable, '
  'incomplete, not_ready, already_submitted, subscription_locked, no_key, not_owner. '
  'От расширения: human_needed, form_changed, selectors_missing.';
