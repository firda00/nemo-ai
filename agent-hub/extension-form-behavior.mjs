// Правило поиска полей по подписям — проверено на макете формы.
//
// Разметки живой страницы у меня нет: пришли подписи, лимиты и структура шагов. Поэтому проверяется
// то, что проверить МОЖНО без неё, — само правило: как из подписи получается поле, как «Полное
// описание» отличается от «Краткого», и почему длинный текст отвергается, а не обрезается.
//
// Это НЕ доказательство того, что расширение заполнит настоящую форму: настоящая проверка — один
// запуск в кабинете. Это доказательство того, что ошибётся оно не здесь.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8')

/* ─────────────────────  Макет DOM: ровно то, чем пользуется content.js  ───────────────────── */

class Node {
  constructor(tag, { text = '', attrs = {}, children = [] } = {}) {
    this.tag = tag.toLowerCase()
    this.ownText = text
    this.attrs = attrs
    this.children = children
    this.parentElement = null
    this.value = ''
    this.events = []
    for (const child of children) child.parentElement = this
  }
  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }
  get isContentEditable() { return this.attrs.contenteditable === 'true' }
  // В настоящем DOM свойства disabled и readOnly отражают одноимённые атрибуты. Макет обязан
  // делать то же самое, иначе проверка готовности поля тестируется мимо.
  get disabled() { return Boolean(this.attrs.disabled) }
  get readOnly() { return Boolean(this.attrs.readonly) }
  getAttribute(name) { return this.attrs[name] ?? null }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]) }
  matches(selector) {
    // Поддержан ровно тот набор, что встречается в content.js.
    if (selector === 'input') return this.tag === 'input'
    if (selector === 'textarea') return this.tag === 'textarea'
    if (selector === '[contenteditable="true"]') return this.attrs.contenteditable === 'true'
    if (selector === 'button') return this.tag === 'button'
    if (selector === '[role="button"]') return this.attrs.role === 'button'
    if (selector === 'input[type="submit"]') return this.tag === 'input' && this.attrs.type === 'submit'
    return ['label', 'span', 'div', 'p'].includes(selector) && this.tag === selector
  }
  querySelector(list) {
    return this.querySelectorAll(list)[0] ?? null
  }
  querySelectorAll(list) {
    const selectors = list.split(',').map((one) => one.trim())
    return this.descendants().filter((node) => selectors.some((one) => node.matches(one)))
  }
  /** Порядок документа: 4 — DOCUMENT_POSITION_FOLLOWING, как в настоящем DOM. */
  compareDocumentPosition(other) {
    let top = this
    while (top.parentElement) top = top.parentElement
    const order = [top, ...top.descendants()]
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2
  }
  dispatchEvent(event) { this.events.push(event.type ?? String(event)); return true }
  focus() { this.focused = true }
  click() { this.clicked = true }
}

const el = (tag, options) => new Node(tag, options)
const text = (value) => el('span', { text: value })

function makeDocument(root_) {
  return {
    querySelectorAll(list) {
      const selectors = list.split(',').map((one) => one.trim())
      return [root_, ...root_.descendants()].filter((node) => selectors.some((one) => node.matches(one)))
    },
    getElementById(id) {
      return [root_, ...root_.descendants()].find((node) => node.attrs.id === id) ?? null
    },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(_command, _ui, value) { this.lastInsert = value; return true },
  }
}

/** Поле с подписью — так, как это описано по живой форме: подпись и ввод в одной обёртке. */
const field = (label, control) => el('div', { children: [el('label', { text: label }), control] })

function load(documentStub) {
  // Обработчик сообщений ЛОВИТСЯ, а не выбрасывается: решение «форма готова / сначала категория /
  // страница незнакомая» живёт именно в нём, и проверять его снаружи по кусочкам бессмысленно.
  let handler = null
  const chromeStub = { runtime: { onMessage: { addListener(fn) { handler = fn } } } }
  const windowStub = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) }
  class HTMLInputElement { }
  class HTMLTextAreaElement { }
  const factory = new Function(
    'chrome', 'document', 'window', 'HTMLInputElement', 'HTMLTextAreaElement',
    `${source}\nreturn { findByLabel, findByPlaceholder, findField, fieldReady, categoryConfirmed, fillFields, setRichValue }`,
  )
  const api = factory(chromeStub, documentStub, windowStub, HTMLInputElement, HTMLTextAreaElement)
  /** Один прогон обработчика — так же, как его зовёт service worker. */
  api.fill = (message) => new Promise((resolve) => handler(message, null, resolve))
  return api
}

