// Очистка и дедупликация лидов. Здесь решается, что попадёт в список продавца.
//
// Ошибка стоит дороже, чем кажется в обе стороны: пропущенный дубль — это второе холодное письмо
// тому же человеку от того же отправителя, а ошибочно отброшенная компания не появится в списке
// никогда, и никто не узнает, что её отбросили.

import assert from 'node:assert/strict'
import {
  dedupeKey,
  dropDuplicates,
  normalizeName,
  sanitizePlace,
  toE164,
} from '../supabase/functions/_shared/leadgen/sanitizer.ts'

// --- Название: что считается одной и той же компанией -------------------------------------------

// «ООО Ромашка», «Ромашка ООО» и «Ромашка» — одна клиника, и трёх писем ей слать нельзя.
assert.equal(normalizeName('ООО «Ромашка»'), 'ромашка')
assert.equal(normalizeName('Ромашка ООО'), 'ромашка')
assert.equal(normalizeName('  РОМАШКА  '), 'ромашка')
assert.equal(normalizeName('Дента-Люкс'), 'дента люкс', 'дефис в названии декоративен')
assert.equal(normalizeName('MCHJ "Dental Plus"'), 'dental plus')

// А вот цифры значимы: это разные адреса одной сети, и склеивать их значит потерять половину базы.
assert.notEqual(normalizeName('Дента 1'), normalizeName('Дента 2'))

// Название из одной правовой формы не должно превращаться в пустой ключ, общий для всех сразу.
assert.equal(normalizeName('ООО'), 'ооо')
assert.ok(normalizeName('ООО').length > 0)

// --- Телефон в E.164 ------------------------------------------------------------------------------

assert.equal(toE164('+998 90 123 45 67'), '+998901234567')
assert.equal(toE164('998901234567'), '+998901234567')
assert.equal(toE164('90 123 45 67'), '+998901234567', 'девять цифр — местный номер')
assert.equal(toE164('(90) 123-45-67'), '+998901234567')
assert.equal(toE164('00998901234567'), '+998901234567', 'двойной ноль — это тот же плюс')
// Местная восьмёрка перед кодом оператора — не код страны.
assert.equal(toE164('8 90 123 45 67'), '+998901234567')

// Код страны не угадывается: тот же набор цифр в другой стране — другой абонент.
assert.equal(toE164('90 123 45 67', '7'), '+7901234567')

for (const bad of ['', '   ', 'позвоните нам', '123', '+0123456789', null, undefined, '+', '00']) {
  assert.equal(toE164(bad), null, `не номер: ${JSON.stringify(bad)}`)
}

// --- Ключ дедупликации ------------------------------------------------------------------------------
// Не place_id: один бизнес заводится в справочнике дважды — переехал, сменил вывеску, — и у копий
// разные идентификаторы.

assert.equal(dedupeKey('ООО «Ромашка»', 'Ташкент'), dedupeKey('Ромашка', 'ташкент'))
assert.equal(dedupeKey('Ромашка', 'Ташкент').length, 64)
// Город не даёт склеить одноимённые клиники в разных городах.
assert.notEqual(dedupeKey('Дента', 'Ташкент'), dedupeKey('Дента', 'Самарканд'))

// --- Фильтр качества ---------------------------------------------------------------------------------

const good = {
  place_id: 'p1',
  name: 'Стоматология «Дента»',
  formatted_address: 'Ташкент, Амира Темура 15',
  international_phone_number: '+998 71 200 30 40',
  website: 'denta.uz',
  rating: 4.7,
  user_ratings_total: 128,
  business_status: 'OPERATIONAL',
}

const clean = sanitizePlace(good, 'Ташкент')
assert.equal(clean.ok, true)
assert.equal(clean.company.phone, '+998712003040')
assert.equal(clean.company.website, 'https://denta.uz/', 'адрес без схемы дополняется, а не отбрасывается')
assert.equal(clean.company.normalized_name, 'стоматология дента')
assert.equal(clean.company.operational, true)

