// Проверка плана, пришедшего от модели. Здесь весь риск агентского контура.
//
// Модель предлагает, что нажать и что вписать на чужой странице. Ошибка стоит не «неверного ответа
// в чате», а нажатой кнопки в кабинете продавца. Поэтому проверяется не то, что план обычно
// приходит правильным, а то, что НЕПРАВИЛЬНЫЙ не проходит.

import assert from 'node:assert/strict'
import {
  MAX_ACTIONS,
  MAX_VALUE_LENGTH,
  PLAN_SYSTEM_PROMPT,
  checkPlan,
  planNote,
  planUserPrompt,
} from '../supabase/functions/_shared/agentPlan.ts'

const PAGE = [
  { id: 1, kind: 'input', label: 'Название товара на русском' },
  { id: 2, kind: 'richtext', label: 'Полное описание на русском' },
  { id: 3, kind: 'button', text: 'Отправить на модерацию', risky: true },
  { id: 4, kind: 'select', label: 'Единица измерения', options: ['шт', 'кг'] },
  { id: 5, kind: 'input', label: 'Артикул', disabled: true },
]

// --- Номер обязан быть из снимка ------------------------------------------------------------------
// Это главная проверка файла. Элемента, которого мы не показывали, коснуться нельзя — и неважно,
// выдумала его модель или подменили ответ по дороге.

const invented = checkPlan({ actions: [{ type: 'type', id: 99, value: 'x' }] }, PAGE)
assert.deepEqual(invented.actions, [])
assert.equal(invented.rejected[0].reason, 'unknown_id')

for (const id of [null, undefined, '1; drop', 1.5, -1, NaN]) {
  const bad = checkPlan({ actions: [{ type: 'type', id, value: 'x' }] }, PAGE)
  assert.deepEqual(bad.actions, [], `не номер: ${String(id)}`)
}
// Строка «1» — это всё-таки номер 1: касса и браузер оба присылают числа строками.
assert.deepEqual(checkPlan({ actions: [{ type: 'type', id: '1', value: 'Брелок' }] }, PAGE).actions,
  [{ type: 'type', id: 1, value: 'Брелок' }])

// --- Действие обязано быть из списка ---------------------------------------------------------------
// «eval», «navigate», «download» — всё, чего нет в трёх разрешённых, не исполняется.

for (const type of ['eval', 'navigate', 'download', 'submit', '', null]) {
  const bad = checkPlan({ actions: [{ type, id: 1, value: 'x' }] }, PAGE)
  assert.deepEqual(bad.actions, [], `не действие: ${String(type)}`)
  assert.equal(bad.rejected[0].reason, 'unknown_action')
}

// --- Действие обязано подходить элементу ------------------------------------------------------------
// Печатать в кнопку бессмысленно, а выбирать вариант можно только в списке. Пропустить такое
// значит получить план, который «выполнился», ничего не сделав.

assert.equal(checkPlan({ actions: [{ type: 'type', id: 3, value: 'x' }] }, PAGE).rejected[0].reason, 'not_a_text_field')
assert.equal(checkPlan({ actions: [{ type: 'select', id: 1, value: 'шт' }] }, PAGE).rejected[0].reason, 'not_a_select')
assert.deepEqual(checkPlan({ actions: [{ type: 'select', id: 4, value: 'кг' }] }, PAGE).actions,
  [{ type: 'select', id: 4, value: 'кг' }])
// Редактор форматированного текста — законная цель для ввода.
assert.deepEqual(checkPlan({ actions: [{ type: 'type', id: 2, value: 'Текст' }] }, PAGE).actions,
  [{ type: 'type', id: 2, value: 'Текст' }])

// --- Заблокированное не трогаем --------------------------------------------------------------------
// Запись в заблокированное поле — это молча ничего не сделать и доложить об успехе.

assert.equal(checkPlan({ actions: [{ type: 'type', id: 5, value: 'A-1' }] }, PAGE).rejected[0].reason, 'disabled_element')

// --- Пустое и слишком длинное значение ---------------------------------------------------------------

assert.equal(checkPlan({ actions: [{ type: 'type', id: 1, value: '' }] }, PAGE).rejected[0].reason, 'empty_value')
assert.equal(checkPlan({ actions: [{ type: 'type', id: 1 }] }, PAGE).rejected[0].reason, 'empty_value')
assert.equal(checkPlan({ actions: [{ type: 'type', id: 1, value: 'я'.repeat(MAX_VALUE_LENGTH + 1) }] }, PAGE).rejected[0].reason,
  'value_too_long')
