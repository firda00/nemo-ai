// Кнопки под ценовым советом и разбор ответа «своя цена».
//
// Nemo не меняет цену на Uzum. Нажатие «Принять» означает «ставлю это число», и с этого момента
// совет становится проверяемой гипотезой: база запоминает, чего ждёт и к какому сроку, а резолвер
// через неделю смотрит, сбылось ли. Без кнопки все советы одинаково хороши навсегда.

export const CB_PRICE = 'cpp'

/**
 * Кнопки помещаются в 64 байта — это лимит Telegram на callback_data, и он в байтах, не в
 * символах.
 *
 * "cpp:" + uuid + ":y:" + цена в сумах — 4 + 36 + 3 + до 9 = 52 байта. Влезает целиком, поэтому
 * id не приходится хешировать, как пришлось для названий категорий.
 *
 * Цена едет В КНОПКЕ намеренно. Кнопка живёт в чате сколько угодно, а совет за это время может
 * пересчитаться: себестоимость уточнили, комиссия изменилась. Число из кнопки сверяется с
 * нынешним, и расхождение показывается владельцу вместо того, чтобы молча принять устаревшее —
 * он видел на экране одно число, а согласился бы на другое.
 */
export function priceKeyboard(recommendationId: string, targetTiyin: number) {
  const uzs = Math.round(targetTiyin / 100)
  return [
    [{ text: `✅ Принять ${uzs.toLocaleString('ru-RU')} сум`, callback_data: `${CB_PRICE}:${recommendationId}:y:${uzs}` }],
    [
      { text: '✏️ Своя цена', callback_data: `${CB_PRICE}:${recommendationId}:c` },
      { text: '❌ Отклонить', callback_data: `${CB_PRICE}:${recommendationId}:n` },
    ],
  ]
}

/**
 * Приглашение ввести свою цену.
 *
 * Метка `#a1b2c3d4` — первые восемь символов id совета. Она нужна, чтобы ответ нашёл свой товар
 * без хранения состояния: Telegram присылает в ответе исходное сообщение целиком, и метка
 * читается оттуда. Состояние «ждём число от этого чата» пришлось бы где-то держать, а держать
 * его негде — вебхук без памяти, и потерянное состояние означало бы молча проглоченный ответ.
 */
export function ownPricePrompt(recommendationId: string, title: string, floorTiyin: number): string {
  return [
    `✏️ <b>Своя цена</b> — ${title}`,
    `Ниже ${Math.round(floorTiyin / 100).toLocaleString('ru-RU')} сум не принимаю: там маржа меньше вашего минимума.`,
    '',
    'Ответьте на это сообщение числом.',
    `<i>#${recommendationId.slice(0, 8)}</i>`,
  ].join('\n')
}

/** Id совета из сообщения, на которое отвечают. Null, если метки там нет. */
export function replyTarget(replyText: unknown): string | null {
  const found = String(replyText ?? '').match(/#([0-9a-f]{8})\b/i)
  return found ? found[1].toLowerCase() : null
}

/**
 * Цена из того, что владелец написал.
 *
 * Принимается число с любыми разделителями разрядов — «58 750», «58750», «58,750». Отбрасывается
 * всё остальное: фраза «поставлю дороже» не содержит цены, и угаданная из неё цифра уехала бы в
 * решение как согласие владельца.
 */
export function parseOwnPrice(text: unknown): number | null {
  const raw = String(text ?? '').trim()
  // Только число и разделители: «цена 58750 будет к пятнице» — не ответ, а разговор.
  if (!/^[\d\s.,]+$/.test(raw)) return null
  const digits = raw.replace(/[\s.,]/g, '')
  if (!/^\d{2,9}$/.test(digits)) return null
  const uzs = Number(digits)
  return Number.isSafeInteger(uzs) && uzs > 0 ? uzs * 100 : null
}

/** Разбор callback_data. Null, если это не наша кнопка. */
export function parsePriceCallback(data: unknown): { id: string; action: 'y' | 'n' | 'c'; priceTiyin: number | null } | null {
  const parts = String(data ?? '').split(':')
  if (parts[0] !== CB_PRICE || parts.length < 3) return null
  const id = parts[1]
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const action = parts[2]
  if (action !== 'y' && action !== 'n' && action !== 'c') return null
  const uzs = parts[3] != null ? Number(parts[3]) : null
  return { id, action, priceTiyin: uzs != null && Number.isSafeInteger(uzs) && uzs > 0 ? uzs * 100 : null }
}

const money = (tiyin: number) => Math.round(tiyin / 100).toLocaleString('ru-RU')

/** Ответ владельцу после принятия. Число повторяется голым — его переносят в кабинет. */
export function acceptedText(title: string, priceTiyin: number, horizonAt: string | null): string {
  return [
    `✅ <b>Принято</b> — ${title}`,
    `Новая цена: <b>${money(priceTiyin)} сум</b>`,
    '',
    `<code>${Math.round(priceTiyin / 100)}</code>`,
    '',
    horizonAt
      ? `Через неделю (${String(horizonAt).slice(0, 10)}) проверю, стоит ли она столько и что из этого вышло.`
      : 'Проверю результат через неделю.',
    '<i>Nemo не меняет цену на Uzum. Поставьте её в кабинете сами.</i>',
  ].join('\n')
}

/** Почему цену не приняли. Отказ называет число, иначе он неотличим от поломки. */
export function refusalText(reason: string, floorTiyin: number | null): string {
  if (reason === 'below_floor' && floorTiyin != null) {
    return `Не принимаю: ниже ${money(floorTiyin)} сум маржа меньше вашего минимума. Пришлите число не меньше этого.`
  }
  if (reason === 'no_floor') return 'Не могу принять: у товара нет себестоимости или комиссии, и минимальную цену считать не из чего.'
  if (reason.startsWith('already_')) return 'Уже обработано.'
  if (reason === 'invalid_price') return 'Не разобрал число. Пришлите только цифры.'
  return 'Не удалось принять цену.'
}
