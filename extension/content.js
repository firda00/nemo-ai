// Заполнение формы Uzum по СМЫСЛУ поля, а не по пути к нему в разметке.
//
// Скрипт НИЧЕГО не делает при загрузке страницы. Он ждёт сообщения от service worker — то есть
// вашего нажатия. Расширение, которое начинает работать само, однажды заполнит форму, открытую
// посмотреть.
//
// КАК ЭТО УСТРОЕНО. Мы не ищем поле по подписи над ним и не ходим по родителям к кнопкам. Мы
// собираем все доступные поля ввода, читаем вокруг каждого его собственный контекст — плейсхолдер,
// aria-label, имя, текст его карточки — и сопоставляем со смыслом: «название» + «русский» это
// title_ru, «описание» + «узбекский» это description_uz. Вёрстка может меняться как угодно, пока
// у полей остаются человеческие слова рядом.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Ни одного `parentElement.children[2]`, ни одной проверки «а на месте ли
// поле категории». Форма Uzum трёхшаговая и перестраивается на ходу: поле поиска категории после
// «Принять» исчезает, поля названий появляются. Правило, завязанное на присутствие конкретного
// узла, ломается от каждой такой перестройки.

/* ─────────────────────────────  Контекст поля  ───────────────────────────── */

/**
 * Собственная карточка поля — наименьший предок, внутри которого НЕТ других полей ввода.
 *
 * Это единственное отличие от наивного `el.closest('div')`, и оно решающее. В сборке Uzum
 * ближайший div почти всегда общая обёртка блока: её текст содержит и «на русском», и «на
 * узбекском» сразу. Взяв его, мы получили бы одинаковый контекст у обоих названий и залили бы
 * русский текст в узбекское поле — просто потому, что оно идёт первым.
 */
function ownCard(el) {
  let node = el.parentElement
  let best = null
  for (let depth = 0; depth < 6 && node; depth++) {
    const others = [...node.querySelectorAll(INPUT_SELECTOR)].filter((one) => one !== el)
    if (others.length) break
    best = node
    node = node.parentElement
  }
  return best
}

const INPUT_SELECTOR = 'input:not([type="hidden"]), textarea, [contenteditable="true"]'

/** Всё, что человек видит рядом с полем, одной строкой в нижнем регистре. */
function contextOf(el) {
  const card = ownCard(el)
  const parts = [
    el.getAttribute?.('placeholder') ?? '',
    el.getAttribute?.('aria-label') ?? '',
    el.getAttribute?.('name') ?? '',
    el.getAttribute?.('id') ?? '',
    card ? (card.innerText ?? card.textContent ?? '') : '',
  ]
  return parts.join(' ').replace(/\s+/g, ' ').toLowerCase()
}

/* ─────────────────────────────  Смыслы  ───────────────────────────── */

/**
 * Признаки полей. Каждый — набор слов, которые ОБЯЗАНЫ встретиться, и набор, которого быть не
 * должно.
 *
 * ЯЗЫК УЗНАЁТСЯ ПО КОРНЮ СЛОВА, А НЕ ПО ДВУМ БУКВАМ. Напрашивалось `ctx.includes('uz')` —
 * и это была бы худшая ошибка во всём файле: мы работаем на сайте с названием Uzum, где «uz»
 * встречается в адресе, шапке, подвале и половине надписей. Такое правило считало бы узбекским
 * КАЖДОЕ поле формы. По той же причине нет и голого 'ru': он сидит внутри «структура», «группа»,
 * «рублей».
 */
const RU = ['русск', 'по-русски', 'rus tilida']
const UZ = ['узбекск', 'o‘zbek', "o'zbek", 'uzbek', 'oʻzbek', 'o`zbek']
const NAME = ['название', 'наименование', 'точное название', 'nomi', 'nomlanishi']
const DESC = ['описание', 'tavsif', 'ta’rif', "ta'rif"]
// Краткое описание — отдельное поле на 390 знаков. Наше описание туда не влезет и будет обрезано
// площадкой посреди мысли, поэтому такие поля исключаются, а не заполняются «чем есть».
const SHORT = ['кратк', 'qisqa']

const TARGETS = [
  { key: 'titleRu', any: NAME, and: RU, not: [...UZ, ...DESC], limit: 90 },
  { key: 'titleUz', any: NAME, and: UZ, not: [...RU, ...DESC], limit: 90 },
  { key: 'descriptionRu', any: DESC, and: RU, not: [...UZ, ...SHORT], limit: 28_000, rich: true },
  { key: 'descriptionUz', any: DESC, and: UZ, not: [...RU, ...SHORT], limit: 28_000, rich: true },
]

const hits = (context, words) => words.filter((word) => context.includes(word)).length

/**
 * Насколько поле похоже на искомое. 0 — не оно.
 *
 * Считается счёт, а не первое совпадение: на странице бывает несколько подходящих полей, и
 * выиграть должно самое похожее, а не то, что попалось раньше.
 */
function score(context, target) {
  if (!context) return 0
  if (hits(context, target.not)) return 0
  const named = hits(context, target.any)
  const qualified = hits(context, target.and)
  if (!named || !qualified) return 0
  return named + qualified
}

/**
 * Кому какое поле досталось.
 *
 * Пары «поле ↔ смысл» разбираются по убыванию счёта, и занятое поле второй раз не выдаётся: одно
 * поле не может быть сразу русским и узбекским названием. Жадный разбор по счёту даёт то же, что
 * сделал бы человек: сначала очевидные совпадения, потом остальные.
 */