/* ─────────────────────────────────  Форма как её описали  ───────────────────────────────── */

const titleUz = el('input', { attrs: { id: 'title-uz' } })
const titleRu = el('input', { attrs: { id: 'title-ru' } })
const shortRu = el('textarea', { attrs: { id: 'short-ru' } })
const fullRu = el('div', { attrs: { contenteditable: 'true', id: 'full-ru' } })
const fullUz = el('div', { attrs: { contenteditable: 'true', id: 'full-uz' } })
const categoryInput = el('input', { attrs: { id: 'category' } })

const form = el('div', {
  children: [
    field('Название категории или товара', categoryInput),
    field('Название товара на узбекском *', titleUz),
    field('Название товара на русском *', titleRu),
    // Краткое стоит РЯДОМ с полным и начинается похоже: если правило перепутает их, описание
    // товара уедет в поле на 390 знаков и будет обрезано площадкой.
    field('Краткое описание товара на русском', shortRu),
    field('Полное описание товара на русском', fullRu),
    field('Полное описание товара на узбекском', fullUz),
    el('button', { text: 'Принять' }),
    el('button', { text: 'Сохранить и продолжить' }),
  ],
})

const documentStub = makeDocument(form)
const api = load(documentStub)

// --- Подпись находит СВОЁ поле ------------------------------------------------------------------

assert.equal(api.findByLabel(['Название товара на русском']), titleRu)
assert.equal(api.findByLabel(['Название товара на узбекском']), titleUz, 'языки не путаются')
// Самая дорогая ошибка правила: «Полное» и «Краткое» описания стоят рядом и оба «на русском».
assert.equal(api.findByLabel(['Полное описание товара на русском']), fullRu)
assert.equal(api.findByLabel(['Краткое описание товара на русском']), shortRu)
assert.equal(api.findByLabel(['Название категории или товара']), categoryInput)
assert.equal(api.findByLabel(['Такого поля нет']), null, 'ненайденное — это null, а не первое попавшееся')

// Совпадение по НАЧАЛУ строки: у обязательных полей звёздочка, где-то двоеточие, где-то счётчик.
assert.equal(api.findByLabel(['Название товара на русском']), titleRu, 'звёздочка в подписи не мешает')
// Регистр подписи в вёрстке может отличаться от того, что мы записали.
assert.equal(api.findByLabel(['НАЗВАНИЕ ТОВАРА НА РУССКОМ']), titleRu)

// --- Побеждает самая короткая подпись ------------------------------------------------------------
// Здесь правило становится несущим. Общая обёртка «Название товара на узбекском … на русском …»
// начинается с той же строки, что и подпись, и содержит ОБА поля. Взяв обёртку, поиск вернул бы
// первый попавшийся ввод внутри неё — то есть узбекское название вместо русского, и карточка
// уехала бы с перепутанными языками.

const uzInGroup = el('input', { attrs: { id: 'grouped-uz' } })
const ruInGroup = el('input', { attrs: { id: 'grouped-ru' } })
const grouped = el('div', {
  children: [
    el('div', {
      children: [
        el('label', { text: 'Название товара на узбекском *' }), uzInGroup,
        el('label', { text: 'Название товара на русском *' }), ruInGroup,
      ],
    }),
  ],
})
const groupedApi = load(makeDocument(grouped))
assert.equal(groupedApi.findByLabel(['Название товара на русском']), ruInGroup,
  'из общей обёртки выбрано ИМЕННО русское поле, а не первое подряд')
assert.equal(groupedApi.findByLabel(['Название товара на узбекском']), uzInGroup)

// --- Категория подтверждена: поле поиска исчезло, форма открыта -----------------------------------
// Живое поведение Uzum: после «Принять» поле поиска категории ИСЧЕЗАЕТ, на его месте появляются
// путь и кнопка «Изменить», а поля названий открываются. Проверка «есть ли поле поиска» на этом
// шаге объявляла страницу незнакомой ровно тогда, когда всё как раз готово.
//
// Плейсхолдер у обоих названий ОДИН И ТОТ ЖЕ, поэтому различает их соседнее слово.

