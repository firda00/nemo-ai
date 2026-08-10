// Подписи полок Uzum на языке владельца.
//
// Uzum отдаёт одно имя, узбекское. Интерфейс при этом русский, и владелец видит винегрет: над
// списком «Выберите категорию», в списке «Ko'ylaklar». Хуже того, он не может проверить выбор —
// «Ko'ylaklar» это платья, и понять это по написанию нельзя.
//
// Переводит модель, один раз на полку, с записью в общий справочник. Ключом везде остаётся
// узбекское имя: по нему сходятся товары и считается комиссия. Перевод — подпись, и только.

/** Строка справочника: ключ и его подписи. */
export type CategoryLabel = { category: string; label_ru: string | null; label_en: string | null }

export const TRANSLATE_SYSTEM_PROMPT = [
  'You translate Uzum Market category names from Uzbek into Russian and English.',
  'Input is a JSON array of Uzbek category names.',
  'Reply with JSON only: {"labels":[{"category":"<exactly the input string>","ru":"...","en":"..."}]}',
  'Rules:',
  '1. Return one entry per input, with "category" copied CHARACTER FOR CHARACTER from the input.',
  '   It is a key elsewhere in the system; an improved spelling breaks the join.',
  '2. Translate the retail meaning, not the words: "Ko\'ylaklar" is "Платья", not "Рубашки".',
  '3. Keep brand and proper names as they are.',
  '4. No explanations, no extra fields, nothing outside the JSON.',
].join('\n')

/**
 * Разбирает ответ модели, отбрасывая всё, чего не просили.
 *
 * Ключ сверяется с тем, что отправляли: модель, «исправившая» апостроф в Ko'ylaklar, вернула бы
 * строку, которая ни с чем не соединится, и полка осталась бы без подписи навсегда — молча.
 */
export function parseLabels(raw: unknown, requested: string[]): CategoryLabel[] {
  const wanted = new Set(requested)
  const rows = (raw as { labels?: unknown })?.labels
  if (!Array.isArray(rows)) return []
  const text = (value: unknown) => {
    const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
    return cleaned ? cleaned.slice(0, 160) : null
  }
  const seen = new Set<string>()
  const out: CategoryLabel[] = []
  for (const row of rows) {
    const category = typeof (row as Record<string, unknown>)?.category === 'string'
      ? (row as Record<string, string>).category
      : ''
    if (!wanted.has(category) || seen.has(category)) continue
    const ru = text((row as Record<string, unknown>).ru)
    const en = text((row as Record<string, unknown>).en)
    if (!ru && !en) continue
    seen.add(category)
    out.push({ category, label_ru: ru, label_en: en })
  }
  return out
}

/**
 * Подпись на языке интерфейса, с узбекским именем как последним рубежом.
 *
 * Непереведённая полка показывается как есть, а не прячется и не заменяется многоточием: имя от
 * Uzum владелец хотя бы увидит в кабинете, а пустое место не соответствует ничему.
 */
export function categoryLabel(category: string, labels: Record<string, CategoryLabel>, lang: string): string {
  const row = labels[category]
  if (!row) return category
  if (lang === 'ru') return row.label_ru ?? category
  if (lang === 'en') return row.label_en ?? category
  return category
}
