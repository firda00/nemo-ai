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

/**
 * Ждёт, пока страница перестанет меняться, — или истечёт срок.
 *
 * SPA дорисовывает форму не сразу: категория, черновик, профиль — всё это подгружается уже ПОСЛЕ
 * первой отрисовки. Скан, снятый в этот промежуток, видит пустую обёртку. Ждать после КАЖДОГО скана
 * нельзя — быстрая страница получила бы секундную паузу без всякой причины, поэтому вызывающий код
 * решает, стоит ли вообще ждать, по тому, насколько пуст первый снимок.
 */
function settled(quietMs = 300, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let quiet = null
    const finish = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(hard); resolve() }
    const observer = new MutationObserver(() => {
      clearTimeout(quiet)
      quiet = setTimeout(finish, quietMs)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    quiet = setTimeout(finish, quietMs)
    const hard = setTimeout(finish, timeoutMs)
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Снимок страницы. Читающее действие, но и оно за капчей не идёт: если на экране капча, значит
  // страница не та, что мы думаем, и показывать её содержимое модели незачем.
  if (message?.type === 'nemo:scan') {
    const stop = findStopSign()
    if (stop) { sendResponse({ ok: false, reason: 'human_needed', detail: stop }); return true }
    // Асинхронно: возможен один повторный скан после ожидания, а onMessage должен ответить
    // не раньше, чем он завершится.
    ;(async () => {
      let page = scanPage(message.limit ?? 120)
      let waited = false
      // Пусто и в фильтре, и в самом DOM — вероятно, скан снят раньше, чем SPA дорисовала
      // страницу. Ждём ОДИН раз: если и после паузы пусто, значит дело не во времени.
      if (looksUnrendered(page)) {
        waited = true
        await settled()
        page = scanPage(message.limit ?? 120)
      }
      // В консоль страницы — что именно собрано. Без этого «ничего не нашлось» невозможно отличить
      // от «нашлось, но не то»: снимок живёт внутри расширения и наружу не показывается.
      //
      // ЗНАЧЕНИЯ ПОЛЕЙ НЕ ПЕЧАТАЮТСЯ. В них лежит содержимое чужого кабинета, а консоль читают
      // через плечо, копируют в переписку и прикладывают к обращениям в поддержку.
      // Печатается СТРОКОЙ, а не объектом. Объект консоль сворачивает в «Object», и человек,
      // копирующий лог в переписку, присылает это слово вместо данных — что и случилось.
      const kinds = Object.entries(page.byKind).map(([kind, n]) => `${kind}=${n}`).join(' ') || 'пусто'
      const dropped = Object.entries(page.dropped).filter(([, n]) => n > 0).map(([why, n]) => `${why}=${n}`).join(' ') || 'нет'
      const fields = page.items.filter((item) => ['input', 'textarea', 'richtext', 'select'].includes(item.kind))
      console.log(
        `[Nemo] снимок: в DOM=${page.raw} прошло фильтр=${page.count} в снимке=${page.items.length}`
        + ` | отсеяно: ${dropped}`
        + `\n[Nemo] виды: ${kinds}`
        // domTotal и shadowHosts вместе называют причину пустоты: DOM полон, но за shadow
        // root — веб-компоненты; DOM тоже почти пуст — страница ещё не отрисовалась.
        + `\n[Nemo] всего узлов=${page.domTotal} shadow-корней=${page.shadowHosts}`
        + (waited ? ' (пересканировано после ожидания отрисовки)' : '')
        // Кадр важен: форма во фрейме и форма в главном документе выглядят в отчёте одинаково,
        // а чинятся по-разному — вторая требует all_frames в манифесте.
        + `\n[Nemo] адрес: ${page.url} | кадр: ${page.frame}`,
      )
      // Таблицей: её видно целиком без разворачивания и она копируется как текст.
      if (fields.length) console.table(fields.map((item) => ({ id: item.id, вид: item.kind, подпись: item.label, плейсхолдер: item.placeholder })))
      else console.warn('[Nemo] полей ввода на странице не найдено — возможно, форма ещё не отрисована')
      sendResponse({ ok: true, page })
    })()
    return true
  }

  if (message?.type === 'nemo:run-plan') {
    // Проверка ДО первого действия. Заполнить половину формы и только потом заметить капчу —
    // значит оставить в чужом кабинете полуготовую карточку.
    const stop = findStopSign()
    if (stop) { sendResponse({ ok: false, reason: 'human_needed', detail: stop }); return true }

    ;(async () => {
      const report = await runPlan(message.actions, {
        elementById,
        confirmRisky: Boolean(message.confirmRisky),
      })
      // Способ, которым сработал каждый шаг, — самое ценное в отчёте. Именно по нему видно, что
      // редактор описания принял текст через beforeinput, а не «execCommand вернул true и ничего».
      console.log('[Nemo] выполнено:', report.results)
      sendResponse({ ok: report.done > 0, ...report })
    })()
    return true
  }

  return undefined
})