const confirmedUz = el('input', { attrs: { id: 'c-uz', placeholder: 'Точное название товара' } })
const confirmedRu = el('input', { attrs: { id: 'c-ru', placeholder: 'Точное название товара' } })
const confirmed = el('div', {
  children: [
    el('div', { children: [text('Автотовары > Автозапчасти > Брелоки'), el('button', { text: 'Изменить' })] }),
    el('div', { children: [text('Название товара на узбекском *'), confirmedUz] }),
    el('div', { children: [text('Название товара на русском *'), confirmedRu] }),
  ],
})
const confirmedApi = load(makeDocument(confirmed))

assert.equal(confirmedApi.categoryConfirmed(), true, 'кнопка «Изменить» — признак подтверждённой полки')
assert.equal(api.categoryConfirmed(), false, 'на форме до подтверждения такой кнопки нет')

// Подписи здесь текстовые узлы рядом с полем — тот же путь, что и раньше.
assert.equal(confirmedApi.findField({ labels: ['Название товара на русском'], placeholders: ['Точное название товара'], near: 'на русском' }), confirmedRu)
assert.equal(confirmedApi.findField({ labels: ['Название товара на узбекском'], placeholders: ['Точное название товара'], near: 'на узбекском' }), confirmedUz)

// А теперь ГЛАВНОЕ: подписей нет вовсе, остались только одинаковые плейсхолдеры и слово рядом.
const bareUz = el('input', { attrs: { id: 'b-uz', placeholder: 'Точное название товара' } })
const bareRu = el('input', { attrs: { id: 'b-ru', placeholder: 'Точное название товара' } })
const bare = el('div', {
  children: [
    el('div', { children: [text('Заполните на узбекском'), bareUz] }),
    el('div', { children: [text('Заполните на русском'), bareRu] }),
  ],
})
const bareApi = load(makeDocument(bare))
assert.equal(bareApi.findField({ placeholders: ['Точное название товара'], near: 'на русском' }), bareRu,
  'из двух одинаковых плейсхолдеров выбран русский по соседнему слову')
assert.equal(bareApi.findField({ placeholders: ['Точное название товара'], near: 'на узбекском' }), bareUz)

// И если языка рядом нет — НЕ ГАДАЕМ. Пустое поле правится за минуту, название не на том языке
// снимают с модерации.
const twinsA = el('input', { attrs: { id: 't-a', placeholder: 'Точное название товара' } })
const twinsB = el('input', { attrs: { id: 't-b', placeholder: 'Точное название товара' } })
const twinsApi = load(makeDocument(el('div', { children: [twinsA, twinsB] })))
assert.equal(twinsApi.findField({ placeholders: ['Точное название товара'], near: 'на русском' }), null,
  'два одинаковых поля без указания языка — это отказ, а не первое попавшееся')

// --- Плейсхолдер — это не подпись ----------------------------------------------------------------
// У поля категории подписи нет вовсе: «Название категории или товара» живёт атрибутом ВНУТРИ поля.
// Обход текстовых узлов его не встретит никогда, и первая версия молча не находила категорию.

const withPlaceholder = el('div', {
  children: [
    el('input', { attrs: { id: 'other', placeholder: 'Артикул продавца' } }),
    el('input', { attrs: { id: 'cat', placeholder: 'Название категории или товара' } }),
  ],
})
const placeholderApi = load(makeDocument(withPlaceholder))
const CATEGORY_SPEC = { placeholders: ['Название категории или товара'], labels: ['Категория'] }
assert.equal(placeholderApi.findField(CATEGORY_SPEC).attrs.id, 'cat')
assert.equal(placeholderApi.findByLabel(['Название категории или товара']), null,
  'по подписям это поле НЕ находится — потому и понадобился поиск по плейсхолдеру')
// Соседний плейсхолдер не должен перехватывать: совпадение по началу, а не «где-то внутри».
assert.equal(placeholderApi.findField({ placeholders: ['Артикул'] }).attrs.id, 'other')
assert.equal(placeholderApi.findField({ placeholders: ['Такого нет'], labels: [] }), null)

