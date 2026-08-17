// Очистка и дедупликация. Модуль чистый: ни сети, ни базы, ни ключей.
//
// Здесь решается, что вообще считается лидом, — и ошибка стоит дороже, чем кажется. Пропущенный
// дубль означает второе холодное письмо тому же человеку от того же отправителя; ошибочно
// отброшенная компания не появится в списке никогда, и никто не узнает, что её отбросили.

import { createHash } from 'node:crypto'
// Импорт ТОЛЬКО ТИПОВ: он стирается при сборке, и модуль остаётся без единой зависимости —
// значит проверяется под Node построчно, вместе с граничными случаями телефонов и названий.
// Схема проверяет данные НА ГРАНИЦЕ системы, где они приходят снаружи, а не внутри чистой функции.
import type { CleanCompany, RawPlace } from './schemas.ts'

/**
 * Правовые формы и кавычки, которые не различают компании.
 *
 * «ООО Ромашка», «Ромашка ООО» и «Ромашка» — одна и та же клиника, и присылать ей три письма
 * нельзя. А вот цифры и латиница в названии значимы: «Дента 1» и «Дента 2» — разные адреса одной
 * сети, и склеивать их значит потерять половину базы.
 */
const LEGAL_FORMS = [
  'ооо', 'оао', 'зао', 'ип', 'чп', 'ао', 'нко', 'мчж', 'ykt', 'mchj', 'oav',
  'llc', 'ltd', 'inc', 'gmbh', 'co',
]

