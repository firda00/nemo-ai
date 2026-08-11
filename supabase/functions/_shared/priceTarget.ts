// Какую цену предложить — и почему именно её.
//
// NEMO НЕ МЕНЯЕТ ЦЕНЫ. Интеграция с Uzum read-only, поэтому здесь считается РЕКОМЕНДАЦИЯ, которую
// владелец переносит в кабинет сам. Это не ограничение реализации, а защита его бизнеса: цена —
// последнее, что стоит отдавать автомату, который ошибётся молча.
//
// Вся арифметика берётся из unitEconomics.ts. Своей алгебры здесь нет намеренно: две копии одной
// формулы однажды разойдутся, и продавец встретит противоречие — калькулятор скажет «поставьте
// 128 000», он поставит ровно столько, а утренний дайджест сообщит, что маржа ниже минимума.

import { marginPercent, minSellingPriceTiyin, type Fees } from './unitEconomics.ts'

export type PriceAdvice = {
  /** Цена, которую предлагаем поставить. Никогда не ниже пола. */
  target_tiyin: number
  /** Пол: ниже него товар продаётся в убыток относительно минимальной маржи владельца. */
  floor_tiyin: number
  current_tiyin: number
  /** Маржа, которая получится по предложенной цене. */
  target_margin_percent: number
  current_margin_percent: number | null
  /** Куда двигаем и зачем. */
  direction: 'raise' | 'discount'
  reason: 'margin_below_minimum' | 'deadstock_clearance'
}

/**
 * Максимальная скидка на застрявший товар — доля от нынешней цены.
 *
 * Тридцать процентов, и не потому, что это красивое число: скидка глубже почти всегда упирается в
 * пол, и предложение выродилось бы в «поставьте минимальную цену» на каждом лежащем товаре. Тогда
 * совет перестал бы отличать товар, который можно спасти скидкой, от того, который дешевле вывезти.
 */
const MAX_CLEARANCE_SHARE = 0.30

/**
 * Цена под целевую маржу.
 *
 * Это тот же расчёт, что даёт минимальную цену, просто с другой целью в качестве входа: «цена,
 * при которой маржа равна X» — одна формула, а X — вопрос владельца, а не арифметики.
 *
 * Возвращает null, когда чисел не хватает или когда комиссия вместе с целью уже съедает всю цену.
 * Отрицательное число, одетое рекомендацией, хуже отказа: его переносят в кабинет.
 */
export function priceForMargin(unitCostTiyin: number, targetMarginPercent: number, fees: Fees): number | null {
  return minSellingPriceTiyin(unitCostTiyin, targetMarginPercent, fees)
}

/**
 * Что предложить по товару, у которого маржа ниже минимума.
 *
 * Пол не рекомендация, а граница: на нём маржа ровно минимальная, то есть владелец работает на
 * пределе того, что сам назвал приемлемым. Поэтому предлагается цена под ЦЕЛЕВУЮ маржу, а пол
 * едет рядом отдельным числом — чтобы торговаться было с чем.
 */
export function adviceForMargin(input: {
  currentTiyin: number
  unitCostTiyin: number
  minMarginPercent: number
  targetMarginPercent: number
  fees: Fees
}): PriceAdvice | null {
  const floor = minSellingPriceTiyin(input.unitCostTiyin, input.minMarginPercent, input.fees)
  const target = priceForMargin(input.unitCostTiyin, input.targetMarginPercent, input.fees)
  if (floor == null || target == null || !(input.currentTiyin > 0)) return null
  const current = marginPercent(input.currentTiyin, input.unitCostTiyin, input.fees)
  // Совет, не меняющий цену, — не совет. Округление до сотни тийин уже сделано в расчёте, так что
  // равенство здесь настоящее, а не следствие копеек.
  const advised = Math.max(target, floor)
  if (advised <= input.currentTiyin) return null
  return {
    target_tiyin: advised,
    floor_tiyin: floor,
    current_tiyin: input.currentTiyin,
    target_margin_percent: input.targetMarginPercent,
    current_margin_percent: current,
    direction: 'raise',
    reason: 'margin_below_minimum',
  }
}

/**
 * Что предложить по товару, который лежит без движения.
 *
 * Здесь цена идёт ВНИЗ, и пол становится главным действующим лицом: распродажа в убыток — это не
 * освобождение склада, а оплаченный убыток плюс освобождение склада. Скидка ограничена и сверху
 * (тридцатью процентами), и снизу (полом), а если пол выше нынешней цены — предлагать нечего:
 * товар и так продаётся на пределе, и лежит он не из-за цены.
 */
export function adviceForDeadstock(input: {
  currentTiyin: number
  unitCostTiyin: number
  minMarginPercent: number
  fees: Fees
}): PriceAdvice | null {
  const floor = minSellingPriceTiyin(input.unitCostTiyin, input.minMarginPercent, input.fees)
  if (floor == null || !(input.currentTiyin > 0)) return null
  if (floor >= input.currentTiyin) return null
  const discounted = Math.round(input.currentTiyin * (1 - MAX_CLEARANCE_SHARE))
  const advised = Math.max(discounted, floor)
  if (advised >= input.currentTiyin) return null
  return {
    target_tiyin: advised,
    floor_tiyin: floor,
    current_tiyin: input.currentTiyin,
    target_margin_percent: marginPercent(advised, input.unitCostTiyin, input.fees) ?? input.minMarginPercent,
    current_margin_percent: marginPercent(input.currentTiyin, input.unitCostTiyin, input.fees),
    direction: 'discount',
    reason: 'deadstock_clearance',
  }
}

const uzs = (tiyin: number) => Math.round(tiyin / 100).toLocaleString('ru-RU')

/**
 * Сообщение в Telegram.
 *
 * Число, которое переносят в кабинет, стоит отдельной строкой и без разметки: его выделяют
 * пальцем на телефоне, и любой символ рядом уедет вместе с ним.
 */
export function adviceMessage(title: string, advice: PriceAdvice): string {
  const head = advice.direction === 'raise'
    ? `📉 <b>Маржа ниже минимума</b>`
    : `🧊 <b>Товар лежит без движения</b>`
  const now = advice.current_margin_percent == null ? '—' : `${advice.current_margin_percent.toFixed(1)}%`
  return [
    head,
    '',
    title,
    `Сейчас: ${uzs(advice.current_tiyin)} сум (маржа ${now})`,
    advice.direction === 'raise'
      ? `Рекомендуем: <b>${uzs(advice.target_tiyin)} сум</b> (маржа ${advice.target_margin_percent.toFixed(0)}%)`
      : `Рекомендуем: <b>${uzs(advice.target_tiyin)} сум</b> — скидка ${Math.round((1 - advice.target_tiyin / advice.current_tiyin) * 100)}%`,
    `Ниже не опускаться: ${uzs(advice.floor_tiyin)} сум`,
    '',
    // ГОЛЫЕ ЦИФРЫ, без разделителя. toLocaleString ставит неразрывный пробел (U+00A0), и он
    // уехал бы вместе с числом в поле цены Uzum — а поле, которое его не поймёт, откажет молча
    // или, хуже, прочитает часть числа.
    `<code>${Math.round(advice.target_tiyin / 100)}</code>`,
    '',
    '<i>Nemo не меняет цену на Uzum. Скопируйте число и поставьте его в кабинете.</i>',
  ].join('\n')
}