// --- Ожидаемое, но ненайденное — называется, а не молчит -------------------------------------------
// Молча пропущенное описание и есть та ошибка, которую ищут сутки, глядя на карточку без текста.

const partial = api.fillFields(
  [
    { key: 'titleRu', labels: ['Название товара на русском'], limit: 90, required: true },
    { key: 'descriptionRu', labels: ['Такой подписи в форме нет'], limit: 28_000, rich: true, expected: true },
  ],
  { titleRu: 'Брелок', descriptionRu: 'Текст описания' },
)
assert.deepEqual(partial.filled, ['titleRu'])
assert.deepEqual(partial.notFound, [], 'ожидаемое поле — не отказ')
assert.deepEqual(partial.skipped, ['descriptionRu'], 'но и не молчание')

// --- Поле готово принимать текст только после подтверждения категории ------------------------
// В Uzum названия и описания оживают лишь после выбора полки и кнопки «Принять». До этого они
// заблокированы, и запись в них — это молча ничего не сделать и доложить об успехе.

const locked = el('input', { attrs: { id: 'locked', disabled: true } })
const readonly = el('input', { attrs: { id: 'ro', readonly: true } })
const ariaLocked = el('input', { attrs: { id: 'aria', 'aria-disabled': 'true' } })
assert.equal(api.fieldReady(titleRu), true)
assert.equal(api.fieldReady(locked), false, 'disabled — не готово')
assert.equal(api.fieldReady(readonly), false, 'readOnly — не готово')
assert.equal(api.fieldReady(ariaLocked), false, 'aria-disabled — не готово')
assert.equal(api.fieldReady(null), false, 'поля нет — тем более не готово')

// --- Заполнение ---------------------------------------------------------------------------------

const FIELDS = [
  { key: 'titleUz', labels: ['Название товара на узбекском'], limit: 90, required: true },
  { key: 'titleRu', labels: ['Название товара на русском'], limit: 90, required: true },
  { key: 'descriptionRu', labels: ['Полное описание товара на русском'], limit: 28_000, rich: true },
]

const report = api.fillFields(FIELDS, {
  titleRu: 'Антистресс-брелок',
  titleUz: 'Antistress brelok',
  descriptionRu: 'Первый абзац.\n\n• преимущество\n• ещё одно',
})
assert.deepEqual(report.notFound, [])
assert.deepEqual(report.tooLong, [])
assert.deepEqual(report.filled.sort(), ['descriptionRu', 'titleRu', 'titleUz'])
assert.equal(titleRu.value, 'Антистресс-брелок')
assert.equal(titleUz.value, 'Antistress brelok')
// В <input> значение кладётся сеттером и подтверждается событиями, иначе React его не заметит.
assert.ok(titleRu.events.includes('input') && titleRu.events.includes('change'))
// Редактор форматированного текста заполняется ИНАЧЕ: у него нет value, и присваивание туда
// оставило бы поле пустым при заполненном на вид экране.
assert.equal(fullRu.value, '', 'в редактор значение через value НЕ кладётся')
assert.ok(documentStub.lastInsert.includes('• преимущество'), 'текст ушёл вставкой, сохранив абзацы')

// --- Лимиты Uzum: отказ, а не обрезка --------------------------------------------------------------
// Название на 95 знаков при пределе 90 — не «почти влезло». Обрезанное посреди слова название
// снимают с модерации, и владелец узнаёт об этом через сутки.

const long = api.fillFields(FIELDS, { titleRu: 'я'.repeat(95) })
assert.deepEqual(long.filled, [])
assert.equal(long.tooLong.length, 1)
assert.ok(long.tooLong[0].includes('95 из 90'), 'превышение названо числом, а не «слишком длинно»')
assert.equal(titleRu.value, 'Антистресс-брелок', 'прежнее значение не затёрто обрезком')

// Ровно по границе — проходит. Правило не должно быть «примерно там».
const exact = api.fillFields([FIELDS[1]], { titleRu: 'я'.repeat(90) })
assert.deepEqual(exact.tooLong, [])
assert.deepEqual(exact.filled, ['titleRu'])

// --- Пропавшее поле называется по имени ------------------------------------------------------------