// ОДНОГО КАНАЛА СВЯЗИ ДОСТАТОЧНО. Отсеивается только запись, по которой нельзя ни позвонить, ни
// написать: она и есть строка, создающая видимость работы. Раньше требовались ОБА канала, и это
// расходилось с замыслом фильтра — на открытых данных (OSM) требование обоих выбрасывало десятки
// компаний, которым можно звонить, а телефон для SDR обычно основной канал, а не дополнение.
{
  const phoneOnly = sanitizePlace({ ...good, website: undefined }, 'Ташкент')
  assert.equal(phoneOnly.ok, true, 'есть телефон — звонить можно, значит это лид')
  assert.equal(phoneOnly.company.website, null)
  assert.equal(phoneOnly.company.phone, '+998712003040')

  const siteOnly = sanitizePlace({ ...good, international_phone_number: undefined }, 'Ташкент')
  assert.equal(siteOnly.ok, true, 'есть сайт — написать можно, значит это лид')
  assert.equal(siteOnly.company.phone, null)
  assert.equal(siteOnly.company.website, 'https://denta.uz/')

  const neither = sanitizePlace({ ...good, international_phone_number: undefined, website: undefined }, 'Ташкент')
  assert.equal(neither.ok, false, 'ни телефона, ни сайта — связаться нечем')
  assert.equal(neither.reason, 'no_contacts')
}
assert.equal(sanitizePlace({ ...good, name: '  ' }, 'Ташкент').reason, 'no_name')

// Закрытый бизнес хуже пустого: по нему звонят, и звонок попадает человеку, который закрылся.
assert.equal(sanitizePlace({ ...good, business_status: 'CLOSED_PERMANENTLY' }, 'Ташкент').reason, 'closed')
assert.equal(sanitizePlace({ ...good, business_status: 'CLOSED_TEMPORARILY' }, 'Ташкент').reason, 'closed')
// Отсутствие статуса не равно «закрыт»: справочник его иногда не отдаёт вовсе.
assert.equal(sanitizePlace({ ...good, business_status: undefined }, 'Ташкент').ok, true)

// Профиль в чужом справочнике — не сайт компании: писать туда некуда. Такой адрес обнуляется, и
// запись держится на телефоне; если телефона тоже нет — отсеивается.
assert.equal(sanitizePlace({ ...good, website: 'https://business.site/denta' }, 'Ташкент').company.website, null)
assert.equal(sanitizePlace({ ...good, website: 'не сайт' }, 'Ташкент').company.website, null)
assert.equal(
  sanitizePlace({ ...good, website: 'https://business.site/denta', international_phone_number: undefined }, 'Ташкент').reason,
  'no_contacts',
  'заглушка справочника сайтом не считается — без телефона связаться нечем',
)

// Отказ ВСЕГДА называет причину: «нашли 12 из 50» без объяснения читается как поломка поиска.
const rejected = sanitizePlace({ ...good, international_phone_number: '', website: '' }, 'Ташкент')
assert.equal(rejected.ok, false)
assert.equal(rejected.place_id, 'p1', 'по отказу видно, какая именно запись отсеяна')

// --- Дубли внутри одной выдачи -------------------------------------------------------------------------
// Побеждает запись с большим числом отзывов: из двух карточек одной клиники живая та, где люди
// оставляли отзывы, а вторая обычно заброшенный дубль.

const first = sanitizePlace({ ...good, place_id: 'a', user_ratings_total: 12 }, 'Ташкент').company
const second = sanitizePlace({ ...good, place_id: 'b', user_ratings_total: 300 }, 'Ташкент').company
const other = sanitizePlace({ ...good, place_id: 'c', name: 'Клиника Смайл' }, 'Ташкент').company

const deduped = dropDuplicates([first, second, other])
assert.equal(deduped.unique.length, 2)
assert.equal(deduped.duplicates, 1)
assert.equal(deduped.unique.find((one) => one.normalized_name === 'стоматология дента').place_id, 'b',
  'осталась карточка с отзывами, а не первая попавшаяся')

assert.deepEqual(dropDuplicates([]), { unique: [], duplicates: 0 })

console.log('[OK] Leadgen sanitizer behaviour: 45 assertions')
