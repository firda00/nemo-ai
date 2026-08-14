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
 * Идентификатор расширения.
 *
 * У распакованного расширения он выводится из ПУТИ К ПАПКЕ: перенесли папку — получили другой
 * идентификатор, и связь молча перестанет находиться. Поэтому значение вынесено в переменную
 * сборки, а не зашито намертво. При публикации в Chrome Web Store идентификатор снова сменится.
 */
export const EXTENSION_ID =
  (import.meta.env.VITE_NEMO_EXTENSION_ID as string | undefined) ?? 'cnffjnbpjgmmocihihiphedpmacgnfle'

type ExtensionReply = { ok?: boolean; error?: string; linked?: boolean }

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

function ask(message: unknown): Promise<Probe> {
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
    window.setTimeout(() => finish({ ok: false, failure: 'silent' }), 3000)
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

export type ExtensionState = 'linked' | 'unlinked' | ProbeFailure

/** Стоит ли расширение, отвечает ли и есть ли у него живая сессия. */
export async function extensionState(): Promise<ExtensionState> {
  const probe = await ask({ type: 'nemo:ping' })
  if (!probe.ok) return probe.failure
  if (!probe.reply.ok) return 'no_answer'
  return probe.reply.linked ? 'linked' : 'unlinked'
}

/** Отвечает ли расширение вообще. По этому признаку решается, что показывать владельцу. */
export const extensionReachable = (state: ExtensionState) => state === 'linked' || state === 'unlinked'

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
