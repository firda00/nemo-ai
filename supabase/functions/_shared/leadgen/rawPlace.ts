// Приведение сырой записи к форме RawPlace. Отдельный модуль, а не часть placesSearch.ts, чтобы
// источники поиска (Google, файл, Overpass) могли им пользоваться, не импортируя друг друга:
// иначе overpassSearch → placesSearch → overpassSearch замыкается в кольцо.

import type { RawPlace } from './schemas.ts'

/**
 * Сырая запись → RawPlace.
 *
 * Числа приходят по-разному: от Google числом, из CSV строкой, из OSM их нет вовсе. Приведение
 * здесь одно на все источники, чтобы «4.5» и 4.5 не расходились дальше по пайплайну.
 */
export function toRawPlace(source: Record<string, unknown>): RawPlace {
  const rating = source.rating != null && source.rating !== '' ? Number(source.rating) : undefined
  const reviews = source.user_ratings_total != null && source.user_ratings_total !== ''
    ? Number(source.user_ratings_total)
    : undefined
  return {
    place_id: String(source.place_id ?? ''),
    name: String(source.name ?? ''),
    formatted_address: source.formatted_address ? String(source.formatted_address) : undefined,
    international_phone_number: source.international_phone_number ? String(source.international_phone_number) : undefined,
    website: source.website ? String(source.website) : undefined,
    rating: Number.isFinite(rating) ? rating : undefined,
    user_ratings_total: Number.isFinite(reviews) ? Math.trunc(reviews as number) : undefined,
    business_status: source.business_status ? String(source.business_status) : undefined,
  }
}