assert.deepEqual(checkPlan({ actions: [{ type: 'type', id: 1, value: 'я'.repeat(MAX_VALUE_LENGTH) }] }, PAGE).rejected, [],
  'ровно по границе — проходит')

// --- Длина плана ------------------------------------------------------------------------------------
// План на сотню шагов по одной странице — это не план, а перебор наугад.

const many = Array.from({ length: MAX_ACTIONS + 5 }, () => ({ type: 'click', id: 4 }))
const capped = checkPlan({ actions: many }, PAGE)
assert.equal(capped.actions.length, MAX_ACTIONS)
assert.equal(capped.rejected.length, 5)
assert.equal(capped.rejected[0].reason, 'too_many_actions')

// --- Мусор вместо плана ------------------------------------------------------------------------------
// Модель может вернуть что угодно, включая не-JSON и не тот JSON. Ни один такой ответ не должен
// уронить обработчик: пустой план честнее исключения.

for (const raw of [null, undefined, {}, [], 'строка', { actions: null }, { actions: 'nope' }, { actions: [null, 7] }]) {
  const result = checkPlan(raw, PAGE)
  assert.ok(Array.isArray(result.actions), `не падаем на ${JSON.stringify(raw)}`)
  assert.deepEqual(result.actions, [])
}

// --- Рискованная кнопка проходит проверку, но не исполняется без согласия ------------------------------
// Здесь она пропускается намеренно: запрет живёт в расширении, где есть галочка человека. Сервер
// не должен решать за него — он лишь помечает.

assert.deepEqual(checkPlan({ actions: [{ type: 'click', id: 3 }] }, PAGE).actions, [{ type: 'click', id: 3 }])

// --- Отброшенное называется --------------------------------------------------------------------------
// Молчаливая фильтрация превращает разбор в гадание: план «не сработал», и никто не знает почему.

const mixed = checkPlan({
  actions: [
    { type: 'type', id: 1, value: 'Брелок' },
    { type: 'type', id: 99, value: 'мимо' },
    { type: 'eval', id: 1 },
  ],
}, PAGE)
assert.equal(mixed.actions.length, 1)
assert.equal(mixed.rejected.length, 2)
assert.deepEqual(mixed.rejected.map((one) => one.reason).sort(), ['unknown_action', 'unknown_id'])

// --- Промпт и заметка ----------------------------------------------------------------------------------

assert.ok(PLAN_SYSTEM_PROMPT.includes('ТОЛЬКО номера из снимка'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('Uzum'), 'ловушка про язык названа прямо в промпте')

// Общее поручение — норма, а не повод отказать. Модель, ждущая указания на каждое поле, вернёт
// пустой план на «заполни карточку товара» и будет формально права.
assert.ok(PLAN_SYSTEM_PROMPT.includes('ОБЩИЕ ПОРУЧЕНИЯ — ЭТО НОРМА'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('Заполни карточку товара'))
for (const key of ['title_ru', 'title_uz', 'description_ru', 'description_uz', 'category', 'price_uzs']) {
  assert.ok(PLAN_SYSTEM_PROMPT.includes(key), `ключ данных ${key} назван в промпте`)
}
// Пустой ответ разрешён только как крайний случай, а не как осторожная привычка.
assert.ok(PLAN_SYSTEM_PROMPT.includes('нет ВООБЩЕ'))
// Краткое и полное описания путать нельзя: в короткое поле длинный текст не влезет.
assert.ok(PLAN_SYSTEM_PROMPT.includes('краткое описание с полным'))
assert.equal(planNote({ note: '  Заполнил два поля  ' }), 'Заполнил два поля')
assert.equal(planNote({ note: '' }), null)
assert.equal(planNote({}), null)
assert.equal(planNote(null), null)

// В промпт уходит то, что видит человек, и НЕ уходит разметка: ни html, ни классы, ни селекторы.
const prompt = planUserPrompt({
  instruction: 'заполни карточку',
  page: { url: 'https://seller.uzum.uz/seller/1/products/new', title: 'Новый товар', items: PAGE },
  data: { title_ru: 'Брелок' },
})
assert.ok(prompt.includes('Название товара на русском'))
assert.ok(prompt.includes('Брелок'))
assert.equal(/<div|class=|querySelector/.test(prompt), false, 'разметка наружу не уезжает')

console.log('[OK] Agent plan behaviour: 56 assertions')