/** Название без регистра, кавычек, правовых форм и лишних пробелов. */
export function normalizeName(raw: string): string {
  const base = String(raw ?? '')
    .toLowerCase()
    .replace(/[«»"“”'’`]/g, ' ')
    // Пунктуация в названиях декоративна: «Дента-Люкс» и «Дента Люкс» — одна компания, и слать ей
    // два письма нельзя. Дефис и тире входят сюда наравне с точками.
    .replace(/[.,;:!?()\[\]/\\|\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = base.split(' ').filter((word) => word && !LEGAL_FORMS.includes(word))
  // Если от названия осталась пустота — оно состояло из одной правовой формы. Тогда честнее
  // вернуть исходное: «ООО» как имя компании плохо, но лучше, чем пустой ключ на всех сразу.
  return words.length ? words.join(' ') : base
}

/**
 * Телефон в E.164.
 *
 * Код страны берётся из аргумента, а не угадывается: узбекский номер «90 123 45 67» без кода
 * неотличим от российского мобильного, и ошибка здесь означает звонок не туда.
 */
export function toE164(raw: unknown, defaultCountryCode = '998'): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const digits = text.replace(/[^\d+]/g, '')
  if (!digits) return null

  // Уже с плюсом — доверяем как есть, только проверяем длину.
  if (digits.startsWith('+')) {
    const body = digits.slice(1).replace(/\D/g, '')
    return body.length >= 8 && body.length <= 15 && !body.startsWith('0') ? `+${body}` : null
  }

  let body = digits.replace(/\D/g, '')
  // Международный префикс 00 — тот же плюс, записанный иначе.
  if (body.startsWith('00')) body = body.slice(2)
  // Местная восьмёрка перед кодом оператора: «8 90 123…» это не код страны.
  else if (body.startsWith('8') && body.length === 10) body = defaultCountryCode + body.slice(1)
  else if (body.startsWith(defaultCountryCode) && body.length > 9) { /* уже с кодом страны */ }
  else if (body.length === 9) body = defaultCountryCode + body

  return body.length >= 8 && body.length <= 15 && !body.startsWith('0') ? `+${body}` : null
}

/**
 * Ключ дедупликации: имя плюс город.
 *
 * Не place_id. Один и тот же бизнес заводится в справочнике дважды — переехал, сменил вывеску,
 * добавил филиал той же вывеской, — и у копий разные идентификаторы. Ключ по смыслу склеивает их,
 * а город не даёт склеить «Дента» в Ташкенте с «Дента» в Самарканде.
 */
export function dedupeKey(name: string, city: string): string {
  return createHash('sha256')
    .update(`${normalizeName(name)}|${String(city ?? '').toLowerCase().trim()}`, 'utf8')
    .digest('hex')
}

export type RejectReason = 'no_contacts' | 'closed' | 'no_name'

export type SanitizeResult =
  | { ok: true; company: CleanCompany }
  | { ok: false; reason: RejectReason; place_id: string }

/**
 * Годится ли запись в работу.
 *
 * ДОСТАТОЧНО ОДНОГО КАНАЛА СВЯЗИ — телефона ИЛИ сайта. Отсеивается только запись, по которой
 * нельзя ни написать, ни позвонить: она и есть строка, создающая видимость работы.
 *
 * Раньше требовались ОБА канала, и это расходилось с собственным замыслом фильтра. С Google
 * расхождение почти не проявлялось — у него контакты заполнены плотно. На открытых данных
 * (OpenStreetMap) разница решающая: по замеру Ташкента из 181 точки телефон был у 48, сайт у 12, а
 * оба сразу — только у 11. Требование обоих выбрасывало 37 компаний, которым можно ЗВОНИТЬ, — а
 * телефон для SDR обычно и есть основной канал, а не дополнение к сайту.
 *
 * Компания без сайта остаётся полноценным лидом: обогащение по сайту — улучшение, а не условие
 * (enricher честно пометит `no_website` в failed), и модель оценит её по тому, что есть.
 *
 * Отказ ВОЗВРАЩАЕТСЯ С ПРИЧИНОЙ, а не глотается. «Нашли 12 из 50» без объяснения читается как
 * поломка поиска, хотя это может быть честный отсев.
 */
export function sanitizePlace(raw: RawPlace, city: string, defaultCountryCode = '998'): SanitizeResult {
  const name = String(raw?.name ?? '').trim()
  if (!name) return { ok: false, reason: 'no_name', place_id: String(raw?.place_id ?? '') }

  // Отсутствие статуса не равно «закрыт»: справочник его иногда не отдаёт вовсе.
  const operational = raw.business_status == null || raw.business_status === 'OPERATIONAL'
  if (!operational) return { ok: false, reason: 'closed', place_id: raw.place_id }

  const phone = toE164(raw.international_phone_number, defaultCountryCode)
  const website = normalizeWebsite(raw.website)
  // Ни телефона, ни сайта — связаться нечем, и в списке такая строка только мешает. Одного канала
  // достаточно: по телефону звонят, по сайту пишут.
  if (!phone && !website) return { ok: false, reason: 'no_contacts', place_id: raw.place_id }

  const company = {
    place_id: raw.place_id,
    name: name.slice(0, 300),
    normalized_name: normalizeName(name).slice(0, 300),
    city,
    dedupe_key: dedupeKey(name, city),
    address: raw.formatted_address?.slice(0, 500) ?? null,
    phone,
    website,
    rating: raw.rating ?? null,
    reviews: raw.user_ratings_total ?? null,
    operational: true,
  }
  return { ok: true, company }
}

/** Адрес сайта без мусора. Страница-заглушка справочника сайтом компании не считается. */
function normalizeWebsite(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`)
    if (!/^https?:$/.test(url.protocol)) return null
    // Профиль в чужом справочнике — не сайт компании: писать туда некуда.
    if (/^(business\.site|.*\.business\.site|maps\.google\.|goo\.gl)$/i.test(url.hostname)) return null
    return url.toString().slice(0, 300)
  } catch {
    return null
  }
}

/**
 * Отсев дублей внутри одной выдачи.
 *
 * Побеждает запись с БОЛЬШИМ числом отзывов: из двух карточек одной клиники живая та, где люди
 * оставляли отзывы, а вторая обычно заброшенный дубль с пустым телефоном.
 */
export function dropDuplicates(companies: CleanCompany[]): { unique: CleanCompany[]; duplicates: number } {
  const best = new Map<string, CleanCompany>()
  for (const company of companies) {
    const seen = best.get(company.dedupe_key)
    if (!seen || (company.reviews ?? 0) > (seen.reviews ?? 0)) best.set(company.dedupe_key, company)
  }
  return { unique: [...best.values()], duplicates: companies.length - best.size }
}
