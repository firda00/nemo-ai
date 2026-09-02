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
const MAX_UPLOAD_FILES = 8
const MAX_UPLOAD_FILE_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_TOTAL_BYTES = 32 * 1024 * 1024

/**
 * Передаёт выбранные владельцем изображения настоящему file-input.
 *
 * Путь к локальному файлу браузер раскрывать расширению не имеет права. Поэтому popup читает
 * только выбранные человеком байты, а здесь из них собирается FileList через DataTransfer — тот
 * же объект, который форма получила бы после ручного выбора файлов. После установки обязательно
 * читаем files обратно: красивое событие change без реально прикреплённых файлов успехом не
 * считается.
 */
async function uploadFiles(element, files) {
  if ((element.tagName ?? '').toLowerCase() !== 'input' || String(element.type ?? '').toLowerCase() !== 'file') {
    return { ok: false, error: 'not_a_file_field' }
  }
  if (!Array.isArray(files) || !files.length || files.length > MAX_UPLOAD_FILES) {
    return { ok: false, error: 'invalid_files' }
  }

  let total = 0
  const prepared = []
  for (const source of files) {
    const name = String(source?.name ?? '').replace(/[\\/\0]/g, '_').slice(0, 180)
    const type = String(source?.type ?? '').toLowerCase()
    const size = Number(source?.size ?? 0)
    const dataUrl = String(source?.dataUrl ?? '')
    if (!name || !/^image\/(jpeg|png|webp)$/.test(type)) return { ok: false, error: 'unsupported_file' }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_FILE_BYTES) return { ok: false, error: 'file_too_large' }
    total += size
    if (total > MAX_UPLOAD_TOTAL_BYTES) return { ok: false, error: 'files_too_large' }
    if (!dataUrl.startsWith(`data:${type};base64,`)) return { ok: false, error: 'invalid_file_data' }
    const blob = await fetch(dataUrl).then((response) => response.blob()).catch(() => null)
    if (!blob || blob.size !== size) return { ok: false, error: 'invalid_file_data' }
    prepared.push(new File([blob], name, { type, lastModified: Date.now() }))
  }

  const transfer = new DataTransfer()
  const accepted = element.multiple ? prepared : prepared.slice(0, 1)
  for (const file of accepted) transfer.items.add(file)
  element.files = transfer.files
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  const attached = Number(element.files?.length ?? 0)
  return attached === accepted.length
    ? { ok: true, method: 'data-transfer', uploaded: attached }
    : { ok: false, error: 'upload_not_accepted', uploaded: attached }
}

async function runAction(action, { elementById, confirmRisky = false } = {}) {
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
    const isRisky = element.getAttribute?.('data-nemo-risky') === 'true'
    const riskText = `${element.innerText ?? element.textContent ?? ''} ${element.getAttribute?.('aria-label') ?? ''}`.toLowerCase()
    const effect = /отправ|submit|publish|опубликов|модерац|yubor/.test(riskText)
      ? 'submit'
      : /удал|delete|o‘chir|ochir/.test(riskText) ? 'delete' : 'other'
    element.click()
    return { ok: true, id: action.id, method: 'click', risky: isRisky, effect }
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

  if (action.type === 'upload') {
    const result = await uploadFiles(element, action.files)
    return { id: action.id, ...result }
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
async function runPlan(actions, options) {
  const results = []
  for (const action of actions ?? []) {
    results.push(await runAction(action, options))
  }
  return {
    done: results.filter((one) => one.ok).length,
    failed: results.filter((one) => !one.ok).length,
    results,
  }
}
