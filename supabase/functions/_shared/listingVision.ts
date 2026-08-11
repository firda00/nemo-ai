// Что модель имеет право увидеть на фотографии — и что не имеет права.
//
// РАЗДЕЛЕНИЕ ТО ЖЕ, ЧТО ВЕЗДЕ В КОММЕРЦИИ: модель пишет прозу, арифметика трогает деньги. Цвет,
// узор, материал и тип предмета видны на снимке — это описание, и ошибка там правится текстом.
// Габариты, вес и себестоимость на снимке НЕ ВИДНЫ. Их можно только угадать, а угаданный габарит
// уходит в тариф логистики Uzum и оттуда в минимальную цену: одно правдоподобное число молча
// портит экономику каждого расчёта по этому товару.
//
// Поэтому запрет живёт в ДВУХ местах. В промпте — чтобы модель не пыталась. В разборе ответа —
// потому что промпт это просьба, а не гарантия: модель, которой очень хочется быть полезной,
// однажды напишет «примерно 30×20×10 см», и единственное, что тогда спасёт, — код, который это
// выбросит.

import type { ChatMsg, ContentPart } from './llm.ts'

/**
 * Сообщение с картинками.
 *
 * Живёт здесь, а не в llm.ts, по той же причине, по которой там же живёт разбор черновика: llm.ts
 * читает `Deno.env` при загрузке модуля и под Node не импортируется вовсе. Логика, которую нельзя
 * проверить тестом, — логика, о которой мы узнаём от владельца.
 *
 * Больше четырёх изображений не берётся: каждое стоит токенов и времени, а пятое фото товара
 * почти никогда не добавляет фактов — оно добавляет счёт. Пустой список даёт обычное текстовое
 * сообщение, чтобы вызывающему не приходилось ветвиться.
 */
export const MAX_VISION_IMAGES = 4

export function visionMessage(text: string, imageUrls: string[]): ChatMsg {
  // Только http(s): data: и file:// до провайдера не доедут, а счёт за попытку придёт.
  const urls = imageUrls.filter((url) => typeof url === 'string' && /^https?:\/\//.test(url)).slice(0, MAX_VISION_IMAGES)
  if (!urls.length) return { role: 'user', content: text }
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...urls.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
    ],
  }
}

/** Поля, которые НИКОГДА не берутся с фотографии. */
export const FORBIDDEN_VISION_FIELDS = [
  'length_mm', 'width_mm', 'height_mm', 'weight_g', 'unit_cost_tiyin',
  'dimensions', 'габариты', 'вес', 'себестоимость', 'price', 'цена',
] as const

export interface VisionFacts {
  /** Что это за предмет: «женский хиджаб-бони», «сумка-шоппер». */
  item: string | null
  /** Видимые признаки: цвет, узор, стиль, материал, заметные особенности. */
  attributes: Array<{ name: string; value: string }>
  /** Чего по фото сказать нельзя, но покупатель спросит. Список для владельца, не догадки. */
  unknown_attributes: string[]
}

export const VISION_SYSTEM_PROMPT = [
  'You look at photographs of a product and report ONLY what is visibly there.',
  'Reply with JSON only: {"item":"string","attributes":[{"name":"string","value":"string"}],"unknown_attributes":["string"]}',
  'Rules you must not break:',
  '1. Report only what the photograph SHOWS: item type, colour, pattern, style, visible material,',
  '   visible features (a zip, a strap, a print, a fastening).',
  '2. NEVER state size, dimensions, weight, volume, capacity, price or cost. They are not visible',
  '   in a photograph. Guessing them corrupts the logistics tariff and every margin computed from it.',
  '   If a buyer would want one of those, put its NAME in "unknown_attributes" and nothing else.',
  '3. Do not infer a brand, a country of origin, a certification or a composition percentage from',
  '   appearance. "Looks like cotton" is not a material — leave it out.',
  '4. If the photograph is unclear or shows no product, return {"item":null,"attributes":[],',
  '   "unknown_attributes":[]} rather than describing something plausible.',
  '5. Russian in every value. The names of attributes are the words a seller uses: Цвет, Материал,',
  '   Узор, Стиль, Особенности.',
].join('\n')

// Значение с размером, весом или ценой отбрасывается независимо от того, как названо поле:
// модель может написать «Особенности: компактный, 30 см» — имя поля здесь безобидное, а число нет.
const MEASURED_VALUE = /(\d+[.,]?\d*)\s*(мм|см|м\b|mm|cm|kg|кг|г\b|гр\b|мл|л\b|ml|сум|so['‘’]m|uzs|руб)/i
const DIMENSION_SHAPE = /\d+\s*[xх×*]\s*\d+/i
const MEASURED_NAME = /(размер|габарит|вес|объ[её]м|вместимост|цена|стоимост|себестоимост|dimension|weight|size|price|cost|volume)/i

/**
 * Оставляет только то, что действительно видно.
 *
 * Отброшенное не пропадает молча: имя поля уезжает в `unknown_attributes`, то есть превращается
 * в вопрос владельцу. «Модель промолчала» и «модель не имела права это утверждать» — разные
 * вещи, и вторая должна оставлять след.
 */
export function parseVision(raw: unknown): VisionFacts | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const text = (value: unknown, limit: number): string | null => {
    const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
    return cleaned ? cleaned.slice(0, limit) : null
  }

  const rejected: string[] = []
  const attributes = (Array.isArray(row.attributes) ? row.attributes : [])
    .map((entry) => ({
      name: text((entry as Record<string, unknown>)?.name, 60),
      value: text((entry as Record<string, unknown>)?.value, 200),
    }))
    .filter((entry): entry is { name: string; value: string } => Boolean(entry.name && entry.value))
    .filter((entry) => {
      const measured = MEASURED_NAME.test(entry.name) || MEASURED_VALUE.test(entry.value) || DIMENSION_SHAPE.test(entry.value)
      if (measured) rejected.push(entry.name)
      return !measured
    })
    .slice(0, 20)

  const stated = (Array.isArray(row.unknown_attributes) ? row.unknown_attributes : [])
    .map((entry) => text(entry, 60))
    .filter((entry): entry is string => Boolean(entry))

  return {
    item: text(row.item, 160),
    attributes,
    // Отброшенное становится вопросом, а не тишиной.
    unknown_attributes: [...new Set([...stated, ...rejected])].slice(0, 20),
  }
}

/**
 * Описание товара словами владельца плюс то, что видно на фото.
 *
 * Фото ДОПОЛНЯЕТ текст, а не заменяет его. Числа по-прежнему берутся только из слов владельца
 * тем же разбором, что и раньше: снимок не может назвать ни себестоимость, ни габариты, и
 * поэтому не может их и изменить.
 */
export function mergeVisionIntoSource(sourceText: string, vision: VisionFacts | null): string {
  if (!vision || (!vision.item && !vision.attributes.length)) return sourceText
  const seen = String(sourceText ?? '').toLowerCase()
  const lines = [
    vision.item && !seen.includes(vision.item.toLowerCase()) ? vision.item : null,
    ...vision.attributes
      // Признак, уже названный владельцем, не повторяется: его слово главнее нашего снимка.
      .filter((attribute) => !seen.includes(attribute.value.toLowerCase()))
      .map((attribute) => `${attribute.name}: ${attribute.value}`),
  ].filter(Boolean)
  if (!lines.length) return sourceText
  return `${sourceText}\n\nПо фотографии: ${lines.join(', ')}`.slice(0, 4000)
}