function matchFields(elements, targets) {
  const pairs = []
  for (const element of elements) {
    const context = contextOf(element)
    for (const target of targets) {
      const value = score(context, target)
      if (value > 0) pairs.push({ element, target, value })
    }
  }
  pairs.sort((a, b) => b.value - a.value)

  const byKey = new Map()
  const taken = new Set()
  for (const pair of pairs) {
    if (byKey.has(pair.target.key) || taken.has(pair.element)) continue
    byKey.set(pair.target.key, pair.element)
    taken.add(pair.element)
  }
  return byKey
}

/* ─────────────────────────────  Ввод  ───────────────────────────── */

/**
 * Ввод, который замечает React.
 *
 * Присваивание `element.value` меняет DOM, но не состояние компонента: поле выглядит заполненным,
 * а при отправке уходит пустым. Значение ставится нативным сеттером, затем вручную посылаются
 * события, которые слушает React. blur добавлен намеренно: на нём многие формы запускают проверку
 * поля, и без него поле остаётся подсвеченным как незаполненное.
 */
function setInputValue(element, value) {
  if (!element || value == null) return false
  element.focus?.()
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(element, String(value))
  else element.value = String(value)
  for (const type of ['input', 'change', 'blur']) {
    element.dispatchEvent(new Event(type, { bubbles: true }))
  }
  return true
}

/**
 * Ввод в редактор форматированного текста.
 *
 * НЕ innerHTML. Напрашивается именно он, и именно он даёт худший из возможных исходов: редакторы
 * вроде ProseMirror и Slate держат текст в своей модели, а не в DOM. Присвоенный innerHTML они
 * либо стирают на следующей перерисовке, либо оставляют на экране при пустой модели — и описание
 * уходит на модерацию пустым, хотя на экране оно было.
 *
 * insertText через execCommand порождает те же события, что живая клавиатура, поэтому редактор
 * принимает текст своим и сохраняет абзацы, которые видел владелец.
 */
function setRichValue(element, value) {
  if (!element || value == null) return false
  element.focus?.()
  const selection = window.getSelection?.()
  if (selection && document.createRange) {
    const range = document.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  document.execCommand('insertText', false, String(value))
  element.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/* ─────────────────────────────  Остановка ради человека  ───────────────────────────── */

/**
 * Капча и незнакомые окна. Единственная оставшаяся проверка страницы — и она не про структуру
 * формы, а про то, где нажимать вслепую нельзя.
 */
function findStopSign(stopSigns) {
  for (const selector of stopSigns ?? []) {
    if (document.querySelector(selector)) return selector
  }
  return null
}

/** Готово ли поле принимать текст: до подтверждения категории Uzum держит их заблокированными. */
function fieldReady(element) {
  if (!element) return false
  if (element.disabled || element.readOnly) return false
  return element.getAttribute?.('aria-disabled') !== 'true'
}

/* ─────────────────────────────  Заполнение  ───────────────────────────── */

/**
 * Заполняет то, что нашлось, и рассказывает, чего не нашлось.
 *
 * Блокирующих проверок структуры здесь нет: нажали кнопку — ищем поля и заливаем. Но «ничего не
 * нашли» и «всё заполнено» остаются РАЗНЫМИ ответами. Молчаливый успех при пустой карточке — это
 * не простота, а ложь, которая всплывёт через сутки на модерации.
 */
function fillCard(draft, targets) {
  const elements = [...document.querySelectorAll(INPUT_SELECTOR)]
  const matched = matchFields(elements, targets)

  const filled = []
  const missing = []
  const tooLong = []
  const locked = []

  for (const target of targets) {
    const value = draft?.[target.key]
    if (value == null || value === '') continue
    const element = matched.get(target.key)
    if (!element) { missing.push(target.key); continue }
    // Лимит Uzum не обрезается: название на 95 знаков при пределе 90 снимут с модерации, и
    // владелец узнает об этом через сутки. Сократить — его решение.
    if (target.limit && String(value).length > target.limit) {
      tooLong.push(`${target.key}: ${String(value).length} из ${target.limit}`)
      continue
    }
    if (!fieldReady(element)) { locked.push(target.key); continue }
    const ok = target.rich || element.isContentEditable
      ? setRichValue(element, value)
      : setInputValue(element, value)
    if (ok) filled.push(target.key)
    else missing.push(target.key)
  }
  return { filled, missing, tooLong, locked, seen: elements.length }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nemo:fill') return undefined

  const { draft, stopSigns, categoryHint } = message
  ;(async () => {
    const stop = findStopSign(stopSigns)
    if (stop) {
      sendResponse({ ok: false, reason: 'human_needed', detail: `остановился на экране: ${stop}` })
      return
    }

    const report = fillCard(draft ?? {}, TARGETS)

    if (report.tooLong.length) {
      sendResponse({ ok: false, reason: 'too_long', filled: report.filled, tooLong: report.tooLong })
      return
    }

    // Ни одного поля не заполнено — надо сказать, почему, и причина у этого ровно одна известная:
    // категория ещё не подтверждена, и Uzum держит форму закрытой. Это не блокирующая проверка
    // структуры, а вывод ИЗ РЕЗУЛЬТАТА: мы попробовали и не нашли, куда писать.
    if (!report.filled.length) {
      const searching = [...document.querySelectorAll(INPUT_SELECTOR)]
        .some((element) => contextOf(element).includes(String(categoryHint ?? 'категор').toLowerCase()))
      sendResponse({
        ok: false,
        reason: report.locked.length || searching ? 'category_first' : 'form_changed',
        missing: report.missing,
      })
      return
    }

    // РАСШИРЕНИЕ НЕ НАЖИМАЕТ НИЧЕГО. Заполнило поля и остановилось: переход по шагам делает
    // человек, когда проверит текст глазами.
    sendResponse({ ok: true, filled: report.filled, skipped: [...report.missing, ...report.locked] })
  })()

  // Ответ уходит асинхронно — без этого канал закрывается раньше, чем в него что-то написали.
  return true
})
