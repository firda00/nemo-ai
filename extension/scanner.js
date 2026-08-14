// Универсальный сканер страницы.
//
// Задача одна: превратить произвольную веб-страницу в компактный список того, с чем вообще можно
// взаимодействовать, и выдать каждому элементу временный номер. Дальше и модель, и исполнитель
// говорят номерами — никто не передаёт друг другу селекторы, пути к узлам и уж тем более куски
// разметки.
//
// ПОЧЕМУ НОМЕРА, А НЕ СЕЛЕКТОРЫ. Селектор, отданный наружу и вернувшийся обратно, — это способ
// исполнить произвольный запрос к странице: модель (или тот, кто подменит её ответ) сможет указать
// на элемент, которого мы ей не показывали. Номер выдаём мы, и он действует только внутри одного
// снимка: чего не было в снимке — того нельзя коснуться.

const NEMO_ID = 'data-nemo-id'

/** Что вообще считается интерактивным. Список намеренно узкий: скан — не карта всей страницы. */
const INTERACTIVE = [
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[contenteditable="true"]',
  'button',
  '[role="button"]',
  '[role="combobox"]',
  '[role="textbox"]',
  'a[href]',
].join(', ')

/** Видимо ли поле человеку. Невидимое поле — это либо мусор разметки, либо ловушка для ботов. */
function visible(element) {
  const style = window.getComputedStyle?.(element)
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false
  const box = element.getBoundingClientRect?.()
  if (!box) return true
  return box.width > 0 && box.height > 0
}

/**
 * Собственная карточка элемента — наименьший предок, внутри которого нет ДРУГИХ интерактивных
 * элементов.
 *
 * Это ключевая мера предосторожности всего сканера. Наивный `closest('div')` почти всегда даёт
 * общую обёртку блока, и тогда контекст у соседних полей получается одинаковым: у обоих названий
 * оказалось бы написано и «на русском», и «на узбекском». Дальше любое сопоставление по смыслу
 * выбирает первое попавшееся — и текст уезжает не в то поле.
 */
function ownCard(element) {
  let node = element.parentElement
  let best = null
  for (let depth = 0; depth < 8 && node; depth++) {
    const others = [...node.querySelectorAll(INTERACTIVE)].filter((one) => one !== element)
    if (others.length) break
    best = node
    node = node.parentElement
  }
  return best
}

/**
 * Подпись, привязанная к полю по-настоящему: <label for>, aria-labelledby, объемлющий label.
 *
 * Ищется отдельно от «текста вокруг», потому что это не догадка, а объявленная разработчиком
 * связь. Если она есть — она точнее любого соседнего текста.
 */
function boundLabel(element) {
  const id = element.getAttribute?.('id')
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape ? CSS.escape(id) : id}"]`)
    if (label) return label.innerText ?? label.textContent ?? ''
  }
  const labelledBy = element.getAttribute?.('aria-labelledby')
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/)
      .map((one) => document.getElementById(one))
      .filter(Boolean)
      .map((node) => node.innerText ?? node.textContent ?? '')
    if (parts.length) return parts.join(' ')
  }
  const wrapping = element.closest?.('label')
  if (wrapping) return wrapping.innerText ?? wrapping.textContent ?? ''
  return ''
}

/**
 * Текст НАД полем — до восьми предков вверх, пока не встретится другое поле.
 *
 * Редакторы описания в реальных формах стоят «блоком ниже» подписи: между надписью и самим
 * редактором лежат панель инструментов и пара обёрток. Собственная карточка такого редактора
 * подписи не содержит, и без этого подъёма поле остаётся без смысла — ровно та причина, по которой
 * описания оставались пустыми, когда названия вставали.
 */
function nearbyText(element) {
  const card = ownCard(element) ?? element.parentElement
  const seen = []
  let node = card
  for (let depth = 0; depth < 4 && node; depth++) {
    const text = (node.innerText ?? node.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text && text.length < 400) seen.push(text)
    // Поднимаемся, пока предок не начал включать другие поля: их подписи — не наши.
    const parent = node.parentElement
    if (!parent) break
    const others = [...parent.querySelectorAll(INTERACTIVE)].filter((one) => one !== element)
    if (others.length > 0 && seen.length) break
    node = parent
  }
  return seen.join(' ')
}

