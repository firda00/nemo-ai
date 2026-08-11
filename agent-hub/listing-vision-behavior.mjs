import assert from 'node:assert/strict'
import {
  MAX_VISION_IMAGES,
  VISION_SYSTEM_PROMPT,
  mergeVisionIntoSource,
  parseVision,
  visionMessage,
} from '../supabase/functions/_shared/listingVision.ts'

// --- Сообщение с картинками -------------------------------------------------------------------

const withImages = visionMessage('Опиши товар', ['https://x/1.jpg', 'https://x/2.png'])
assert.equal(withImages.role, 'user')
assert.equal(withImages.content[0].type, 'text')
assert.equal(withImages.content[1].image_url.url, 'https://x/1.jpg')

// Пустой список даёт обычное текстовое сообщение — вызывающему не нужно ветвиться.
assert.equal(visionMessage('Опиши товар', []).content, 'Опиши товар')
// Мусор вместо адреса отбрасывается: data: и file:// до провайдера не доедут, а счёт за попытку придёт.
assert.equal(visionMessage('т', ['data:image/png;base64,AAA', 'не ссылка']).content, 'т')

// Пятое фото почти никогда не добавляет фактов — оно добавляет счёт.
const many = visionMessage('т', Array.from({ length: 9 }, (_, i) => `https://x/${i}.jpg`))
assert.equal(many.content.length, MAX_VISION_IMAGES + 1, 'текст плюс не больше четырёх картинок')

// --- Запрет живёт в промпте... ----------------------------------------------------------------

for (const rule of ['NEVER state size, dimensions, weight', 'Do not infer a brand', 'no product, return']) {
  assert.ok(VISION_SYSTEM_PROMPT.includes(rule), `в промпте должно быть: ${rule}`)
}

// --- ...и в разборе, потому что промпт — это просьба ------------------------------------------
// Угаданный габарит уходит в тариф логистики Uzum и оттуда в минимальную цену: одно правдоподобное
// число молча портит экономику каждого расчёта по этому товару.

const facts = parseVision({
  item: 'Женский хиджаб-бони',
  attributes: [
    { name: 'Цвет', value: 'пудровый' },
    { name: 'Материал', value: 'шифон' },
    { name: 'Размер', value: '46' },
    { name: 'Вес', value: '120 г' },
    { name: 'Габариты', value: '30 x 20 x 10 см' },
    { name: 'Цена', value: '90 000 сум' },
    // Имя поля безобидное, а число внутри — нет.
    { name: 'Особенности', value: 'компактный, 30 см в сложенном виде' },
  ],
  unknown_attributes: ['Состав ткани'],
})
assert.deepEqual(
  facts.attributes,
  [{ name: 'Цвет', value: 'пудровый' }, { name: 'Материал', value: 'шифон' }],
  'остаётся только видимое',
)
// Отброшенное становится вопросом владельцу, а не тишиной.
for (const name of ['Размер', 'Вес', 'Габариты', 'Цена', 'Особенности', 'Состав ткани']) {
  assert.ok(facts.unknown_attributes.includes(name), `должно спрашиваться: ${name}`)
}

// Неразборчивое фото — пустой ответ, а не правдоподобное описание.
const blank = parseVision({ item: null, attributes: [], unknown_attributes: [] })
assert.equal(blank.item, null)
assert.deepEqual(blank.attributes, [])
assert.equal(parseVision(null), null)
assert.equal(parseVision('{"item":"x"}'), null, 'строка — не разобранный объект')

// --- Фото дополняет слова владельца, а не заменяет их -----------------------------------------

const merged = mergeVisionIntoSource(
  'Хиджаб-бони, себестоимость 18000 сум, 240х150х30 мм',
  parseVision({ item: 'Женский хиджаб-бони', attributes: [{ name: 'Цвет', value: 'пудровый' }], unknown_attributes: [] }),
)
assert.ok(merged.includes('себестоимость 18000 сум'), 'слова владельца остаются нетронутыми')
assert.ok(merged.includes('Цвет: пудровый'), 'а увиденное добавляется')

// Признак, уже названный владельцем, не дублируется: его слово главнее нашего снимка.
const noEcho = mergeVisionIntoSource(
  'Хиджаб-бони пудровый',
  parseVision({ item: null, attributes: [{ name: 'Цвет', value: 'пудровый' }], unknown_attributes: [] }),
)
assert.equal(noEcho, 'Хиджаб-бони пудровый')

// Пустое зрение не портит исходный текст.
assert.equal(mergeVisionIntoSource('Хиджаб', null), 'Хиджаб')

console.log('[OK] Listing vision behaviour: 24 assertions')
