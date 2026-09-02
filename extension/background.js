// Service worker: мост между страницей и Nemo.
//
// Здесь принимаются все решения о том, ЧТО делать. Content script только снимает страницу и
// выполняет присланный план — у него нет ни доступа к Nemo, ни права решить, что пора нажимать.
//
// Пайплайн один на любую задачу: снять страницу → отдать её Nemo вместе с поручением → получить
// план действий → выполнить → отчитаться. Всё, что раньше знало про Uzum, ушло из расширения:
// смыслы полей и правила заполнения теперь на стороне Nemo, где их можно менять без переустановки.

import { callNemo, forgetSession, readSession, reportResult, saveSession, sessionState } from './nemo.js'

/**
 * Кто вправе говорить с расширением.
 *
 * Список точный, и это не перестраховка. Wildcard-DNS origin добавлять нельзя: иначе доверенной
 * станет любая страница, которую кто угодно поднял на произвольном IP.
 */
const ALLOWED_ORIGINS = [
  'https://nemo-ai-swart.vercel.app',
  'https://nemo-ai-firda00s-projects.vercel.app',
]

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const origin = sender?.origin ?? (sender?.url ? new URL(sender.url).origin : '')
  if (!ALLOWED_ORIGINS.includes(origin)) {
    sendResponse({ ok: false, error: 'forbidden_origin' })
    return false
  }
  if (message?.type === 'nemo:ping') {
    // Сайту сообщается ТО ЖЕ состояние, что видит попап. Иначе в кабинете горит «Связано», а в
    // расширении «нет связи», и человек не понимает, кому из двух верить.
    sessionState().then(({ session, expired }) => sendResponse({ ok: true, linked: Boolean(session), expired }))
    return true
  }
  if (message?.type === 'nemo:unlink') {
    forgetSession().then(() => sendResponse({ ok: true }))
    return true
  }
  if (message?.type === 'nemo:run-browser') {
    const instruction = String(message.instruction ?? '').trim().slice(0, 500)
    if (!instruction) {
      sendResponse({ ok: false, reason: 'empty_instruction' })
      return false
    }
    runInstruction({
      instruction,
      // Финальная отправка на модерацию — отдельное осознанное действие в UI. Обычный запрос
      // в чате разрешает навигацию и редактирование, но не необратимую публикацию.
      confirmRisky: Boolean(message.confirmRisky),
      confirmCategoryMismatch: false,
      attachments: [],
      mode: message.mode === 'commerce' || /(?:uzum|seller\.uzum)/i.test(instruction)
        ? 'commerce' : 'general_browser',
    }).then(sendResponse)
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

const SELLER_HOME = 'https://seller.uzum.uz/'
const BROWSER_HOME = 'https://www.google.com/'
const UNIVERSAL_ORIGINS = ['http://*/*', 'https://*/*']
const MAX_AUTONOMOUS_STEPS = 12
const isSellerUrl = (url) => {
  try { return new URL(url).origin === new URL(SELLER_HOME).origin } catch { return false }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const isWebUrl = (url) => {
  try { return ['http:', 'https:'].includes(new URL(url).protocol) } catch { return false }
}
const isNemoUrl = (url) => {
  try { return ALLOWED_ORIGINS.includes(new URL(url).origin) } catch { return false }
}

async function universalAccessGranted() {
  return await chrome.permissions.contains({ origins: UNIVERSAL_ORIGINS })
}

function requestedUrl(instruction) {
  const source = String(instruction ?? '')
  const match = source.match(/https?:\/\/[^\s<>{}\[\]"']+/i)
    ?? source.match(/(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})(?:\/[^\s<>{}\[\]"']*)?/i)
  if (!match) return null
  try {
    const raw = match[0].replace(/[.,;:!?]+$/, '')
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}

async function waitForTab(tabId, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) return null
    if (tab.status === 'complete') return tab
    await pause(250)
  }
  return await chrome.tabs.get(tabId).catch(() => null)
}

/** Открывает Seller сам, если поручение запущено из Nemo или другой вкладки. */
async function ensureSellerTab() {
  const current = await activeTab()
  if (current?.id && isSellerUrl(current.url)) return current
  const existing = await chrome.tabs.query({ currentWindow: true, url: 'https://seller.uzum.uz/*' })
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true })
    return await waitForTab(existing[0].id)
  }
  const created = await chrome.tabs.create({ url: SELLER_HOME, active: true })
  return created.id ? await waitForTab(created.id) : null
}

async function ensureTaskTab(instruction, mode, startUrl) {
  if (mode === 'commerce') return await ensureSellerTab()
  if (!await universalAccessGranted()) return { permissionRequired: true }
  // Как у браузерных агентов: каждое новое поручение получает отдельную рабочую вкладку и не
  // перетирает страницу, которую человек читал до запуска.
  const target = requestedUrl(instruction) ?? (isWebUrl(startUrl) && !isNemoUrl(startUrl) ? startUrl : BROWSER_HOME)
  const created = await chrome.tabs.create({ url: target, active: true })
  return created.id ? await waitForTab(created.id) : null
}

/** После клика продолжает в новой вкладке, если кабинет открыл её сам. */
async function nextSellerTab(previousId, knownIds) {
  await pause(700)
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const sellerTabs = tabs.filter((tab) => tab.id && isSellerUrl(tab.url))
  const fresh = sellerTabs.find((tab) => !knownIds.has(tab.id))
  const active = sellerTabs.find((tab) => tab.active)
  const same = sellerTabs.find((tab) => tab.id === previousId)
  const next = fresh ?? active ?? same ?? null
  return next?.id ? await waitForTab(next.id) : null
}

async function nextTaskTab(previousId, knownIds, mode) {
  if (mode === 'commerce') return await nextSellerTab(previousId, knownIds)
  await pause(700)
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const webTabs = tabs.filter((tab) => tab.id && isWebUrl(tab.url) && !isNemoUrl(tab.url))
  const fresh = webTabs.find((tab) => !knownIds.has(tab.id))
  const same = webTabs.find((tab) => tab.id === previousId)
  const active = webTabs.find((tab) => tab.active)
  const next = fresh ?? same ?? active ?? null
  return next?.id ? await waitForTab(next.id) : null
}

const toTab = (tabId, message, frameId = 0) => chrome.tabs.sendMessage(tabId, message, { frameId }).catch(() => null)

async function ensurePageBridge(tabId) {
  const existing = await toTab(tabId, { type: 'nemo:scan', limit: 1 })
  if (existing) return true
  if (!await universalAccessGranted()) return false
  try {
    // Файлы исполняются в одном isolated world и в том же порядке, что declarative content script.
    for (const file of ['scanner.js', 'executor.js', 'content.js']) {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [file] })
    }
    return true
  } catch { return false }
}

