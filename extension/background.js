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
    // Сайту сообщается ТО ЖЕ состояние, что видит попап. Иначе в кабинете горит «Связано», а в
    // расширении «нет связи», и человек не понимает, кому из двух верить.
    sessionState().then(({ session, expired }) => sendResponse({ ok: true, linked: Boolean(session), expired }))
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
export async function runInstruction({ instruction, confirmRisky = false, confirmCategoryMismatch = false }) {
  if (!await readSession()) return { ok: false, reason: 'not_linked' }

  const tab = await activeTab()
  if (!tab?.id) return { ok: false, reason: 'no_tab' }

  const scan = await toTab(tab.id, { type: 'nemo:scan' })
  if (!scan) return { ok: false, reason: 'no_response' }
  if (!scan.ok) return { ok: false, reason: scan.reason ?? 'no_response' }

  const planned = await callNemo('agent_plan', { instruction, page: scan.page, confirmCategoryMismatch })
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

  const actions = planned.data?.actions ?? []
  if (!actions.length) {
    return {
      ok: false,
      reason: 'no_plan',
      note: planned.data?.note ?? null,
      // Отброшенное доезжает до владельца, а не остаётся в консоли: «уточните поручение» человеку,
      // у которого план отвергла наша же проверка, — это совет чинить не то.
      rejected: planned.data?.rejected ?? [],
      unaddressed,
    }
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
    unaddressed,
  }
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

  const scan = await toTab(tab.id, { type: 'nemo:scan' })
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
    }).then(sendResponse)
    return true
  }
  if (message?.type === 'nemo:state') {
    sessionState().then(({ session, expired }) => sendResponse({ linked: Boolean(session), expired }))
    return true
  }
  return undefined
})