const renamedLabel = api.fillFields(
  [{ key: 'titleRu', labels: ['Наименование товара'], limit: 90, required: true }],
  { titleRu: 'Брелок' },
)
assert.deepEqual(renamedLabel.notFound, ['titleRu'], '«не сработало» без имени поля не чинится')

// Необязательное пропавшее поле молчит: не всякая форма несёт все поля сразу.
const optional = api.fillFields(
  [{ key: 'descriptionUz', labels: ['Поля нет'], limit: 100 }],
  { descriptionUz: 'matn' },
)
assert.deepEqual(optional.notFound, [])

// --- Решение «готова ли форма» — через сам обработчик ---------------------------------------------
// Это та самая ветка, где расширение объявляло страницу незнакомой ровно тогда, когда всё готово.
// Проверять её по кусочкам бесполезно: ошибка была в сочетании условий, а не в отдельной функции.

const TITLES = [
  { key: 'titleUz', labels: ['Название товара на узбекском'], placeholders: ['Точное название товара'], near: 'на узбекском', limit: 90, required: true },
  { key: 'titleRu', labels: ['Название товара на русском'], placeholders: ['Точное название товара'], near: 'на русском', limit: 90, required: true },
]
const CATEGORY_SPEC_FULL = { placeholders: ['Название категории или товара'], labels: ['Категория'] }
const DRAFT = { titleRu: 'Антистресс-брелок', titleUz: 'Antistress brelok', category: 'Брелоки' }

// Категория подтверждена: поля названий открыты, поля поиска больше нет.
const afterConfirm = await confirmedApi.fill({
  type: 'nemo:fill', draft: DRAFT, fields: TITLES, category: CATEGORY_SPEC_FULL, stopSigns: [],
})
assert.equal(afterConfirm.ok, true, 'подтверждённая категория — это ГОТОВАЯ форма, а не незнакомая страница')
assert.deepEqual(afterConfirm.filled.sort(), ['titleRu', 'titleUz'])
assert.equal(confirmedRu.value, 'Антистресс-брелок')
assert.equal(confirmedUz.value, 'Antistress brelok')
assert.equal(afterConfirm.categoryTyped, false, 'подтверждённую полку не переписываем')

// Категория ещё не выбрана: поле поиска на месте, названий нет. Это очередь действий.
const beforeConfirmApi = load(makeDocument(el('div', {
  children: [field('Категория', el('input', { attrs: { placeholder: 'Название категории или товара' } }))],
})))
const beforeConfirm = await beforeConfirmApi.fill({
  type: 'nemo:fill', draft: DRAFT, fields: TITLES, category: CATEGORY_SPEC_FULL, stopSigns: [],
})
assert.equal(beforeConfirm.ok, false)
assert.equal(beforeConfirm.reason, 'category_first', 'человеку говорят про «Принять», а не про поломку')

// Категория ПОДТВЕРЖДЕНА, но полей мы не нашли — например, Uzum переименовал подписи.
//
// Здесь и работает признак «Изменить». Без него совет был бы «нажмите Принять» человеку, который
// её уже нажал: он ходил бы по кругу и винил себя. С ним ответ честный — форму мы не узнали.
const renamedApi = load(makeDocument(el('div', {
  children: [
    el('div', { children: [text('Автотовары > Брелоки'), el('button', { text: 'Изменить' })] }),
    el('div', { children: [text('Наименование по-русски'), el('input', { attrs: { placeholder: 'Введите' } })] }),
  ],
})))
const renamed = await renamedApi.fill({
  type: 'nemo:fill', draft: DRAFT, fields: TITLES, category: CATEGORY_SPEC_FULL, stopSigns: [],
})
assert.equal(renamed.ok, false)
assert.equal(renamed.reason, 'form_changed', 'подтверждённую категорию не предлагают подтвердить ещё раз')
assert.deepEqual(renamed.notFound.sort(), ['titleRu', 'titleUz'])

// Ни полей, ни поиска категории, ни «Изменить» — вот это действительно незнакомая страница.
const strangerApi = load(makeDocument(el('div', { children: [text('Совсем другая страница')] })))
const stranger = await strangerApi.fill({
  type: 'nemo:fill', draft: DRAFT, fields: TITLES, category: CATEGORY_SPEC_FULL, stopSigns: [],
})
assert.equal(stranger.reason, 'form_changed')

console.log('[OK] Extension form behaviour: 55 assertions')