/**
 * Uzum может отрисовать рабочую форму во вложенном frame. Content script установлен во все
 * frame, но tabs.sendMessage без frameId всегда разговаривает только с главным документом.
 * Выбираем кадр с наибольшим числом полей формы; при равенстве главный кадр остаётся первым.
 */
async function scanWorkingFrame(tabId) {
  if (!await ensurePageBridge(tabId)) return { frameId: 0, scan: null }
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)
  const ids = [...new Set((frames?.length ? frames : [{ frameId: 0 }]).map((frame) => frame.frameId))]
  const scans = await Promise.all(ids.map(async (frameId) => ({
    frameId,
    scan: await toTab(tabId, { type: 'nemo:scan' }, frameId),
  })))
  const score = (entry) => {
    if (!entry.scan?.ok) return -1
    const items = entry.scan.page?.items ?? []
    const fields = items.filter((item) => ['input', 'textarea', 'richtext', 'select', 'file'].includes(item.kind)).length
    return fields * 1000 + items.length
  }
  return scans.sort((a, b) => score(b) - score(a) || a.frameId - b.frameId)[0] ?? { frameId: 0, scan: null }
}

/**
 * Одно поручение: снять страницу, спросить у Nemo план, выполнить его.
 *
 * Ни одного шага не пропускаем и ни одного не додумываем. Если Nemo не ответил планом — ничего не
 * происходит: расширение не придумывает действия само, потому что придуманное действие в чужом
 * кабинете стоит дороже несделанного.
 */
