// Service worker: мост между страницей и Nemo.
//
// Здесь принимаются все решения о том, ЧТО делать. Content script только снимает страницу и
// выполняет присланный план — у него нет ни доступа к Nemo, ни права решить, что пора нажимать.
//
// Пайплайн один на любую задачу: снять страницу → отдать её Nemo вместе с поручением → получить
// план действий → выполнить → отчитаться. Всё, что раньше знало про Uzum, ушло из расширения:
// смыслы полей и правила заполнения теперь на стороне Nemo, где их можно менять без переустановки.

import { callNemo, forgetSession, readSession, reportResult, saveSession } from './nemo.js'

/**
 * Кто вправе говорить с расширением.
 *
 * Список точный, и это не перестраховка. `*.sslip.io` добавить нельзя: sslip.io это служба
 * подстановочного DNS, где `<любой-ip>.sslip.io` указывает на этот самый адрес. «Все поддомены
 * sslip.io» означало бы «любая страница, которую кто угодно поднял у себя».
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

/**
 * Вкладка, на которой работаем, — ТЕКУЩАЯ АКТИВНАЯ.
 *
 * Раньше искалась вкладка по адресу страницы создания товара Uzum. Универсальному агенту такое
 * правило не подходит: он работает там, куда смотрит человек. Границу задаёт манифест — расширение
 * физически не видит вкладок вне разрешённых доменов.
 */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

const toTab = (tabId, message) => chrome.tabs.sendMessage(tabId, message).catch(() => null)

/**
 * Одно поручение: снять страницу, спросить у Nemo план, выполнить его.
 *
 * Ни одного шага не пропускаем и ни одного не додумываем. Если Nemo не ответил планом — ничего не
 * происходит: расширение не придумывает действия само, потому что придуманное действие в чужом
 * кабинете стоит дороже несделанного.
 */
export async function runInstruction({ instruction, confirmRisky = false }) {
  if (!await readSession()) return { ok: false, reason: 'not_linked' }

  const tab = await activeTab()
  if (!tab?.id) return { ok: false, reason: 'no_tab' }

  const scan = await toTab(tab.id, { type: 'nemo:scan' })
  if (!scan) return { ok: false, reason: 'no_response' }
  if (!scan.ok) return { ok: false, reason: scan.reason ?? 'no_response' }

  const planned = await callNemo('agent_plan', { instruction, page: scan.page })
  if (!planned.ok) return { ok: false, reason: planned.error }
  const actions = planned.data?.actions ?? []
  if (!actions.length) {
    return { ok: false, reason: 'no_plan', note: planned.data?.note ?? null }
  }

  const executed = await toTab(tab.id, { type: 'nemo:run-plan', actions, confirmRisky })
  if (!executed) return { ok: false, reason: 'no_response' }

  // Нужное подтверждение — это не провал плана, а вопрос к человеку. Отделено от прочих неудач,
  // потому что ответ на него другой: не «почини», а «разреши».
  const needsConfirmation = (executed.results ?? []).some((one) => one.error === 'needs_confirmation')

  // Каждая попытка попадает в журнал Nemo — включая те, где ничего не вышло. Попытка, о которой
  // ничего не осталось, через неделю превращается в «оно почему-то не работает».
  if (planned.data?.draft_id) {
    await reportResult({
      draftId: planned.data.draft_id,
      status: executed.done > 0 ? 'refused' : 'failed',
      reason: executed.done > 0 ? 'human_needed' : 'form_changed',
      message: executed.done > 0
        ? `Заполнено полей: ${executed.done}. Проверьте текст и продолжайте сами.`
        : 'Ни одно поле не заполнено — план не подошёл этой странице.',
    })
  }

  return {
    ok: executed.done > 0,
    done: executed.done,
    failed: executed.failed,
    results: executed.results,
    needsConfirmation,
    note: planned.data?.note ?? null,
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nemo:instruct') {
    runInstruction({
      instruction: String(message.instruction ?? '').slice(0, 500),
      confirmRisky: Boolean(message.confirmRisky),
    }).then(sendResponse)
    return true
  }
  if (message?.type === 'nemo:state') {
    readSession().then((session) => sendResponse({ linked: Boolean(session) }))
    return true
  }
  return undefined
})
