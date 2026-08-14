// Семантический резолвер полей — проверен на макетах формы.
//
// Разметки живой страницы у меня по-прежнему нет, и в этом весь смысл подхода: правило смотрит не
// на структуру, а на слова вокруг поля. Поэтому проверяется именно оно — как из контекста
// получается «это русское название», и как оно НЕ ошибается там, где ошибиться легче всего.
//
// Это не доказательство, что расширение заполнит настоящую форму: такое даёт только запуск в
// кабинете. Это доказательство, что ошибётся оно не здесь.

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
    return [this.ownText, ...this.children.map((child) => child.textContent)].join(' ').trim()
  }
  get innerText() { return this.textContent }
  get isContentEditable() { return this.attrs.contenteditable === 'true' }
  // В настоящем DOM свойства disabled и readOnly отражают одноимённые атрибуты. Макет обязан
  // делать то же самое, иначе проверка готовности поля тестируется мимо.
  get disabled() { return Boolean(this.attrs.disabled) }
  get readOnly() { return Boolean(this.attrs.readonly) }
  getAttribute(name) { return this.attrs[name] ?? null }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]) }
  matches(selector) {
    if (selector === 'input:not([type="hidden"])') return this.tag === 'input' && this.attrs.type !== 'hidden'
    if (selector === 'input') return this.tag === 'input'
    if (selector === 'textarea') return this.tag === 'textarea'
    if (selector === '[contenteditable="true"]') return this.attrs.contenteditable === 'true'
    // Стоп-признаки записаны как «атрибут содержит подстроку»: [class*="captcha" i]. Без их
    // поддержки макет молча пропускал бы капчу, и проверка про остановку тестировалась бы мимо.
    const contains = selector.match(/^(\w*)\[(\w+)\*="([^"]+)"( i)?\]$/)
    if (contains) {
      const [, tag, attr, needle] = contains
      if (tag && this.tag !== tag) return false
      return String(this.attrs[attr] ?? '').toLowerCase().includes(needle.toLowerCase())
    }
    return ['label', 'span', 'div', 'p', 'button'].includes(selector) && this.tag === selector
  }
  querySelector(list) { return this.querySelectorAll(list)[0] ?? null }
  querySelectorAll(list) {
    const selectors = list.split(',').map((one) => one.trim())
    return this.descendants().filter((node) => selectors.some((one) => node.matches(one)))
  }
  dispatchEvent(event) { this.events.push(event.type ?? String(event)); return true }
  focus() { this.focused = true }
}

const el = (tag, options) => new Node(tag, options)
const text = (value) => el('span', { text: value })

function makeDocument(pageRoot) {
  return {
    querySelectorAll(list) {
      const selectors = list.split(',').map((one) => one.trim())
      return [pageRoot, ...pageRoot.descendants()].filter((node) => selectors.some((one) => node.matches(one)))
    },
    querySelector(list) { return this.querySelectorAll(list)[0] ?? null },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(_command, _ui, value) { this.lastInsert = value; return true },
  }
}

function load(documentStub) {
  // Обработчик ловится: решение «что заполнили / чего не нашли» живёт в нём, и по кускам оно не
  // проверяется.
  let handler = null
  const chromeStub = { runtime: { onMessage: { addListener(fn) { handler = fn } } } }
  const windowStub = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) }
  class HTMLInputElement { }
  class HTMLTextAreaElement { }
  const factory = new Function(
    'chrome', 'document', 'window', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event',
    `${source}\nreturn { contextOf, score, matchFields, fillCard, fieldReady, setInputValue, setRichValue, TARGETS }`,
  )
  const api = factory(
    chromeStub, documentStub, windowStub, HTMLInputElement, HTMLTextAreaElement,
    class { constructor(type) { this.type = type } },
  )
  api.fill = (message) => new Promise((resolve) => handler(message, null, resolve))
  return api
}

/** Поле с подписью в собственной карточке — так устроена форма Uzum. */
const cardField = (label, control) => el('div', { children: [text(label), control] })