function mediaUploadAction(page, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return { action: null, error: null }
  const candidates = (page?.items ?? []).filter((item) => item.kind === 'file' && !item.disabled)
  // На первом экране поля фото обычно ещё нет: автономный loop сначала дойдёт до нужного шага.
  if (!candidates.length) return { action: null, error: null }
  const imageWords = /фото|изображ|картин|медиа|image|photo|picture|media|rasm|surat|accept.*image/i
  const ranked = candidates.map((item) => ({
    item,
    score: imageWords.test(`${item.label ?? ''} ${item.context ?? ''} ${item.name ?? ''} ${item.accept ?? ''}`) ? 2 : 0,
  })).sort((a, b) => b.score - a.score || a.item.id - b.item.id)
  const best = ranked[0]
  if (!best || (ranked.length > 1 && best.score === ranked[1].score && best.score === 0)) {
    return { action: null, error: 'no_file_field' }
  }
  return { action: { type: 'upload', id: best.item.id, files: attachments }, error: null }
}

async function runInstructionStep({ instruction, confirmRisky = false, confirmCategoryMismatch = false, attachments = [], tab, mode }) {
  if (!tab?.id || !isWebUrl(tab.url) || (mode === 'commerce' && !isSellerUrl(tab.url))) {
    return { ok: false, reason: 'left_allowed_site' }
  }
  const frame = await scanWorkingFrame(tab.id)
  const scan = frame.scan
  if (!scan) return { ok: false, reason: 'no_response' }
  if (!scan.ok) return { ok: false, reason: scan.reason ?? 'no_response' }

  const planned = await callNemo('agent_plan', {
    instruction, page: scan.page, confirmCategoryMismatch,
    mode: mode === 'commerce' ? 'commerce' : 'general_browser',
  })
  if (!planned.ok) return { ok: false, reason: planned.error }

  // Категория страницы не совпадает с категорией черновика — сервер остановился ДО модели и ДО
  // единого действия. Заполненные ПРАВИЛЬНЫМИ по формату значениями поля — не в ту карточку — это
  // не ошибка формы, а гарантированный отказ модерации, и владелец должен решить сам, продолжать
  // ли, а не узнать об этом постфактум.
  if (planned.data?.category_mismatch) {
    return {
      ok: false,
      reason: 'category_mismatch',
      pageCategory: planned.data.page_category ?? null,
      draftCategory: planned.data.draft_category ?? null,
    }
  }

  // Что вернула модель и что от этого осталось после проверки — в консоль service worker
  // (chrome://extensions → «Обслуживающий процесс»). Пустой план и план, целиком отвергнутый
  // проверкой, снаружи выглядят ОДИНАКОВО, а чинить их надо по-разному: первое — промпт, второе —
  // несоответствие снимка и ответа.
  // Строкой, а не объектом: свёрнутый «Object» в консоли невозможно ни прочитать, ни прислать.
  const rejected = planned.data?.rejected ?? []
  // Поля, которых план вообще не коснулся, — третья причина пустого поля, помимо «отброшено» и
  // «не сработало». Без неё «richtext остался пустым» одинаково похоже и на промпт, который не
  // предложил действие, и на проверку, которая его отвергла, и на исполнителя, который не смог
  // ввести текст, — а чинятся эти три беды по-разному.
  const unaddressed = planned.data?.unaddressed ?? []
  console.log(
    `[Nemo] план: поручение="${instruction}" элементов=${scan.page.items.length}`
    + ` действий=${planned.data?.actions?.length ?? 0} отброшено=${rejected.length}`
    + ` не предложено=${unaddressed.length}`
    + `
[Nemo] заметка модели: ${planned.data?.note ?? '—'}`,
  )
  if (rejected.length) {
    console.log('[Nemo] отброшено проверкой:', rejected.map((one) => one.reason).join(', '))
  }
  if (unaddressed.length) {
    console.log('[Nemo] план не тронул:', unaddressed.map((one) => `#${one.id} ${one.kind}`).join(', '))
  }

  const upload = mediaUploadAction(scan.page, attachments)
  if (upload.error) return { ok: false, reason: upload.error }
  const actions = [...(planned.data?.actions ?? []), ...(upload.action ? [upload.action] : [])]
  if (!actions.length) {
    const note = planned.data?.note ?? null
    const completed = mode === 'general_browser' && Boolean(note)
    return {
      ok: completed,
      completed,
      reason: completed ? null : 'no_plan',
      note,
      // Отброшенное доезжает до владельца, а не остаётся в консоли: «уточните поручение» человеку,
      // у которого план отвергла наша же проверка, — это совет чинить не то.
      rejected: planned.data?.rejected ?? [],
      unaddressed,
    }
  }

  const executed = await toTab(tab.id, { type: 'nemo:run-plan', actions, confirmRisky }, frame.frameId)
  if (!executed) return { ok: false, reason: 'no_response' }

  // Нужное подтверждение — это не провал плана, а вопрос к человеку. Отделено от прочих неудач,
  // потому что ответ на него другой: не «почини», а «разреши».
  const needsConfirmation = (executed.results ?? []).some((one) => one.error === 'needs_confirmation')
  const submitted = (executed.results ?? []).some((one) => one.ok && one.method === 'click' && one.effect === 'submit')

  return {
    ok: executed.done > 0,
    done: executed.done,
    failed: executed.failed,
    results: executed.results,
    needsConfirmation,
    submitted,
    uploaded: (executed.results ?? []).some((one) => one.ok && one.method === 'data-transfer'),
    draftId: planned.data?.draft_id ?? null,
    pageUrl: scan.page.url,
    pageFingerprint: JSON.stringify((scan.page.items ?? []).map((item) => [item.kind, item.label, item.text, item.value])).slice(0, 12_000),
    note: planned.data?.note ?? null,
    unaddressed,
  }
}

