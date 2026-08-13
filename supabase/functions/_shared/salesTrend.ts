// Две недели вместо одной: что отличает «падает» от «просто медленно».
//
// Одно окно отвечает на вопрос «сколько продали», и по нему нельзя отличить товар, который всегда
// шёл по три штуки в неделю, от товара, который шёл по тридцать и встал. Для владельца это два
// разных дня: в первом случае делать нечего, во втором он теряет деньги прямо сейчас.
//
// Прошлая неделя не читается отдельным запросом: Uzum отдаёт итог за окно, а не по дням. Поэтому
// берутся два окна с общим началом — 7 дней и 14 дней, — и прошлая неделя получается вычитанием.
// Отсюда же главная опасность этого модуля: вычитание двух чисел, полученных РАЗНЫМИ запросами.

/** Сколько единиц должно суммарно продаться, чтобы разговор о тренде вообще имел смысл. */
export const TREND_MIN_UNITS = 6
/** Насколько должно измениться, чтобы это не было шумом округления спроса. */
export const TREND_MIN_DELTA = 3
export const TREND_MIN_PERCENT = 30

export type TrendDirection = 'new' | 'up' | 'flat' | 'down' | 'gone'

export interface SalesTrend {
  last7: number
  prev7: number
  delta: number
  /** null, когда прошлая неделя пустая: делить на ноль нельзя, а «+∞%» — не число, а знак. */
  deltaPercent: number | null
  direction: TrendDirection
  /** Достаточно ли велика перемена, чтобы о ней сообщать. Мелочь не должна будить владельца. */
  material: boolean
}

/**
 * Тренд по двум окнам продаж. null — «неизвестно», и это НЕ то же самое, что «ровно».
 *
 * Возвращает null в трёх случаях, и каждый из них — честный отказ отвечать:
 *
 *  • какое-то из окон не прочитано. Нечего вычитать;
 *  • окно за 14 дней оказалось МЕНЬШЕ окна за 7. Физически невозможно: большее окно содержит
 *    меньшее. Значит один из ответов обрезан постраничной выборкой, и разность будет
 *    отрицательной чепухой, которую легко принять за обвал продаж;
 *  • любое из окон обрезано по числу страниц. Uzum говорит, сколько строк в окне; если он вернул
 *    меньше, чем сказал, — прошлая неделя недосчитана, и «падение» окажется нашей арифметикой,
 *    а не фактом рынка.
 */
export function salesTrend(input: {
  units7: number | null
  units14: number | null
  truncated7?: boolean
  truncated14?: boolean
}): SalesTrend | null {
  const { units7, units14 } = input
  if (units7 == null || units14 == null) return null
  if (!Number.isFinite(units7) || !Number.isFinite(units14)) return null
  if (units7 < 0 || units14 < 0) return null
  if (input.truncated7 || input.truncated14) return null
  // Большее окно не может содержать меньше проданного, чем меньшее.
  if (units14 < units7) return null

  const last7 = units7
  const prev7 = units14 - units7
  const delta = last7 - prev7
  const deltaPercent = prev7 > 0 ? Math.round((delta / prev7) * 1000) / 10 : null

  let direction: TrendDirection
  if (prev7 === 0 && last7 === 0) direction = 'flat'
  else if (prev7 === 0) direction = 'new'
  else if (last7 === 0) direction = 'gone'
  else if (delta === 0) direction = 'flat'
  else direction = delta > 0 ? 'up' : 'down'

  // Порог сразу и в штуках, и в процентах. Только проценты — и рост с одной штуки до двух
  // становится «+100%»; только штуки — и падение с 40 до 36 попадает в отчёт наравне с обвалом.
  const volume = last7 + prev7
  const material = volume >= TREND_MIN_UNITS
    && Math.abs(delta) >= TREND_MIN_DELTA
    && (deltaPercent === null || Math.abs(deltaPercent) >= TREND_MIN_PERCENT)

  return { last7, prev7, delta, deltaPercent, direction, material }
}

/**
 * Стоит ли будить владельца этим трендом.
 *
 * Только падение и остановка. Рост Nemo и так учитывает — он поднимает скорость расхода, а значит
 * и срочность пополнения; отдельным сообщением «продажи выросли» владельцу нечего делать.
 * Остановка продаж при живом остатке — самое дорогое из двух: деньги уже лежат на складе.
 */
export function trendAlarm(trend: SalesTrend | null, stock: number | null): 'critical' | 'warning' | null {
  if (!trend || !trend.material) return null
  if (trend.direction === 'gone') return (stock ?? 0) > 0 ? 'critical' : 'warning'
  if (trend.direction === 'down') return 'warning'
  return null
}

/** Строка для дайджеста. Числа названы оба: процент без штук скрывает свой масштаб. */
export function trendSentence(trend: SalesTrend): string {
  const percent = trend.deltaPercent === null
    ? ''
    : ` (${trend.deltaPercent > 0 ? '+' : ''}${trend.deltaPercent}%)`
  if (trend.direction === 'gone') return `продажи остановились: было ${trend.prev7} шт за прошлую неделю, за эту — ни одной`
  if (trend.direction === 'new') return `первые продажи: ${trend.last7} шт за неделю, неделей раньше — ни одной`
  if (trend.direction === 'flat') return `без перемен: ${trend.last7} шт за неделю`
  const verb = trend.direction === 'up' ? 'выросли' : 'упали'
  return `продажи ${verb}: ${trend.prev7} → ${trend.last7} шт за неделю${percent}`
}
