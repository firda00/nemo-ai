// Service worker: связь с Nemo, запуск переноса, журнал.
//
// Здесь принимаются все решения о том, ЧТО делать. Content script только исполняет и отвечает —
// у него нет ни доступа к Nemo, ни права решить, что карточку пора отправлять.

import { callNemo, forgetSession, nextTask, readSession, reportResult, saveSession } from './nemo.js'
import { CATEGORY, CREATE_PAGE, FIELDS, STEP_BUTTON, STOP_SIGNS, missingSelectors, selectorsReady } from './selectors.js'

/**
 * Сессия приезжает из ОТКРЫТОЙ ВКЛАДКИ NEMO, а не из формы входа в расширении.
 *
 * Так расширение никогда не видит пароль: вы уже вошли на сайте, сайт передаёт сюда короткий
 * токен той же сессии. Отправитель проверяется по origin — externally_connectable в манифесте
 * ограничивает домен, но полагаться на одну лишь настройку манифеста для приёма учётных данных
 * нельзя.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : '')
  if (origin !== 'https://nemo.185.8.213.144.sslip.io') {
    sendResponse({ ok: false, error: 'forbidden_origin' })
    return false
  }
  // Сайт спрашивает, стоит ли расширение и жива ли связь. Отвечаем ДО проверки типа остальных
  // сообщений: без этого сайт не отличает «не установлено» от «установлено и отказало», и
  // показывает «установите расширение» тому, у кого оно стоит.
  if (message?.type === 'nemo:ping') {
    readSession().then((session) => sendResponse({ ok: true, linked: Boolean(session) }))
    return true
  }
  if (message?.type === 'nemo:unlink') {
    forgetSession().then(() => sendResponse({ ok: true }))
    return true
  }
  if (message?.type !== 'nemo:link') {
    sendResponse({ ok: false, error: 'unknown_message' })
    return false
  }
  saveSession(message.session).then((saved) => sendResponse({ ok: saved }))
  return true
})

/** Вкладка кабинета Uzum на странице создания товара. Ни одной другой. */
async function findCreateTab() {
  const tabs = await chrome.tabs.query({ url: 'https://seller.uzum.uz/*' })
  return tabs.find((tab) => typeof tab.url === 'string' && CREATE_PAGE.test(tab.url)) ?? null
}

/**
 * Один перенос: взять задание, заполнить, отправить, записать исход.
 *
 * Каждая ветка заканчивается записью в журнал — включая те, где до Uzum дело не дошло. Попытка,
 * о которой ничего не осталось, через неделю превращается в «оно почему-то не работает».
 */
export async function runOnce({ submit }) {
  if (!await readSession()) return { ok: false, reason: 'not_linked' }

  // Разметка формы пуста — заполнять нечего и угадывать нельзя.
  if (!selectorsReady()) {
    return { ok: false, reason: 'selectors_missing', detail: `не размечены поля: ${missingSelectors().join(', ')}` }
  }

  const task = await nextTask()
  if (!task.ok) return { ok: false, reason: task.error }
  if (!task.task) return { ok: true, idle: true }

  const tab = await findCreateTab()
  if (!tab) {
    await reportResult({
      draftId: task.task.id, status: 'refused', reason: 'human_needed',
      message: 'Откройте в кабинете Uzum страницу создания товара — расширение работает на ней.',
    })
    return { ok: false, reason: 'no_create_tab' }
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: 'nemo:fill',
    draft: task.task,
    fields: FIELDS,
    category: CATEGORY,
    stepButton: STEP_BUTTON,
    stopSigns: STOP_SIGNS,
    // На шаге 1 нет кнопки «Отправить на модерацию» — там «Сохранить и продолжить», и за ней ещё
    // два шага, которых мы не видели. Поэтому здесь ПЕРЕХОД к следующему шагу, а не отправка.
    advance: submit,
  }).catch(() => null)

  if (!response) {
    await reportResult({
      draftId: task.task.id, status: 'failed', reason: 'form_changed',
      message: 'Страница кабинета не ответила. Обновите её и попробуйте снова.',
    })
    return { ok: false, reason: 'no_response' }
  }

  if (!response.ok) {
    await reportResult({
      draftId: task.task.id,
      // Остановка ради человека — это отказ, а не поломка: карточка цела, решение за вами.
      status: response.reason === 'human_needed' ? 'refused' : 'failed',
      reason: response.reason,
      message: response.detail,
    })
    return { ok: false, reason: response.reason, detail: response.detail }
  }

  // Успехом это НЕ считается. Шаг 1 из трёх — половина дела: товар ещё не в каталоге и на
  // модерацию не ушёл. Записать 'sent' здесь значило бы объявить карточку отправленной и
  // потерять её из виду — она бы больше не попала в задания расширения.
  // Пропущенные поля называются в журнале, а не теряются. Карточка без описания и запись
  // «заполнено» рядом — это два дня поисков виноватого.
  const missed = response.skipped?.length ? ` Не найдены и остались пустыми: ${response.skipped.join(', ')}.` : ''
  await reportResult({
    draftId: task.task.id,
    status: 'refused',
    reason: 'human_needed',
    message: (response.advanced
      ? 'Шаг 1 заполнен, перешли ко второму. Шаги 2 и 3 Nemo ещё не знает — доведите карточку сами.'
      : response.categoryTyped
        ? 'Поля заполнены, категория введена. Выберите полку из списка, нажмите «Принять» и продолжите сами.'
        : 'Поля заполнены. Выберите категорию и продолжите сами.') + missed,
  })
  return {
    ok: true, advanced: Boolean(response.advanced),
    categoryTyped: Boolean(response.categoryTyped),
    filled: response.filled, skipped: response.skipped ?? [],
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nemo:run') {
    runOnce({ submit: Boolean(message.submit) }).then(sendResponse)
    return true
  }
  if (message?.type === 'nemo:state') {
    ;(async () => {
      const session = await readSession()
      const settings = session ? await callNemo('status') : { ok: false }
      sendResponse({
        linked: Boolean(session),
        autoExtensionSubmit: settings.ok ? settings.data?.pilot?.auto_extension_submit === true : null,
        selectorsReady: selectorsReady(),
        missingSelectors: missingSelectors(),
      })
    })()
    return true
  }
  return undefined
})
