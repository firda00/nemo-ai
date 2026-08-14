// Service worker: связь с Nemo, запуск переноса, журнал.
//
// Здесь принимаются все решения о том, ЧТО делать. Content script только исполняет и отвечает —
// у него нет ни доступа к Nemo, ни права решить, что карточку пора отправлять.

import { callNemo, forgetSession, nextTask, readSession, reportResult, saveSession } from './nemo.js'
import { CATEGORY_HINT, CREATE_PAGE, STOP_SIGNS } from './selectors.js'

/**
 * Сессия приезжает из ОТКРЫТОЙ ВКЛАДКИ NEMO, а не из формы входа в расширении.
 *
 * Так расширение никогда не видит пароль: вы уже вошли на сайте, сайт передаёт сюда короткий
 * токен той же сессии. Отправитель проверяется по origin — externally_connectable в манифесте
 * ограничивает домен, но полагаться на одну лишь настройку манифеста для приёма учётных данных
 * нельзя.
 */
/**
 * Кто вправе говорить с расширением.
 *
 * Список точный, и это не перестраховка. Просили добавить `*.sslip.io` — нельзя: sslip.io это
 * служба подстановочного DNS, где `<любой-ip>.sslip.io` указывает на этот самый адрес. То есть
 * «все поддомены sslip.io» означает «любая страница, которую кто угодно поднял у себя». Проверка
 * origin ниже такую страницу отвергнет, но давать ей возможность вообще достучаться до
 * расширения, хранящего ключ доступа, незачем.
 *
 * http оставлен рядом с https: стенд отвечает на http редиректом, и лишняя строка стоит дешевле,
 * чем полчаса на выяснение, не в схеме ли дело.
 */
const ALLOWED_ORIGINS = [
  'https://nemo.185.8.213.144.sslip.io',
  'http://nemo.185.8.213.144.sslip.io',
]

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : '')
  if (!ALLOWED_ORIGINS.includes(origin)) {
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
export async function runOnce() {
  if (!await readSession()) return { ok: false, reason: 'not_linked' }

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
    stopSigns: STOP_SIGNS,
    categoryHint: CATEGORY_HINT,
  }).catch(() => null)

  if (!response) {
    await reportResult({
      draftId: task.task.id, status: 'failed', reason: 'form_changed',
      message: 'Страница кабинета не ответила. Обновите её и попробуйте снова.',
    })
    return { ok: false, reason: 'no_response' }
  }

  if (!response.ok) {
    // Журнал ведётся по-русски и подробно — его читают при разборе. Владельцу окно расширения
    // покажет то же самое, но короткой фразой на его языке: это разные читатели.
    const detail = response.detail
      ?? (response.tooLong?.length ? `не влезает в лимиты Uzum — ${response.tooLong.join('; ')}` : null)
      ?? (response.notFound?.length ? `поля не найдены: ${response.notFound.join(', ')}` : null)
      ?? (response.reason === 'category_first' ? 'категория ещё не подтверждена — поля формы заблокированы' : null)
    await reportResult({
      draftId: task.task.id,
      // Остановка ради человека — это отказ, а не поломка: карточка цела, решение за вами.
      status: response.reason === 'human_needed' || response.reason === 'category_first' ? 'refused' : 'failed',
      reason: response.reason,
      message: detail,
    })
    return { ok: false, reason: response.reason, tooLong: response.tooLong, notFound: response.notFound }
  }

  // Успехом это НЕ считается. Заполненный шаг 1 из трёх — половина дела: товар ещё не в каталоге
  // и на модерацию не ушёл. Записать 'sent' здесь значило бы объявить карточку отправленной и
  // потерять её из виду — она бы больше не попала в задания расширения.
  //
  // Пропущенные поля называются в журнале, а не теряются: карточка без описания и запись
  // «заполнено» рядом — это два дня поисков виноватого.
  const missed = response.skipped?.length ? ` Остались пустыми: ${response.skipped.join(', ')}.` : ''
  await reportResult({
    draftId: task.task.id,
    status: 'refused',
    reason: 'human_needed',
    message: 'Карточка заполнена расширением. Проверьте текст и продолжайте на Uzum сами.' + missed,
  })
  return {
    ok: true,
    categoryTyped: Boolean(response.categoryTyped),
    filled: response.filled, skipped: response.skipped ?? [],
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nemo:run') {
    runOnce().then(sendResponse)
    return true
  }
  if (message?.type === 'nemo:state') {
    ;(async () => {
      const session = await readSession()
      const settings = session ? await callNemo('status') : { ok: false }
      sendResponse({
        linked: Boolean(session),
        autoExtensionSubmit: settings.ok ? settings.data?.pilot?.auto_extension_submit === true : null,
      })
    })()
    return true
  }
  return undefined
})
