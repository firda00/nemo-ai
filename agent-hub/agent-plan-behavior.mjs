// Проверка плана, пришедшего от модели. Здесь весь риск агентского контура.
//
// Модель предлагает, что нажать и что вписать на чужой странице. Ошибка стоит не «неверного ответа
// в чате», а нажатой кнопки в кабинете продавца. Поэтому проверяется не то, что план обычно
// приходит правильным, а то, что НЕПРАВИЛЬНЫЙ не проходит.

import assert from 'node:assert/strict'
import {
  MAX_ACTIONS,
  MAX_VALUE_LENGTH,
  GENERAL_BROWSER_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  checkPlan,
  detectCategoryMismatch,
  extractOwnerFormValues,
  planNote,
  planUserPrompt,
  unaddressedFields,
} from '../supabase/functions/_shared/agentPlan.ts'

const PAGE = [
  { id: 1, kind: 'input', label: 'Название товара на русском' },
  { id: 2, kind: 'richtext', label: 'Полное описание на русском' },
  { id: 3, kind: 'button', text: 'Отправить на модерацию', risky: true },
  { id: 4, kind: 'select', label: 'Единица измерения', options: ['шт', 'кг'] },
  { id: 5, kind: 'input', label: 'Артикул', disabled: true },
]

assert.match(GENERAL_BROWSER_SYSTEM_PROMPT, /парол|password/i)
assert.match(GENERAL_BROWSER_SYSTEM_PROMPT, /CAPTCHA/i)
assert.match(GENERAL_BROWSER_SYSTEM_PROMPT, /оплат|покуп/i)

// После перехода элементы старого DOM больше не существуют. Следующие действия выполнятся только
// после нового снимка страницы автономным loop.
const navigationPlan = checkPlan({ actions: [
  { type: 'click', id: 6 },
  { type: 'type', id: 1, value: 'Нельзя вводить на старой странице' },
] }, [...PAGE, { id: 6, kind: 'link', text: 'Открыть карточку' }])
assert.deepEqual(navigationPlan.actions, [{ type: 'click', id: 6 }])
assert.equal(navigationPlan.rejected[0].reason, 'stale_after_navigation')

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

// --- Поля, которых план вообще не коснулся ------------------------------------------------------
// «Модель не заметила поле» и «предложила, но проверка отклонила» — разные беды. Отклонённое по
// РЕАЛЬНОЙ причине (проверка честно разобрала кандидата) всё равно СЧИТАЕТСЯ попыткой; отклонённое
// как unknown_action/unknown_id/too_many_actions — нет, там даже нет надёжного id, за который можно
// зацепиться.

{
  const checked = checkPlan({
    actions: [
      { type: 'type', id: 1, value: 'Брелок' },  // id1: принято
      { type: 'select', id: 2, value: 'кг' },    // id2: отклонено по not_a_select — но это попытка
      { type: 'drag', id: 4 },                   // id4: отклонено по unknown_action — не попытка
    ],
  }, PAGE)
  const untouched = unaddressedFields(PAGE, checked)
  assert.deepEqual(untouched.map((one) => one.id), [4],
    'id1 принят и id2 отклонён по реальной причине — оба не в списке; id4 остаётся, т.к. ' +
    'unknown_action не защитывается попыткой; id3 — кнопка (не поле), id5 — заблокировано')
}

{
  // Совсем пустой план — план не тронул НИЧЕГО из заполняемого. Кнопка (id3, не поле для ввода) и
  // заблокированное поле (id5) не в счёт: их план и не должен трогать.
  const untouched = unaddressedFields(PAGE, checkPlan({ actions: [] }, PAGE))
  assert.deepEqual(untouched.map((one) => one.id), [1, 2, 4])
}

// --- Категория страницы против категории черновика ------------------------------------------------
// Живой случай: страница стояла на «Книги › Комиксы», черновик был про женский хиджаб — план
// заполнил 7 полей чужими данными, не заметив разрыва. .category-wrapper как селектор намеренно не
// используется — сканер не знает CSS-классов конкретного сайта; сигнал ищется в тех же
// label/context/text, по которым сканер и так узнаёт любое поле.

const CATEGORY_PAGE_MATCH = [
  { id: 1, kind: 'button', text: 'Изменить', context: 'Категория товара: Одежда и обувь › Женская одежда' },
]
const CATEGORY_PAGE_MISMATCH = [
  { id: 1, kind: 'button', text: 'Изменить', context: 'Категория товара: Книги › Комиксы' },
]
// Без слова «категория» рядом вообще — ровно как выглядит УЖЕ ПОДТВЕРЖДЁННАЯ категория на живой
// странице: поле поиска скрыто, остался только путь и кнопка «Изменить».
const CATEGORY_PAGE_FALLBACK_ONLY = [
  { id: 1, kind: 'button', text: 'Изменить', context: 'Книги › Комиксы' },
]
const CATEGORY_PAGE_NO_SIGNAL = [
  { id: 1, kind: 'input', label: 'Название товара на русском' },
]