/** Чем элемент является с точки зрения действия над ним. */
function kindOf(element) {
  const tag = (element.tagName ?? '').toLowerCase()
  if (tag === 'select') return 'select'
  if (tag === 'textarea') return 'textarea'
  if (element.isContentEditable) return 'richtext'
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase()
    if (['checkbox', 'radio'].includes(type)) return type
    if (type === 'file') return 'file'
    return 'input'
  }
  if (tag === 'a') return 'link'
  return 'button'
}

/**
 * Похоже ли действие на необратимое.
 *
 * Список слов, а не точных подписей: он работает на любом сайте и на двух языках. Нужен не для
 * запрета, а для отметки — исполнитель по такой отметке спросит человека, прежде чем нажать.
 * Ошибиться в сторону лишнего вопроса дёшево; нажать «Удалить» по плану модели — нет.
 */
const RISKY = [
  'удал', 'delete', 'o‘chir', 'ochir',
  'отправ', 'submit', 'publish', 'опубликов', 'модерац',
  'оплат', 'pay', 'купить', 'checkout', 'to‘la',
  'подтверд', 'confirm', 'сохранит', 'save',
  'выход', 'logout', 'разлог',
]

function risky(label) {
  const text = (label ?? '').toLowerCase()
  return RISKY.some((word) => text.includes(word))
}

/**
 * Снимок страницы.
 *
 * Возвращает компактное дерево: номер, вид, подпись, плейсхолдер, текущее значение и окружающий
 * текст. Разметка наружу НЕ уходит — ни html, ни классы, ни селекторы. Наружу уходит только то,
 * что видит человек, и по чему можно принять решение.
 */
function scanPage(limit = 120) {
  // Прежние номера снимаются: снимок действует до следующего скана, и старый номер не должен
  // случайно указать на другой элемент после перерисовки страницы.
  for (const stale of document.querySelectorAll(`[${NEMO_ID}]`)) stale.removeAttribute(NEMO_ID)

  const elements = [...document.querySelectorAll(INTERACTIVE)].filter(visible)
  const items = []
  for (const element of elements.slice(0, limit)) {
    const id = items.length + 1
    element.setAttribute(NEMO_ID, String(id))
    const label = (boundLabel(element) || '').replace(/\s+/g, ' ').trim()
    const own = (element.innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim()
    const kind = kindOf(element)
    // Пометка остаётся НА ЭЛЕМЕНТЕ, а не только в отчёте. Исполнитель читает её сам и не полагается
    // на то, что скажет пришедший план: план приходит снаружи, а пометку ставили мы.
    if (risky(`${label} ${own}`)) element.setAttribute('data-nemo-risky', 'true')
    else element.removeAttribute('data-nemo-risky')
    items.push({
      id,
      kind,
      label: label.slice(0, 160),
      text: kind === 'button' || kind === 'link' ? own.slice(0, 80) : '',
      placeholder: (element.getAttribute?.('placeholder') ?? '').slice(0, 160),
      name: (element.getAttribute?.('name') ?? '').slice(0, 80),
      // Значение полезно модели, чтобы не переписывать уже заполненное. Обрезается коротко:
      // содержимое чужой страницы не должно уезжать наружу целиком.
      value: kind === 'richtext' ? own.slice(0, 120) : String(element.value ?? '').slice(0, 120),
      disabled: Boolean(element.disabled) || element.getAttribute?.('aria-disabled') === 'true',
      context: nearbyText(element).slice(0, 300),
      risky: risky(`${label} ${own}`),
      ...(kind === 'select'
        ? { options: [...(element.options ?? [])].slice(0, 40).map((one) => (one.text ?? '').trim().slice(0, 80)) }
        : {}),
    })
  }
  return { url: location.href, title: document.title, count: elements.length, items }
}

/** Элемент по выданному номеру. Ничего, кроме номера, снаружи не принимается. */
function elementById(id) {
  if (!Number.isInteger(Number(id))) return null
  return document.querySelector(`[${NEMO_ID}="${Number(id)}"]`)
}