/* ─────────────────────────  Форма после подтверждения категории  ───────────────────────── */

const titleUz = el('input', { attrs: { placeholder: 'Точное название товара' } })
const titleRu = el('input', { attrs: { placeholder: 'Точное название товара' } })
const shortRu = el('textarea', { attrs: {} })
const fullRu = el('div', { attrs: { contenteditable: 'true' } })
const fullUz = el('div', { attrs: { contenteditable: 'true' } })

const page = el('div', {
  children: [
    // Хлебные крошки и шапка кабинета — здесь «Uzum» встречается на каждой странице.
    el('div', { children: [text('Uzum Seller · Автотовары > Брелоки'), el('button', { text: 'Изменить' })] }),
    cardField('Название товара на узбекском *', titleUz),
    cardField('Название товара на русском *', titleRu),
    cardField('Краткое описание товара на русском', shortRu),
    cardField('Полное описание товара на русском', fullRu),
    cardField('Полное описание товара на узбекском', fullUz),
  ],
})

const documentStub = makeDocument(page)
const api = load(documentStub)

// --- Главная ловушка: «uz» внутри слова Uzum ------------------------------------------------------
// Напрашивалось `ctx.includes('uz')`. Мы работаем на сайте с названием Uzum, где эти две буквы
// стоят в адресе, шапке и подвале: такое правило считало бы узбекским КАЖДОЕ поле формы, и русское
// название легло бы в узбекское поле на каждой карточке.

const ruContext = api.contextOf(titleRu)
assert.ok(ruContext.includes('на русском'), 'контекст поля собран из его собственной карточки')
assert.equal(ruContext.includes('на узбекском'), false, 'соседняя карточка в контекст НЕ попадает')

const uzTarget = api.TARGETS.find((one) => one.key === 'titleUz')
const ruTarget = api.TARGETS.find((one) => one.key === 'titleRu')
assert.equal(api.score(ruContext, uzTarget), 0, 'русское поле не выигрывает узбекский смысл')
assert.ok(api.score(ruContext, ruTarget) > 0)
// Слово Uzum само по себе языком поля не делает.
assert.equal(api.score('uzum seller точное название товара', uzTarget), 0)
assert.equal(api.score('uzum seller точное название товара', ruTarget), 0, 'без языка — не угадываем вовсе')

// --- Кто какое поле получил -----------------------------------------------------------------------

const matched = api.matchFields([...documentStub.querySelectorAll('input, textarea, [contenteditable="true"]')], api.TARGETS)
assert.equal(matched.get('titleRu'), titleRu)
assert.equal(matched.get('titleUz'), titleUz)
assert.equal(matched.get('descriptionRu'), fullRu)
assert.equal(matched.get('descriptionUz'), fullUz)
// Краткое описание на 390 знаков — не то же, что полное. Наш текст туда не влезет и будет обрезан
// площадкой посреди мысли.
assert.notEqual(matched.get('descriptionRu'), shortRu, 'краткое описание не путается с полным')

// Одно поле не может достаться двум смыслам сразу.
const claimed = [...matched.values()]
assert.equal(new Set(claimed).size, claimed.length)

// --- Заполнение -----------------------------------------------------------------------------------

const DRAFT = {
  titleRu: 'Антистресс-брелок',
  titleUz: 'Antistress brelok',
  descriptionRu: 'Первый абзац.\n\n• преимущество\n• ещё одно',
}
const filled = await api.fill({ type: 'nemo:fill', draft: DRAFT, stopSigns: [], categoryHint: 'категор' })

assert.equal(filled.ok, true)
assert.deepEqual(filled.filled.sort(), ['descriptionRu', 'titleRu', 'titleUz'])
assert.equal(titleRu.value, 'Антистресс-брелок')
assert.equal(titleUz.value, 'Antistress brelok')
// Событие blur обязательно: на нём форма запускает проверку поля, и без него оно остаётся
// подсвеченным как незаполненное.
for (const type of ['input', 'change', 'blur']) assert.ok(titleRu.events.includes(type), type)

