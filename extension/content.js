// Заполнение формы в кабинете Uzum.
//
// Скрипт НИЧЕГО не делает при загрузке страницы. Он ждёт сообщения от service worker — то есть
// вашего нажатия или включённого вами тумблера. Расширение, которое начинает работать само,
// стоит открыть кабинет, однажды заполнит форму, которую вы открыли посмотреть.

/**
 * Ввод, который замечает React.
 *
 * Присваивание `input.value` меняет DOM, но не состояние компонента: поле выглядит заполненным,
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

function findStopSign(stopSigns) {
  for (const selector of stopSigns) {
    const found = document.querySelector(selector)
    if (found) return selector
  }
  return null
}

/**
 * Заполнение полей.
 *
 * Возвращает отчёт, а не бросает исключение: половина заполненной формы — это состояние, о
 * котором надо рассказать, а не потерять в стеке. Ненайденное поле называется по имени.
 */
function fillFields(selectors, draft) {
  const filled = []
  const notFound = []
  const pairs = [
    ['titleRu', draft.title_ru],
    ['titleUz', draft.title_uz],
    ['descriptionRu', draft.description_ru],
    ['descriptionUz', draft.description_uz],
    ['price', draft.price],
  ]
  for (const [field, value] of pairs) {
    if (!value) continue
    const selector = selectors[field]
    if (!selector) { notFound.push(field); continue }
    const element = document.querySelector(selector)
    if (!element) { notFound.push(field); continue }
    setNativeValue(element, String(value))
    filled.push(field)
  }
  return { filled, notFound }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'nemo:fill') return undefined

  const { draft, selectors, stopSigns, submit } = message
  ;(async () => {
    // Проверка на «здесь нельзя» идёт ПЕРВОЙ, до единого символа в полях. Заполнить форму и
    // только потом заметить капчу — значит оставить в кабинете полуготовую карточку.
    const stop = findStopSign(stopSigns ?? [])
    if (stop) {
      sendResponse({ ok: false, reason: 'human_needed', detail: `остановился на экране: ${stop}` })
      return
    }

    const report = fillFields(selectors ?? {}, draft ?? {})
    if (report.notFound.length) {
      sendResponse({
        ok: false, reason: 'form_changed',
        detail: `поля не найдены: ${report.notFound.join(', ')}`,
        filled: report.filled,
      })
      return
    }

    if (!submit) {
      sendResponse({ ok: true, filled: report.filled, submitted: false })
      return
    }

    const button = selectors?.submitButton ? document.querySelector(selectors.submitButton) : null
    if (!button) {
      sendResponse({ ok: false, reason: 'form_changed', detail: 'кнопка отправки не найдена', filled: report.filled })
      return
    }
    // Экран мог смениться, пока заполнялись поля. Проверка повторяется вплотную к нажатию:
    // именно между заполнением и кликом появляется подтверждение, которого никто не ждал.
    const lateStop = findStopSign(stopSigns ?? [])
    if (lateStop) {
      sendResponse({ ok: false, reason: 'human_needed', detail: `экран сменился перед отправкой: ${lateStop}`, filled: report.filled })
      return
    }
    button.click()
    sendResponse({ ok: true, filled: report.filled, submitted: true })
  })()

  // Ответ уходит асинхронно — без этого канал закрывается раньше, чем в него что-то написали.
  return true
})
