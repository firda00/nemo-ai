import assert from 'node:assert/strict'
import {
  TREND_MIN_DELTA,
  TREND_MIN_PERCENT,
  TREND_MIN_UNITS,
  salesTrend,
  trendAlarm,
  trendSentence,
} from '../supabase/functions/_shared/salesTrend.ts'

// --- Прошлая неделя получается вычитанием ------------------------------------------------------
// Uzum отдаёт итог за окно, а не по дням. Значит 14 дней минус 7 дней и есть предыдущая неделя —
// и вся достоверность правила держится на том, что оба числа получены одинаково.

const fell = salesTrend({ units7: 4, units14: 24 })
assert.equal(fell.last7, 4)
assert.equal(fell.prev7, 20, 'прошлая неделя = 14 дней минус последние 7')
assert.equal(fell.delta, -16)
assert.equal(fell.deltaPercent, -80)
assert.equal(fell.direction, 'down')
assert.equal(fell.material, true)

const grew = salesTrend({ units7: 30, units14: 40 })
assert.equal(grew.prev7, 10)
assert.equal(grew.deltaPercent, 200)
assert.equal(grew.direction, 'up')

// Процент округляется до десятой, а не выдумывается «примерно»: он попадёт в сообщение владельцу.
assert.equal(salesTrend({ units7: 10, units14: 17 }).deltaPercent, 42.9)

// --- Молчание вместо выдумки -------------------------------------------------------------------
// null здесь означает «не знаю», и это НЕ то же самое, что «ровно». Ложная тревога про обвал
// дороже пропущенной: по ней владелец начинает распродажу товара, который просто медленный.

assert.equal(salesTrend({ units7: null, units14: 20 }), null, 'нет окна — нечего вычитать')
assert.equal(salesTrend({ units7: 5, units14: null }), null)
// Большее окно НЕ МОЖЕТ содержать меньше проданного, чем меньшее. Если содержит — один из ответов
// обрезан, и разность будет отрицательной чепухой, похожей на обвал продаж.
assert.equal(salesTrend({ units7: 20, units14: 12 }), null, 'окна противоречат друг другу')
// Обрезка по страницам — та же ловушка, только заметная заранее. 14 дней обрезаются раньше 7.
assert.equal(salesTrend({ units7: 10, units14: 40, truncated14: true }), null)
assert.equal(salesTrend({ units7: 10, units14: 40, truncated7: true }), null)
assert.equal(salesTrend({ units7: -1, units14: 5 }), null, 'отрицательных продаж не бывает')
assert.equal(salesTrend({ units7: NaN, units14: 5 }), null)

// --- Пороги: что считается переменой -----------------------------------------------------------
// Только проценты — и рост с одной штуки до двух становится «+100%». Только штуки — и падение с
// 40 до 36 попадает в отчёт наравне с обвалом. Поэтому оба порога сразу.

assert.equal(salesTrend({ units7: 2, units14: 3 }).material, false, 'единицы — это шум, а не тренд')
// 40 → 36 это минус 4 штуки: порог в штуках пройден, а порог в процентах — нет.
const shallow = salesTrend({ units7: 36, units14: 76 })
assert.equal(shallow.deltaPercent, -10)
assert.equal(Math.abs(shallow.delta) >= TREND_MIN_DELTA, true, 'в штуках перемена крупная')
assert.equal(Math.abs(shallow.deltaPercent) >= TREND_MIN_PERCENT, false, 'а в долях спроса — нет')
assert.equal(shallow.material, false, 'и этого достаточно, чтобы промолчать')
assert.equal(trendAlarm(salesTrend({ units7: 36, units14: 76 }), 5), null, '-10% не будит владельца')

const borderline = salesTrend({ units7: 2, units14: 7 })
assert.equal(borderline.prev7, 5)
assert.equal(borderline.delta, -3)
assert.equal(Math.abs(borderline.delta) >= TREND_MIN_DELTA, true)
assert.equal(borderline.last7 + borderline.prev7 >= TREND_MIN_UNITS, true)
assert.equal(borderline.material, true, 'на самой границе правило срабатывает, а не «примерно там»')

// --- Направления, у которых нет процента --------------------------------------------------------

const born = salesTrend({ units7: 9, units14: 9 })
assert.equal(born.prev7, 0)
assert.equal(born.direction, 'new')
assert.equal(born.deltaPercent, null, 'делить на ноль нельзя, а «+∞%» — это знак, а не число')

const died = salesTrend({ units7: 0, units14: 18 })
assert.equal(died.direction, 'gone')
assert.equal(died.prev7, 18)

const quiet = salesTrend({ units7: 0, units14: 0 })
assert.equal(quiet.direction, 'flat', 'ноль и ноль — это ровно, а не «новый спрос»')
assert.equal(quiet.material, false)
assert.equal(salesTrend({ units7: 10, units14: 20 }).direction, 'flat', 'равные недели — ровно')

// --- Кого будить -------------------------------------------------------------------------------
// Рост Nemo учитывает и без отдельного сообщения: он поднимает скорость расхода, а с ней срочность
// пополнения. Владельцу нечего делать со строкой «продажи выросли».

assert.equal(trendAlarm(died, 40), 'critical', 'продажи встали, а склад полон — это дороже всего')
assert.equal(trendAlarm(died, 0), 'warning', 'встали и склад пуст — терять уже нечего')
assert.equal(trendAlarm(fell, 10), 'warning')
assert.equal(trendAlarm(grew, 10), null, 'рост не будит')
assert.equal(trendAlarm(born, 10), null, 'первые продажи — не тревога')
assert.equal(trendAlarm(null, 10), null)
assert.equal(trendAlarm(salesTrend({ units7: 2, units14: 3 }), 10), null, 'немате­риальное молчит')

// --- Что прочитает владелец ---------------------------------------------------------------------
// Процент без штук скрывает свой масштаб: «-80%» одинаково выглядит и на двадцати продажах, и на
// двух. Названы оба числа.

assert.ok(trendSentence(fell).includes('20 → 4'), 'обе недели названы штуками')
assert.ok(trendSentence(fell).includes('-80%'))
assert.ok(trendSentence(died).includes('остановились'))
assert.ok(!trendSentence(born).includes('%'), 'у нового спроса процента нет — и он не печатается')
for (const trend of [fell, grew, died, born, quiet]) {
  assert.ok(!/NaN|Infinity|undefined|null/.test(trendSentence(trend)), 'в сообщение не течёт мусор')
}

console.log('[OK] Sales trend behaviour: 38 assertions')