// Редактор форматированного текста заполняется ИНАЧЕ. innerHTML здесь дал бы худший исход:
// ProseMirror и Slate держат текст в своей модели, и присвоенная разметка либо стирается на
// перерисовке, либо остаётся на экране при пустой модели — описание уходит на модерацию пустым.
assert.equal(fullRu.value, '', 'в редактор значение через value НЕ кладётся')
assert.ok(documentStub.lastInsert, 'редактор заполнен ВСТАВКОЙ, а не присваиванием innerHTML')
assert.ok(documentStub.lastInsert.includes('• преимущество'), 'текст ушёл вставкой, абзацы целы')
// Узбекского описания в черновике не было — поле осталось пустым и НАЗВАНО.
assert.deepEqual(filled.skipped, [])

// --- Лимиты Uzum: отказ, а не обрезка --------------------------------------------------------------

const longPage = el('div', { children: [cardField('Название товара на русском *', el('input', { attrs: {} }))] })
const longApi = load(makeDocument(longPage))
const long = await longApi.fill({ type: 'nemo:fill', draft: { titleRu: 'я'.repeat(95) }, stopSigns: [] })
assert.equal(long.ok, false)
assert.equal(long.reason, 'too_long')
assert.ok(long.tooLong[0].includes('95 из 90'), 'превышение названо числом, а не «слишком длинно»')

// --- Ничего не нашли: причина, а не молчаливый успех -----------------------------------------------
// «Заполнено» при пустой карточке — это не простота, а ложь, которая всплывёт на модерации.

const beforeCategory = el('div', {
  children: [cardField('Категория', el('input', { attrs: { placeholder: 'Название категории или товара' } }))],
})
const beforeApi = load(makeDocument(beforeCategory))
const before = await beforeApi.fill({ type: 'nemo:fill', draft: DRAFT, stopSigns: [], categoryHint: 'категор' })
assert.equal(before.ok, false)
assert.equal(before.reason, 'category_first', 'человеку говорят про «Принять», а не про поломку')

const stranger = load(makeDocument(el('div', { children: [text('Совсем другая страница')] })))
const strange = await stranger.fill({ type: 'nemo:fill', draft: DRAFT, stopSigns: [], categoryHint: 'категор' })
assert.equal(strange.reason, 'form_changed')

// --- Заблокированные поля --------------------------------------------------------------------------
// До подтверждения категории Uzum держит поля закрытыми. Писать в них — это молча ничего не
// сделать и доложить об успехе.

const lockedInput = el('input', { attrs: { disabled: true } })
const lockedPage = el('div', { children: [cardField('Название товара на русском *', lockedInput)] })
const lockedApi = load(makeDocument(lockedPage))
assert.equal(lockedApi.fieldReady(lockedInput), false)
const lockedRun = await lockedApi.fill({ type: 'nemo:fill', draft: { titleRu: 'Брелок' }, stopSigns: [], categoryHint: 'категор' })
assert.equal(lockedRun.ok, false)
assert.equal(lockedRun.reason, 'category_first', 'закрытая форма — это очередь действий, а не поломка')
assert.equal(lockedInput.value, '', 'в заблокированное поле ничего не записано')

// --- Капча важнее всего ----------------------------------------------------------------------------

const captchaPage = el('div', {
  children: [
    el('div', { attrs: { class: 'captcha-box' } }),
    cardField('Название товара на русском *', el('input', { attrs: {} })),
  ],
})
const captchaApi = load(makeDocument(captchaPage))
const captcha = await captchaApi.fill({
  type: 'nemo:fill', draft: DRAFT, stopSigns: ['[class*="captcha" i]'], categoryHint: 'категор',
})
assert.equal(captcha.ok, false)
assert.equal(captcha.reason, 'human_needed')

console.log('[OK] Semantic form behaviour: 31 assertions')