/**
 * Полный браузерный цикл: открыть кабинет → посмотреть экран → выполнить безопасный шаг →
 * дождаться следующего экрана/вкладки → повторить. Один клик «Выполнить» разрешает весь описанный
 * маршрут, но рискованные кнопки всё равно требуют явной галочки этого запуска.
 */
export async function runInstruction({ instruction, confirmRisky = false, confirmCategoryMismatch = false, attachments = [], mode = 'commerce', startUrl = null }) {
  if (!await readSession()) return { ok: false, reason: 'not_linked' }
  let tab = await ensureTaskTab(instruction, mode, startUrl)
  if (tab?.permissionRequired) return { ok: false, reason: 'host_permission_required' }
  if (!tab?.id) return { ok: false, reason: 'no_tab' }

  const knownIds = new Set((await chrome.tabs.query({ currentWindow: true })).map((one) => one.id).filter(Boolean))
  let totalDone = 0
  let totalFailed = 0
  let uploaded = false
  let draftId = null
  let previousFingerprint = null
  let repeated = 0
  let last = null
  let stepsRun = 0

  await chrome.storage.session.set({ nemoBrowserRun: { status: 'running', step: 0, instruction: instruction.slice(0, 160), updatedAt: Date.now() } })

  for (let step = 1; step <= MAX_AUTONOMOUS_STEPS; step++) {
    stepsRun = step
    await chrome.storage.session.set({ nemoBrowserRun: { status: 'running', step, instruction: instruction.slice(0, 160), updatedAt: Date.now() } })
    const result = await runInstructionStep({
      instruction, confirmRisky, confirmCategoryMismatch,
      attachments: uploaded ? [] : attachments,
      tab, mode,
    })
    last = result
    draftId = result.draftId ?? draftId
    totalDone += Number(result.done ?? 0)
    totalFailed += Number(result.failed ?? 0)
    uploaded ||= Boolean(result.uploaded)

    if (result.pageFingerprint && result.pageFingerprint === previousFingerprint) repeated += 1
    else repeated = 0
    previousFingerprint = result.pageFingerprint ?? previousFingerprint

    if (result.completed || result.submitted || result.needsConfirmation || result.reason === 'category_mismatch'
      || result.reason === 'human_needed' || result.reason === 'left_allowed_site') break
    if (!result.ok) break
    if (repeated >= 2) {
      last = { ...result, ok: false, reason: 'no_progress' }
      break
    }

    const next = await nextTaskTab(tab.id, knownIds, mode)
    if (!next) { last = { ...result, ok: false, reason: 'left_allowed_site' }; break }
    knownIds.add(next.id)
    tab = next
  }

  const submitted = Boolean(last?.submitted)
  const needsConfirmation = Boolean(last?.needsConfirmation)
  const mediaMissing = attachments.length > 0 && !uploaded
  const reachedLimit = stepsRun >= MAX_AUTONOMOUS_STEPS && last?.ok && !last?.submitted
  const terminalReason = mediaMissing ? 'media_not_uploaded' : reachedLimit ? 'step_limit' : last?.reason
  const ok = Boolean(last?.completed) || submitted || (totalDone > 0 && !needsConfirmation && !mediaMissing
    && terminalReason !== 'no_progress' && terminalReason !== 'step_limit')
  const final = {
    ...(last ?? {}), ok, done: totalDone, failed: totalFailed,
    submitted, needsConfirmation, uploaded, reason: terminalReason,
  }

  // Одна запись на весь маршрут, а не по записи на каждый экран.
  if (draftId) {
    await reportResult({
      draftId,
      status: submitted ? 'sent' : ok ? 'refused' : 'failed',
      reason: submitted ? 'browser_submit_clicked' : ok ? 'browser_task_completed' : String(terminalReason ?? 'form_changed').slice(0, 60),
      message: submitted
        ? 'Кнопка отправки нажата с подтверждением владельца. Ожидается подтверждение синхронизацией Uzum.'
        : ok ? `Автономный маршрут завершён. Выполнено действий: ${totalDone}.`
        : `Автономный маршрут остановлен: ${String(terminalReason ?? 'unknown')}.`,
    })
  }
  await chrome.storage.session.set({ nemoBrowserRun: {
    status: ok ? 'completed' : needsConfirmation ? 'confirmation' : 'stopped',
    done: totalDone,
    reason: terminalReason ?? null,
    updatedAt: Date.now(),
  } })
  return final
}

