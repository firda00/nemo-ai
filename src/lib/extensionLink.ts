// Связь сайта с расширением-загрузчиком.
//
// Расширение не умеет входить в Nemo само, и это сделано нарочно: форма входа внутри расширения
// означала бы пароль владельца в чужом окне. Вместо этого вход остаётся на сайте, а сюда уезжает
// только короткий токен уже открытой сессии — тот же, которым страница ходит в наш бэкенд.
//
// Разговор возможен лишь потому, что расширение объявило наш домен в externally_connectable.
// На страницах, которых нет в этом списке, window.chrome.runtime попросту отсутствует, и отправить
// туда нечего.

/**
 * Идентификатор расширения. ПОСТОЯННЫЙ.
 *
 * Без поля `key` в манифесте Chrome выводит его из ПУТИ К ПАПКЕ: перенесли папку — получили другой
 * идентификатор, и связь молча перестала находиться. Мы это уже прошли дважды, поэтому в манифест
 * положен открытый ключ, и теперь идентификатор выводится из него — папку можно двигать куда
 * угодно.
 *
 * Значение всё равно живёт в переменной сборки: при публикации в Chrome Web Store магазин выдаёт
 * своё, и менять придётся одну строку окружения, а не код.
 */
export const EXTENSION_ID =
  (import.meta.env.VITE_NEMO_EXTENSION_ID as string | undefined) ?? 'efgffoegaefoommemkgmnafeaakbjloi'

type ExtensionReply = {
  ok?: boolean
  error?: string
  reason?: string
  linked?: boolean
  expired?: boolean
  done?: number
  failed?: number
  submitted?: boolean
  needsConfirmation?: boolean
  uploaded?: boolean
  note?: string
  pageUrl?: string
}

type ChromeRuntime = {
  sendMessage?: (
    extensionId: string,
    message: unknown,
    callback: (response?: ExtensionReply) => void,
  ) => void
  lastError?: { message?: string }
}

function runtime(): ChromeRuntime | null {
  const chrome = (window as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome
  return typeof chrome?.runtime?.sendMessage === 'function' ? chrome.runtime : null
}

/**
 * Почему расширение не ответило. Это не украшение отчёта.
 *
 * Три причины требуют трёх РАЗНЫХ действий: перезагрузить вкладку, поправить идентификатор,
 * перезапустить расширение. Свести их в одно «не найдено» значит отправить человека проверять
 * наугад — что мы и делали, пока кнопка просто не появлялась.
 */
export type ProbeFailure =
  | 'no_bridge'   // на странице нет chrome.runtime: расширение её не видит
  | 'no_answer'   // мост есть, ответа нет: чужой идентификатор или расширение выключено
  | 'silent'      // расширение молчит дольше отведённого: service worker не проснулся

type Probe = { ok: true; reply: ExtensionReply } | { ok: false; failure: ProbeFailure }

function ask(message: unknown, timeoutMs = 3000): Promise<Probe> {
  const chromeRuntime = runtime()
  const send = chromeRuntime?.sendMessage
  // chrome.runtime появляется на странице ТОЛЬКО если расширение объявило её домен в
  // externally_connectable, и появляется он при загрузке. Расширение, установленное при открытой
  // вкладке, этой вкладке невидимо до перезагрузки — самая частая причина «ничего не работает».
  if (!chromeRuntime || !send) return Promise.resolve({ ok: false, failure: 'no_bridge' })
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Probe) => { if (!settled) { settled = true; resolve(value) } }
    // Расширение может быть установлено и не отвечать — например, service worker уснул. Ждать
    // вечно нельзя: кнопка останется в состоянии «связываю…» навсегда.
    window.setTimeout(() => finish({ ok: false, failure: 'silent' }), timeoutMs)
    try {
      send.call(chromeRuntime, EXTENSION_ID, message, (response) => {
        // Если расширения с таким идентификатором нет, Chrome не бросает исключение, а выставляет
        // lastError и зовёт колбэк с undefined. Не прочитать lastError — значит получить в консоли
        // «Unchecked runtime.lastError» на каждой загрузке страницы.
        if (chromeRuntime.lastError || !response) { finish({ ok: false, failure: 'no_answer' }); return }
        finish({ ok: true, reply: response })
      })
    } catch { finish({ ok: false, failure: 'no_answer' }) }
  })
}

export type ExtensionState = 'linked' | 'unlinked' | 'expired' | ProbeFailure

/** Стоит ли расширение, отвечает ли и есть ли у него живая сессия. */
export async function extensionState(): Promise<ExtensionState> {
  const probe = await ask({ type: 'nemo:ping' })
  if (!probe.ok) return probe.failure
  if (!probe.reply.ok) return 'no_answer'
  if (probe.reply.linked) return 'linked'
  // Просроченная связь отличается от отсутствующей: иначе в кабинете горит «Связано» из памяти
  // страницы, а расширение говорит «нет связи», и человек не знает, кому верить.
  return probe.reply.expired ? 'expired' : 'unlinked'
}

/** Отвечает ли расширение вообще. По этому признаку решается, что показывать владельцу. */
export const extensionReachable = (state: ExtensionState) =>
  state === 'linked' || state === 'unlinked' || state === 'expired'

/**
 * Передать расширению текущую сессию.
 *
 * Отдаётся ровно access_token и его срок. Refresh token НЕ передаётся: им можно выпускать новые
 * сессии сколько угодно долго, и утечка такого токена стоит дороже, чем неудобство связаться
 * заново раз в час.
 */
export async function linkExtension(session: { access_token: string; expires_at?: number }): Promise<boolean> {
  if (!session?.access_token || !session.expires_at) return false
  const probe = await ask({
    type: 'nemo:link',
    session: { access_token: session.access_token, expires_at: session.expires_at },
  })
  return probe.ok && Boolean(probe.reply.ok)
}

/** Забрать сессию обратно. Нужна на общем компьютере и при передаче магазина другому человеку. */
export async function unlinkExtension(): Promise<boolean> {
  const probe = await ask({ type: 'nemo:unlink' })
  return probe.ok && Boolean(probe.reply.ok)
}

export type BrowserTaskResult = {
  ok: boolean
  reason?: string
  done: number
  failed: number
  submitted: boolean
  needsConfirmation: boolean
  note?: string
  pageUrl?: string
}

/**
 * Запустить поручение в локальном браузере пользователя.
 *
 * Сайт не получает доступ к tabs API: он передаёт только текст поручения доверенному расширению.
 * Расширение само держит доменную границу seller.uzum.uz и требует отдельного подтверждения для
 * финальной отправки карточки на модерацию.
 */
export async function runExtensionBrowserTask(
  instruction: string,
  confirmRisky = false,
): Promise<BrowserTaskResult> {
  // 12 экранов включают сетевые вызовы модели и загрузку SPA. Не объявляем задачу «зависшей»,
  // пока расширение ещё честно работает: преждевременный retry может повторно изменить карточку.
  const probe = await ask({ type: 'nemo:run-browser', instruction, confirmRisky }, 10 * 60_000)
  if (!probe.ok) {
    return { ok: false, reason: probe.failure, done: 0, failed: 0, submitted: false, needsConfirmation: false }
  }
  return {
    ok: Boolean(probe.reply.ok),
    reason: probe.reply.reason ?? probe.reply.error,
    done: Number(probe.reply.done ?? 0),
    failed: Number(probe.reply.failed ?? 0),
    submitted: Boolean(probe.reply.submitted),
    needsConfirmation: Boolean(probe.reply.needsConfirmation),
    note: probe.reply.note,
    pageUrl: probe.reply.pageUrl,
  }
}