assert.deepEqual(detectCategoryMismatch(CATEGORY_PAGE_MISMATCH, null), { mismatch: false, pageCategory: null },
  'без категории черновика сравнивать не с чем — молчание, а не отказ')
assert.deepEqual(detectCategoryMismatch(CATEGORY_PAGE_MISMATCH, '   '), { mismatch: false, pageCategory: null })
assert.deepEqual(detectCategoryMismatch(CATEGORY_PAGE_NO_SIGNAL, 'Женская одежда'), { mismatch: false, pageCategory: null },
  'на странице нет вообще никакого сигнала о категории — молчание не повод отказывать')

{
  const result = detectCategoryMismatch(CATEGORY_PAGE_MATCH, 'Женская одежда')
  assert.equal(result.mismatch, false, 'общие слова «женская»/«одежда» есть — формулировки разные, категория одна')
  assert.ok(result.pageCategory?.includes('Женская одежда'))
}

{
  const result = detectCategoryMismatch(CATEGORY_PAGE_MISMATCH, 'Женский хиджаб-бини')
  assert.equal(result.mismatch, true, 'ни одного общего слова — книги и хиджаб не смежные категории')
  assert.ok(result.pageCategory?.includes('Книги'))
}

{
  // Запасной сигнал (кнопка «Изменить» + путь, без слова «категория») тоже ловит расхождение —
  // это единственный сигнал, который вообще есть на живой странице с подтверждённой категорией.
  const result = detectCategoryMismatch(CATEGORY_PAGE_FALLBACK_ONLY, 'Женский хиджаб-бини')
  assert.equal(result.mismatch, true)
  assert.ok(result.pageCategory?.includes('Книги'))
}

// --- Промпт и заметка ----------------------------------------------------------------------------------

assert.ok(PLAN_SYSTEM_PROMPT.includes('ТОЛЬКО номера из снимка'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('Uzum'), 'ловушка про язык названа прямо в промпте')

// Общее поручение — норма, а не повод отказать. Модель, ждущая указания на каждое поле, вернёт
// пустой план на «заполни карточку товара» и будет формально права.
assert.ok(PLAN_SYSTEM_PROMPT.includes('ОБЩИЕ ПОРУЧЕНИЯ — ЭТО НОРМА'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('Заполни карточку товара'))
for (const key of ['title_ru', 'title_uz', 'description_ru', 'description_uz', 'category', 'price_uzs', 'stock_total', 'attributes']) {
  assert.ok(PLAN_SYSTEM_PROMPT.includes(key), `ключ данных ${key} назван в промпте`)
}
// Пустой ответ разрешён только как крайний случай, а не как осторожная привычка.
assert.ok(PLAN_SYSTEM_PROMPT.includes('нет ВООБЩЕ'))

// Два поля описания (textarea-тизер + richtext-полное) — норма, а не повод спутать их или один
// оставить пустым. Живой отчёт показал именно это: richtext без подписи и плейсхолдера модель
// сочла слишком неопределённым и молча пропустила, хотя description_ru был непустой.
assert.ok(PLAN_SYSTEM_PROMPT.includes('Два поля описания на одном языке — НОРМА'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('Различай их по kind'), 'различение по kind, не по словам в подписи — подписи может не быть')
assert.ok(PLAN_SYSTEM_PROMPT.includes('Заполняй ОБА'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('Пустой richtext при непустом description_ru/description_uz'))

// attributes — свободные характеристики от владельца, а не гарантированный бренд/страна. Модель
// не должна гадать по select без уверенного совпадения — и должна сказать об этом в note, а не
// промолчать.
assert.ok(PLAN_SYSTEM_PROMPT.includes('значение в select, ТОЛЬКО если'))
assert.ok(PLAN_SYSTEM_PROMPT.includes('бренд/страна — заполните вручную'))

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

// Цена и остаток для РЕДАКТИРОВАНИЯ существующей карточки берутся только из явных слов владельца.
assert.deepEqual(extractOwnerFormValues('Обнови цену на 129 900 и остаток 17'), { price_uzs: 129900, stock_total: 17 })
assert.deepEqual(extractOwnerFormValues('Narxni: 55 000, qoldiqni 8'), { price_uzs: 55000, stock_total: 8 })
assert.deepEqual(extractOwnerFormValues('Товар 2026, артикул 99881'), {}, 'случайные числа не становятся ценой или остатком')
assert.deepEqual(extractOwnerFormValues('Поставь цену 999999999999999999999'), {}, 'небезопасно большое число отбрасывается')

console.log('[OK] Agent plan behaviour: 85 assertions')
