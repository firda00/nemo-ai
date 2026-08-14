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
 * Один запрос к расширению.
 *
 * Отсутствие расширения и его отказ — РАЗНЫЕ ответы. Свести их в один null значило бы показывать
 * «установите расширение» человеку, у которого оно установлено и просто ответило отказом.
 */
function ask(message: unknown): Promise<ExtensionReply | null> {
  const chromeRuntime = runtime()
  const send = chromeRuntime?.sendMessage
  if (!chromeRuntime || !send) return Promise.resolve(null)
  return new Promise((resolve) => {
    // Если расширения с таким идентификатором нет, Chrome не бросает исключение, а выставляет
    // lastError и зовёт колбэк с undefined. Не прочитать lastError — значит получить в консоли
    // «Unchecked runtime.lastError» на каждой загрузке страницы.
    let settled = false
    const finish = (value: ExtensionReply | null) => { if (!settled) { settled = true; resolve(value) } }
    // Расширение может быть установлено, но не отвечать — например, service worker упал. Ждать
    // вечно нельзя: кнопка останется в состоянии «связываю…» навсегда.
    window.setTimeout(() => finish(null), 3000)
    try {
      send.call(chromeRuntime, EXTENSION_ID, message, (response) => {
        if (chromeRuntime.lastError) { finish(null); return }
        finish(response ?? null)
      })
    } catch { finish(null) }
  })
}

export type ExtensionState = 'absent' | 'linked' | 'unlinked'

/** Стоит ли расширение и есть ли у него живая сессия. */
export async function extensionState(): Promise<ExtensionState> {
  const reply = await ask({ type: 'nemo:ping' })
  if (!reply?.ok) return 'absent'
  return reply.linked ? 'linked' : 'unlinked'
}

/**
 * Передать расширению текущую сессию.
 *
 * Отдаётся ровно access_token и его срок. Refresh token НЕ передаётся: им можно выпускать новые
 * сессии сколько угодно долго, и утечка такого токена стоит дороже, чем неудобство связаться
 * заново раз в час.
 */
export async function linkExtension(session: { access_token: string; expires_at?: number }): Promise<boolean> {
  if (!session?.access_token || !session.expires_at) return false
  const reply = await ask({
    type: 'nemo:link',
    session: { access_token: session.access_token, expires_at: session.expires_at },
  })
  return Boolean(reply?.ok)
}

/** Забрать сессию обратно. Нужна на общем компьютере и при передаче магазина другому человеку. */
export async function unlinkExtension(): Promise<boolean> {
  const reply = await ask({ type: 'nemo:unlink' })
  return Boolean(reply?.ok)
}
