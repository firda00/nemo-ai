import assert from 'node:assert/strict'
import {
  STALE_AFTER_HOURS,
  catalogueFreshness,
  staleCatalogues,
  brokenCatalogues,
  emptyNotice,
  hoursWord,
  staleHoursPhrase,
  staleWarningText,
} from '../supabase/functions/_shared/commerceFreshness.ts'

const NOW = new Date('2026-08-07T12:00:00.000Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const row = (over = {}) => ({
  catalog_id: 'cat-1',
  owner_account_id: 'acc-1',
  catalog_name: 'EVERLY Home',
  connected_at: hoursAgo(400),
  last_observed_at: hoursAgo(1),
  last_sync_error: null,
  ...over,
})

// ── The threshold ───────────────────────────────────────────────────────────────────────────────
// Three missed worker cycles. One hiccup must not wake the owner; twelve hours cannot be a hiccup.
assert.equal(STALE_AFTER_HOURS, 12)
assert.equal(STALE_AFTER_HOURS % 4, 0, 'the worker runs every four hours — the threshold is whole cycles')

// ── Fresh, stale, never ─────────────────────────────────────────────────────────────────────────
assert.equal(catalogueFreshness(row(), NOW).state, 'fresh')
assert.equal(catalogueFreshness(row({ last_observed_at: hoursAgo(11) }), NOW).state, 'fresh', 'one cycle short is not an outage')
assert.equal(catalogueFreshness(row({ last_observed_at: hoursAgo(12) }), NOW).state, 'stale', 'the boundary counts as stale')
assert.equal(catalogueFreshness(row({ last_observed_at: hoursAgo(30) }), NOW).state, 'stale')
assert.equal(catalogueFreshness(row({ last_observed_at: hoursAgo(30) }), NOW).hours, 30)

// A catalogue that has never produced a snapshot is not automatically broken — it may have been
// connected a minute ago, and alarming a seller mid-onboarding would teach them to ignore us.
assert.equal(catalogueFreshness(row({ last_observed_at: null, connected_at: hoursAgo(0.2) }), NOW).state, 'fresh')
assert.equal(catalogueFreshness(row({ last_observed_at: null, connected_at: hoursAgo(11) }), NOW).state, 'fresh')

// But a shop connected yesterday that has never yielded a single product is the more serious case:
// the seller believes they are being watched and nothing has ever been read. This is the state
// Vita Market Plus has been in, unreported.
const never = catalogueFreshness(row({ last_observed_at: null, connected_at: hoursAgo(26) }), NOW)
assert.equal(never.state, 'never')
assert.equal(never.hours, 26)

// A clock that disagrees with the database must not produce "не обновлялись -1 часов".
assert.equal(catalogueFreshness(row({ last_observed_at: new Date(NOW.getTime() + 90_000).toISOString() }), NOW).hours, 0)
assert.equal(catalogueFreshness(row({ last_observed_at: 'not a date' }), NOW).state, 'never', 'an unparsable stamp is not evidence of freshness')

// ── Only broken catalogues are reported ─────────────────────────────────────────────────────────
const mixed = [
  row({ catalog_id: 'a', catalog_name: 'EVERLY Home', last_observed_at: hoursAgo(1) }),
  row({ catalog_id: 'b', catalog_name: 'XALTA', last_observed_at: hoursAgo(20) }),
  row({ catalog_id: 'c', catalog_name: 'Vita Market Plus', last_observed_at: null, connected_at: hoursAgo(48) }),
]
const broken = staleCatalogues(mixed, NOW)
assert.equal(broken.length, 2, 'a healthy catalogue is not mentioned')
assert.deepEqual(broken.map((item) => item.catalogId), ['b', 'c'])

// ── Russian plurals ─────────────────────────────────────────────────────────────────────────────
// A broken plural reads as a broken system.
assert.equal(hoursWord(1), 'час')
assert.equal(hoursWord(2), 'часа')
assert.equal(hoursWord(4), 'часа')
assert.equal(hoursWord(5), 'часов')
assert.equal(hoursWord(11), 'часов', 'eleven is not "час" despite ending in one')
assert.equal(hoursWord(12), 'часов')
assert.equal(hoursWord(14), 'часов')
assert.equal(hoursWord(21), 'час')
assert.equal(hoursWord(22), 'часа')
assert.equal(hoursWord(25), 'часов')
assert.equal(hoursWord(0), 'часов')
assert.equal(hoursWord(101), 'час')
assert.equal(hoursWord(111), 'часов')
assert.equal(staleHoursPhrase(13), '13 часов')
assert.equal(staleHoursPhrase(21), '21 час')

// ── The message ─────────────────────────────────────────────────────────────────────────────────
assert.equal(staleWarningText([], { multiShop: false, allStale: false }), null, 'nothing wrong means nothing sent')

const single = staleWarningText(staleCatalogues([row({ last_observed_at: hoursAgo(14) })], NOW), { multiShop: false, allStale: true })
assert.match(single, /Синхронизация приостановлена/)
assert.match(single, /данные Uzum не обновлялись 14 часов/)
assert.match(single, /Проверьте API-ключ или статус кабинета/)
// The seller must not read the absence of numbers as calm.
assert.match(single, /цифры Nemo устарели/)
assert.doesNotMatch(single, /EVERLY/, 'one shop needs no label — naming it adds noise, not information')

// With several shops, naming the broken one is the difference between a useful warning and a scare.
const many = staleWarningText(broken, { multiShop: true, allStale: false })
assert.match(many, /XALTA/)
assert.match(many, /Vita Market Plus/)
assert.doesNotMatch(many, /EVERLY/, 'the healthy shop is never named')
assert.match(many, /не пришло ни одного товара/, 'never-synced reads differently from stopped-syncing')
assert.match(many, /не обновлялись 20 часов/)