/**
 * Диагностика одним прогоном.
 *
 * Собрана потому, что пять подходов подряд уходили на выяснение ОДНОГО факта за раз: сначала
 * связь, потом кадр, потом число полей, потом ответ модели. Каждый круг стоил перезагрузки
 * расширения, вашего времени и ещё одного сообщения. Здесь всё собирается разом и отдаётся готовым
 * текстом — его можно скопировать целиком, не разбираясь, что из этого важно.
 *
 * СЕКРЕТОВ ЗДЕСЬ НЕТ: ни токена, ни значений полей. Только числа, подписи, адреса и причины
 * отсева. Отчёт, который страшно переслать, диагностикой не работает.
 */
export async function collectDiagnostics() {
  const { session, expired } = await sessionState()
  const tab = await activeTab()
  const lines = [
    `расширение: ${chrome.runtime.id}`,
    `связь: ${session ? 'есть' : expired ? 'истекла' : 'нет'}`,
    `вкладка: ${tab?.url ?? '—'}`,
  ]
  if (!tab?.id) return { text: lines.join('\n') }

  const frame = await scanWorkingFrame(tab.id)
  const scan = frame.scan
  if (!scan) {
    lines.push('снимок: страница не ответила — обновите её (Ctrl+F5) и повторите')
  } else if (!scan.ok) {
    lines.push(`снимок: отказ — ${scan.reason}`)
  } else {
    const page = scan.page
    const kinds = Object.entries(page.byKind).map(([kind, n]) => `${kind}=${n}`).join(' ') || 'пусто'
    const dropped = Object.entries(page.dropped).filter(([, n]) => n > 0)
      .map(([why, n]) => `${why}=${n}`).join(' ') || 'нет'
    lines.push(
      `кадр: ${page.frame}`,
      `в DOM: ${page.raw} | прошло фильтр: ${page.count} | в снимке: ${page.items.length}`,
      // Эти два числа вместе называют причину пустого снимка, а не просто повторяют её:
      // узлов много, а найдено мало + есть shadow-корни — форма спрятана в веб-компонентах;
      // узлов мало вообще — страница ещё не дорисовалась, дело не в shadow DOM.
      `всего узлов в DOM: ${page.domTotal ?? '—'} | shadow-корней: ${page.shadowHosts ?? '—'}`,
      `отсеяно: ${dropped}`,
      `виды: ${kinds}`,
    )
    const fields = page.items.filter((one) => ['input', 'textarea', 'richtext', 'select'].includes(one.kind))
    lines.push(`поля (${fields.length}):`)
    for (const one of fields.slice(0, 15)) {
      // context — то немногое, по чему модель вообще узнаёт поле без подписи и плейсхолдера
      // (richtext-редакторы почти всегда без них). Раньше в отчёте его не было — и «модель не
      // заполнила richtext» нельзя было отличить от «сканер не нашёл для него никакого текста».
      lines.push(
        `  #${one.id} ${one.kind} | подпись: ${one.label || '—'} | плейсхолдер: ${one.placeholder || '—'}`
        + ` | контекст: ${(one.context || '—').slice(0, 80)}`,
      )
    }
  }

  // Пробный план запрашивается ТОЛЬКО при живой связи и НИЧЕГО НЕ ВЫПОЛНЯЕТ: это чтение.
  // Диагностика, которая заодно что-то нажимает, — уже не диагностика.
  if (session && scan?.ok) {
    const planned = await callNemo('agent_plan', { instruction: 'заполни карточку товара', page: scan.page })
    if (!planned.ok) {
      lines.push(`план: отказ — ${planned.error}`)
    } else if (planned.data?.category_mismatch) {
      lines.push(
        'план: категория страницы не совпадает с черновиком — заполнение остановлено до модели',
        `  на странице: ${planned.data.page_category ?? '—'}`,
        `  в черновике: ${planned.data.draft_category ?? '—'}`,
      )
    } else {
      const rejected = planned.data?.rejected ?? []
      const unaddressed = planned.data?.unaddressed ?? []
      lines.push(
        `план: действий ${planned.data?.actions?.length ?? 0}, отброшено ${rejected.length}, не предложено ${unaddressed.length}`,
        `заметка модели: ${planned.data?.note ?? '—'}`,
      )
      for (const one of rejected) lines.push(`  отброшено: ${one.reason}`)
      // «Не предложено» — модель даже не пыталась: не увидела поле или не нашла для него данных.
      // Отличается и от «отброшено» (модель предложила, проверка отказала), и от «не сработало»
      // (проверка приняла, но executor не смог ввести значение) — три разные причины, три разных
      // починки.
      for (const one of unaddressed) lines.push(`  не предложено: #${one.id} ${one.kind} | подпись: ${one.label || '—'}`)
    }
  }
  return { text: lines.join('\n') }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'nemo:diagnose') {
    collectDiagnostics().then(sendResponse)
    return true
  }
  if (message?.type === 'nemo:instruct') {
    runInstruction({
      instruction: String(message.instruction ?? '').slice(0, 500),
      confirmRisky: Boolean(message.confirmRisky),
      confirmCategoryMismatch: Boolean(message.confirmCategoryMismatch),
      attachments: Array.isArray(message.attachments) ? message.attachments : [],
      mode: message.mode === 'general_browser' ? 'general_browser' : 'commerce',
      startUrl: message.startUrl,
    }).then(sendResponse)
    return true
  }
  if (message?.type === 'nemo:state') {
    Promise.all([sessionState(), chrome.storage.session.get('nemoBrowserRun')])
      .then(([{ session, expired }, stored]) => sendResponse({
        linked: Boolean(session), expired, browserRun: stored?.nemoBrowserRun ?? null,
      }))
    return true
  }
  return undefined
})
