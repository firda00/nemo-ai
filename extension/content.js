// Мост между страницей и service worker. Тонкий намеренно.
//
// Здесь нет ни одного решения о том, ЧТО делать: сканер собирает снимок, исполнитель выполняет
// присланный план, а этот файл только принимает сообщения и отвечает. Всё, что умнее, живёт либо в
// service worker, либо в Nemo.
//
// Скрипт НИЧЕГО не делает при загрузке страницы. Он ждёт сообщения — то есть вашего нажатия.
// Расширение, которое начинает работать само, однажды заполнит форму, открытую посмотреть.
//
// scanPage, elementById и runPlan объявлены в scanner.js и executor.js: content_scripts одного
// расширения делят общую область видимости, и импорты здесь были бы синтаксической ошибкой —
// скрипт подключается обычным, а не модулем.

/** Капча и незнакомые окна. Единственная проверка страницы, оставшаяся в расширении. */
const STOP_SIGNS = [
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[data-testid*="captcha" i]',
]

function findStopSign() {
  for (const selector of STOP_SIGNS) {
    if (document.querySelector(selector)) return selector
  }
  return null
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Снимок страницы. Читающее действие, но и оно за капчей не идёт: если на экране капча, значит
  // страница не та, что мы думаем, и показывать её содержимое модели незачем.
  if (message?.type === 'nemo:scan') {
    const stop = findStopSign()
    if (stop) { sendResponse({ ok: false, reason: 'human_needed', detail: stop }); return true }
    const page = scanPage(message.limit ?? 120)
    // В консоль страницы — что именно собрано. Без этого «ничего не нашлось» невозможно отличить
    // от «нашлось, но не то»: снимок живёт внутри расширения и наружу не показывается.
    //
    // ЗНАЧЕНИЯ ПОЛЕЙ НЕ ПЕЧАТАЮТСЯ. В них лежит содержимое чужого кабинета, а консоль читают через
    // плечо, копируют в переписку и прикладывают к обращениям в поддержку.
    // Печатается СТРОКОЙ, а не объектом. Объект консоль сворачивает в «Object», и человек,
    // копирующий лог в переписку, присылает это слово вместо данных — что и случилось.
    const kinds = Object.entries(page.byKind).map(([kind, n]) => `${kind}=${n}`).join(' ') || 'пусто'
    const dropped = Object.entries(page.dropped).filter(([, n]) => n > 0).map(([why, n]) => `${why}=${n}`).join(' ') || 'нет'
    const fields = page.items.filter((item) => ['input', 'textarea', 'richtext', 'select'].includes(item.kind))
    console.log(
      `[Nemo] снимок: в DOM=${page.raw} прошло фильтр=${page.count} в снимке=${page.items.length}`
      + ` | отсеяно: ${dropped}`
      + `\n[Nemo] виды: ${kinds}`
      // Кадр важен: форма во фрейме и форма в главном документе выглядят в отчёте одинаково,
      // а чинятся по-разному — вторая требует all_frames в манифесте.
      + `\n[Nemo] адрес: ${page.url} | кадр: ${page.frame}`,
    )
    // Таблицей: её видно целиком без разворачивания и она копируется как текст.
    if (fields.length) console.table(fields.map((item) => ({ id: item.id, вид: item.kind, подпись: item.label, плейсхолдер: item.placeholder })))
    else console.warn('[Nemo] полей ввода на странице не найдено — возможно, форма ещё не отрисована')
    sendResponse({ ok: true, page })
    return true
  }

  if (message?.type === 'nemo:run-plan') {
    // Проверка ДО первого действия. Заполнить половину формы и только потом заметить капчу —
    // значит оставить в чужом кабинете полуготовую карточку.
    const stop = findStopSign()
    if (stop) { sendResponse({ ok: false, reason: 'human_needed', detail: stop }); return true }

    const report = runPlan(message.actions, {
      elementById,
      confirmRisky: Boolean(message.confirmRisky),
    })
    // Способ, которым сработал каждый шаг, — самое ценное в отчёте. Именно по нему видно, что
    // редактор описания принял текст через beforeinput, а не «execCommand вернул true и ничего».
    console.log('[Nemo] выполнено:', report.results)
    sendResponse({ ok: report.done > 0, ...report })
    return true
  }

  return undefined
})
