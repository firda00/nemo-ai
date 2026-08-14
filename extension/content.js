// Заполнение формы в кабинете Uzum.
//
// Скрипт НИЧЕГО не делает при загрузке страницы. Он ждёт сообщения от service worker — то есть
// вашего нажатия или включённого вами тумблера. Расширение, которое начинает работать само,
// стоит открыть кабинет, однажды заполнит форму, которую вы открыли посмотреть.
//
// Поля ищутся ПО ПОДПИСЯМ, а не по классам: `.css-1x2y3z` меняется при каждом релизе Uzum и
// ломается молча, а «Название товара на русском» держится за смысл поля.

const MAX_LABEL_DEPTH = 4

/** Текст узла без внутренних переносов: подпись «Название\n товара» — это та же подпись. */
function labelText(node) {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Ввод, связанный с подписью.
 *
 * Сначала честный путь: <label for="…">. Если разметка его не даёт — поднимаемся от подписи вверх
 * и ищем ввод рядом. Глубина ограничена: с четвёртого предка «рядом» превращается в «где-то на
 * странице», и можно принести поле соседнего блока.
 */
const CONTROLS = 'input, textarea, [contenteditable="true"]'

/** Идёт ли узел ПОСЛЕ подписи в порядке документа. 4 — DOCUMENT_POSITION_FOLLOWING. */
function follows(labelNode, candidate) {
  return (labelNode.compareDocumentPosition(candidate) & 4) !== 0
}

function controlFor(labelNode) {
  const forId = labelNode.getAttribute?.('for')
  if (forId) {
    const byId = document.getElementById(forId)
    if (byId) return byId
  }
  let node = labelNode
  for (let depth = 0; depth < MAX_LABEL_DEPTH && node; depth++) {
    const candidates = [...(node.querySelectorAll?.(CONTROLS) ?? [])]
    if (candidates.length) {
      // Берём ПЕРВЫЙ ввод ПОСЛЕ подписи, а не первый в контейнере.
      //
      // Это не придирка к порядку. В вёрстке «подпись, поле, подпись, поле» обе подписи лежат в
      // одной обёртке, и первый ввод контейнера принадлежит СОСЕДНЕЙ подписи. Так русское
      // название уезжало в узбекское поле — карточка с перепутанными языками, которую снимают
      // с модерации, а причину ищут в переводчике.
      const after = candidates.find((candidate) => follows(labelNode, candidate))
      // Ничего после подписи нет — значит поле стоит перед ней; такая вёрстка тоже встречается.
      return after ?? candidates[0]
    }
    node = node.parentElement
  }
  return null
}

/**
 * Поиск поля по началу подписи.
 *
 * Совпадение по НАЧАЛУ строки: у обязательных полей рисуют звёздочку, где-то ставят двоеточие,
 * где-то дописывают счётчик символов. Точное равенство ломалось бы на этих хвостах.
 *
 * Побеждает самый КОРОТКИЙ подходящий узел: подпись — наименьший узел, содержащий эти слова, а её
 * предки содержат их вместе с соседними полями. Это сужает область поиска и делает подъём вверх
 * коротким и предсказуемым.
 *
 * От чужого поля защищает не это, а порядок документа в controlFor: проверено мутацией — снятие
 * правила про короткий узел тесты не роняет, снятие правила про порядок роняет сразу.
 */
function findByLabel(labels) {
  const nodes = [...document.querySelectorAll('label, span, div, p')]
  let best = null
  for (const node of nodes) {
    const text = labelText(node)
    if (!text || text.length > 200) continue
    const matches = labels.some((label) => text.toLowerCase().startsWith(label.toLowerCase()))
    if (!matches) continue
    if (!best || text.length < labelText(best).length) best = node
  }
  return best ? controlFor(best) : null
}

/** Кнопка по её надписи. Кнопок на странице много, и «Принять» — не то же, что «Сохранить». */
function findButton(caption) {
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
  return buttons.find((button) => labelText(button).toLowerCase() === caption.toLowerCase())
    ?? buttons.find((button) => labelText(button).toLowerCase().startsWith(caption.toLowerCase()))
    ?? null
}

/**
 * Ввод, который замечает React.
 *
 * Присваивание `element.value` меняет DOM, но не состояние компонента: поле выглядит заполненным,
 * а при отправке уходит пустым. Значение ставится через нативный сеттер, после чего вручную
 * посылается событие, которое React слушает.
 */
function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(element, value)
  else element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Ввод в редактор форматированного текста.
 *
 * Это не <input>: у него нет `value`, и присваивание туда не делает ничего. Текст кладётся через
 * insertText — редактор сам построит свою разметку, и структура описания (крючок, абзацы, список)
 * останется той, что видел владелец. Присваивание innerHTML напрямую даёт заполненный на вид
 * редактор с пустым состоянием внутри.
 */
function setRichValue(element, value) {
  element.focus()
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
  // insertText кладётся именно через execCommand: он единственный порождает те же события ввода,
  // что и живая клавиатура, и редакторы на его основе видят текст своим.
  document.execCommand('insertText', false, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function findStopSign(stopSigns) {
  for (const selector of stopSigns) {
    const found = document.querySelector(selector)
    if (found) return selector
  }
  return null
}

/**
 * Заполнение полей шага 1.
 *
 * Возвращает отчёт, а не бросает исключение: половина заполненной формы — это состояние, о
 * котором надо рассказать, а не потерять в стеке.
 *
 * ЛИМИТЫ НЕ ОБРЕЗАЮТСЯ. Название на 95 знаков при пределе 90 — это не «почти влезло»: обрезанное
 * посреди слова название снимают с модерации, и владелец узнает об этом через сутки. Поле
 * пропускается, а превышение называется числом.
 */
function fillFields(fields, draft) {
  const filled = []
  const notFound = []
  const tooLong = []

  for (const field of fields) {
    const value = draft[field.key]
    if (!value) continue
    const text = String(value)
    if (field.limit && text.length > field.limit) {
      tooLong.push(`${field.key}: ${text.length} из ${field.limit}`)
      continue
    }
    const control = findByLabel(field.labels)
    if (!control) {
      if (field.required) notFound.push(field.key)
      continue
    }
    if (field.rich || control.isContentEditable) setRichValue(control, text)
    else setNativeValue(control, text)
    filled.push(field.key)
  }
  return { filled, notFound, tooLong }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nemo:fill') return undefined

  const { draft, fields, category, stepButton, stopSigns, advance } = message
  ;(async () => {
    // Проверка на «здесь нельзя» идёт ПЕРВОЙ, до единого символа в полях. Заполнить форму и
    // только потом заметить капчу — значит оставить в кабинете полуготовую карточку.
    const stop = findStopSign(stopSigns ?? [])
    if (stop) {
      sendResponse({ ok: false, reason: 'human_needed', detail: `остановился на экране: ${stop}` })
      return
    }

    const report = fillFields(fields ?? [], draft ?? {})
    if (report.tooLong.length) {
      sendResponse({
        ok: false, reason: 'too_long', filled: report.filled,
        detail: `не влезает в лимиты Uzum — ${report.tooLong.join('; ')}. Сократите текст в Nemo.`,
      })
      return
    }
    if (report.notFound.length) {
      sendResponse({
        ok: false, reason: 'form_changed', filled: report.filled,
        detail: `поля не найдены по подписям: ${report.notFound.join(', ')}`,
      })
      return
    }

    // Категория — поле поиска с подтверждением, и список предложений мы не видели ни разу.
    // Запрос вводится, выбор остаётся человеку: полка задаёт комиссию, характеристики и судьбу
    // карточки на модерации, и ошибка здесь стоит повторной заливки.
    let categoryTyped = false
    if (draft.category && category?.labels?.length) {
      const control = findByLabel(category.labels)
      if (control) { setNativeValue(control, String(draft.category)); categoryTyped = true }
    }

    if (!advance) {
      sendResponse({ ok: true, filled: report.filled, categoryTyped, advanced: false })
      return
    }

    // Экран мог смениться, пока заполнялись поля. Проверка повторяется вплотную к нажатию:
    // именно между заполнением и кликом появляется подтверждение, которого никто не ждал.
    const lateStop = findStopSign(stopSigns ?? [])
    if (lateStop) {
      sendResponse({ ok: false, reason: 'human_needed', filled: report.filled, detail: `экран сменился перед переходом: ${lateStop}` })
      return
    }
    const button = stepButton ? findButton(stepButton) : null
    if (!button) {
      sendResponse({ ok: false, reason: 'form_changed', filled: report.filled, detail: `кнопка «${stepButton}» не найдена` })
      return
    }
    button.click()
    sendResponse({ ok: true, filled: report.filled, categoryTyped, advanced: true })
  })()

  // Ответ уходит асинхронно — без этого канал закрывается раньше, чем в него что-то написали.
  return true
})