// THE ONE THAT MATTERS FOR TRUST. One dead shop out of four does not make the other three
// untrustworthy. A watchdog that overstates the damage gets muted exactly like one that
// understates it — and this seller's live account is in precisely this state.
assert.match(many, /Остальные магазины обновляются нормально/)
assert.doesNotMatch(many, /цифры Nemo устарели/, 'a partial outage must not condemn healthy shops')
assert.match(single, /цифры Nemo устарели/)
assert.doesNotMatch(single, /Остальные магазины/, 'when everything is down there is no healthy remainder to reassure about')

// The stored Uzum error is quoted when there is one: "проверьте ключ" is a guess, "401" is an answer.
const withError = staleWarningText(staleCatalogues([row({ last_observed_at: hoursAgo(13), last_sync_error: '401 Unauthorized' })], NOW), { multiShop: false, allStale: true })
assert.match(withError, /401 Unauthorized/)

// Shop names come from Uzum and land in a Telegram HTML message.
const hostile = staleWarningText(
  staleCatalogues([row({ catalog_name: '<b>Shop</b> & Co', last_observed_at: hoursAgo(13) })], NOW),
  { multiShop: true, allStale: true },
)
assert.match(hostile, /&lt;b&gt;Shop&lt;\/b&gt; &amp; Co/)
assert.doesNotMatch(hostile, /<b>Shop<\/b>/, 'a shop name cannot inject markup into the warning')

// ── Пустой магазин — не авария ────────────────────────────────────────────────────────────────
// Владелец подключил Vita Market Plus и не завёл карточки. Сторож кричал 77 часов и был прав по
// своей логике — данных нет. Но «продавец ещё не начал» и «синхронизация сломалась» требуют
// разного, и тревога о первом была бы неправдой о том, что случилось.
const EMPTY_REASON = 'Uzum вернул 0 карточек по магазину 125704 — в кабинете нет товаров либо ключ не видит этот магазин.'
const emptyRow = (over = {}) => row({ last_observed_at: null, connected_at: hoursAgo(77), last_sync_error: EMPTY_REASON, ...over })

assert.equal(catalogueFreshness(emptyRow(), NOW).state, 'empty', 'причина известна из ответа Uzum')
assert.equal(catalogueFreshness(emptyRow({ last_sync_error: '401 Unauthorized' }), NOW).state, 'never',
  'иной отказ остаётся аварией, а не превращается в «магазин пустой»')
assert.equal(catalogueFreshness(emptyRow({ last_sync_error: null }), NOW).state, 'never',
  'без объяснения молчание остаётся молчанием')
// Свежеподключённый пустой магазин не трогаем вовсе: карточки могли не успеть появиться.
assert.equal(catalogueFreshness(emptyRow({ connected_at: hoursAgo(2) }), NOW).state, 'fresh')

// Подтверждённый владельцем выпадает из внимания совсем.
assert.equal(staleCatalogues([emptyRow()], NOW).length, 1, 'неподтверждённый пустой ещё виден')
assert.equal(staleCatalogues([emptyRow({ empty_confirmed_at: hoursAgo(1) })], NOW).length, 0,
  'владелец посмотрел кабинет — больше не наша забота')

// ГЛАВНОЕ: пустой магазин не попадает в тревогу ни при каких условиях.
const mixedWithEmpty = staleCatalogues([
  emptyRow({ catalog_id: 'e', catalog_name: 'Vita Market Plus' }),
  row({ catalog_id: 'b', catalog_name: 'XALTA', last_observed_at: hoursAgo(20) }),
], NOW)
assert.equal(mixedWithEmpty.length, 2)
assert.equal(brokenCatalogues(mixedWithEmpty).length, 1, 'в аварии остаётся только сломанный')
assert.equal(brokenCatalogues(mixedWithEmpty)[0].name, 'XALTA')
assert.doesNotMatch(
  staleWarningText(brokenCatalogues(mixedWithEmpty), { multiShop: true, allStale: false }) ?? '',
  /Vita Market Plus/, 'пустой магазин не называется в тревоге')

// Вежливая подсказка — вместо тревоги и ровно один раз.
const notice = emptyNotice(mixedWithEmpty, { multiShop: true })
assert.match(notice, /товаров пока нет/)
assert.match(notice, /Vita Market Plus/)
assert.doesNotMatch(notice, /XALTA/, 'подсказка не про сломанный магазин')
assert.match(notice, /Добавьте первые товары/)
assert.match(notice, /не ошибка/, 'сказано прямо, чтобы тишина не читалась как поломка')
assert.match(notice, /Больше об этом магазине не напомним/)

assert.equal(emptyNotice(staleCatalogues([emptyRow({ empty_notified_at: hoursAgo(2) })], NOW), { multiShop: false }), null,
  'вторая подсказка — спам')
assert.equal(emptyNotice(staleCatalogues([emptyRow({ empty_confirmed_at: hoursAgo(2) })], NOW), { multiShop: false }), null)
assert.equal(emptyNotice([], { multiShop: false }), null)
// Имя магазина приходит из Uzum и попадает в HTML-сообщение.
assert.match(
  emptyNotice(staleCatalogues([emptyRow({ catalog_name: '<b>Shop</b>' })], NOW), { multiShop: true }),
  /&lt;b&gt;Shop&lt;\/b&gt;/)

console.log('commerce freshness behaviour: all assertions passed')
