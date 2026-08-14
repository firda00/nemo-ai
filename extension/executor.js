// Универсальный исполнитель действий.
//
// Принимает только номера из последнего снимка страницы и три действия: ввести текст, нажать,
// выбрать значение. Ни селекторов, ни произвольного кода — что не попало в снимок, тем нельзя
// управлять.
//
// Каждое действие возвращает ОТЧЁТ, а не булево «получилось». Пайплайн из десяти шагов, где
// седьмой молча не сработал, — это карточка, отправленная наполовину, и день на выяснение, чья
// это была половина.

/**
 * Ввод, который замечает React и Vue.
 *
 * Присваивание `element.value` меняет DOM, но не состояние компонента: поле выглядит заполненным,
 * а при отправке уходит пустым. Значение ставится нативным сеттером, дальше вручную посылаются
 * события. blur обязателен: на нём формы запускают проверку поля, и без него оно остаётся
 * подсвеченным как незаполненное.
 */
function typeIntoInput(element, text) {
  element.focus?.()
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(element, String(text))
  else element.value = String(text)
  for (const type of ['input', 'change', 'blur']) {
    element.dispatchEvent(new Event(type, { bubbles: true }))
  }
  return String(element.value ?? '') === String(text) ? 'native-setter' : 'native-setter-unverified'
}

/**
 * Ввод в редактор форматированного текста — ТРЕМЯ способами по очереди, до первого сработавшего.
 *
 * Почему не одним. Редакторы держат текст в собственной модели, а не в DOM, и каждый принимает
 * ввод по-своему:
 *
 *   1. beforeinput с insertText — то, что порождает настоящая клавиатура. ProseMirror и Lexical
 *      слушают именно его и обновляют модель;
 *   2. execCommand('insertText') — старый путь, который до сих пор понимают Quill и Slate;
 *   3. присваивание textContent с событием input — последняя попытка для простых
 *      contenteditable-полей без всякой модели.
 *
 * innerHTML не используется НИГДЕ. Он даёт худший исход из возможных: текст появляется на экране,
 * модель редактора остаётся пустой, и описание уходит на модерацию пустым — при том что владелец
 * своими глазами видел его заполненным. Именно так описания и остались пустыми в прошлой версии.
 *
 * Результат ПРОВЕРЯЕТСЯ чтением обратно. Способ, который «выполнился без ошибки», но ничего не
 * изменил, — это и есть молчаливый провал, который мы ловим.
 */
function typeIntoRichText(element, text) {
  const wanted = String(text)
  const reads = () => (element.innerText ?? element.textContent ?? '').trim()

  const selectAll = () => {
    element.focus?.()
    const selection = window.getSelection?.()
    if (!selection || !document.createRange) return
    const range = document.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  // 1. Событие настоящей клавиатуры.
  try {
    selectAll()
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText', data: wanted, bubbles: true, cancelable: true,
    })
    const notCancelled = element.dispatchEvent(event)
    if (notCancelled === false || reads().includes(wanted.slice(0, 20))) {
      if (reads().includes(wanted.slice(0, 20))) return 'beforeinput'
    }
  } catch { /* редактор не слушает beforeinput — идём дальше */ }

  // 2. Старый, но живучий путь.
  try {
    selectAll()
    document.execCommand('insertText', false, wanted)
    if (reads().includes(wanted.slice(0, 20))) return 'execCommand'
  } catch { /* и этот не подошёл */ }

  // 3. Простое contenteditable без модели.
  try {
    element.focus?.()
    element.textContent = wanted
    element.dispatchEvent(new Event('input', { bubbles: true }))
    if (reads().includes(wanted.slice(0, 20))) return 'textContent'
  } catch { /* совсем не вышло */ }

  return null
}

/**
 * Одно действие. Возвращает { ok, method } либо { ok: false, error }.
 *
 * `confirmRisky` — согласие человека на необратимое действие. Без него нажатие на кнопку,
 * помеченную сканером как рискованная, не выполняется: план, пришедший от модели, не должен уметь
 * удалить товар или отправить карточку на модерацию только потому, что так сложились слова.
 */
function runAction(action, { elementById, confirmRisky = false } = {}) {
  const element = elementById(action?.id)
  if (!element) return { ok: false, id: action?.id, error: 'no_element' }
  if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
    return { ok: false, id: action.id, error: 'disabled' }
  }

  if (action.type === 'type') {
    if (action.value == null || action.value === '') return { ok: false, id: action.id, error: 'no_value' }
    const method = element.isContentEditable
      ? typeIntoRichText(element, action.value)
      : typeIntoInput(element, action.value)
    return method ? { ok: true, id: action.id, method } : { ok: false, id: action.id, error: 'editor_refused' }
  }

  if (action.type === 'click') {
    // Пометка ставится сканером по словам на кнопке. Она не запрещает — она требует согласия.
    if (element.getAttribute?.('data-nemo-risky') === 'true' && !confirmRisky) {
      return { ok: false, id: action.id, error: 'needs_confirmation' }
    }
    element.click()
    return { ok: true, id: action.id, method: 'click' }
  }

  if (action.type === 'select') {
    const wanted = String(action.value ?? '')
    const options = [...(element.options ?? [])]
    const match = options.find((one) => one.value === wanted)
      ?? options.find((one) => (one.text ?? '').trim() === wanted)
      ?? options.find((one) => (one.text ?? '').toLowerCase().includes(wanted.toLowerCase()))
    if (!match) return { ok: false, id: action.id, error: 'no_option' }
    element.value = match.value
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, id: action.id, method: 'select' }
  }

  return { ok: false, id: action?.id, error: 'unknown_action' }
}

/**
 * План целиком. Выполняется по порядку и НЕ прерывается на первой неудаче.
 *
 * Прерывание выглядело бы аккуратнее, но оставляло бы форму заполненной наполовину без объяснения,
 * какая половина уцелела. Здесь каждый шаг отчитывается сам, и человек видит список: что встало,
 * что нет и почему.
 */
function runPlan(actions, options) {
  const results = []
  for (const action of actions ?? []) {
    results.push(runAction(action, options))
  }
  return {
    done: results.filter((one) => one.ok).length,
    failed: results.filter((one) => !one.ok).length,
    results,
  }
}
