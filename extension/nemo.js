// Связь с Nemo. Единственное место, где расширение ходит в наш бэкенд.
//
// Токен — обычная сессия владельца, полученная из открытой вкладки Nemo. Пароль расширение не
// видит никогда: логин остаётся на сайте, сюда приезжает только короткоживущий access token.
//
// Хранится он в chrome.storage.session, а не в local: session живёт до закрытия браузера и не
// ложится на диск. Токен на диске переживает и вкладку, и вечер, и человека, который сядет за этот
// компьютер следующим.

const NEMO_ORIGIN = 'https://nemo.185.8.213.144.sslip.io'

/**
 * Куда расширение ходит за заданиями.
 *
 * ЭТО НЕ АДРЕС САЙТА. На nemo.185.8.213.144.sslip.io лежит только собранный фронтенд — статика;
 * commerce-control это Edge Function, и живёт она на домене Supabase. Указать сюда адрес стенда
 * значит стучаться в статику и получать 404 на каждое задание.
 *
 * Именно этот домен обязан быть в host_permissions манифеста: без него запрос расширения идёт
 * как обычный браузерный, упирается в проверку origin на стороне функции и падает ещё на
 * предзапросе — наружу это выглядит как «сеть недоступна», хотя сеть в порядке.
 */
const FUNCTIONS_URL = 'https://ogfmyjiuqmgroobckdyw.supabase.co/functions/v1/commerce-control'

/**
 * Публичный ключ проекта. Не секрет: он и так лежит в каждом браузере, открывшем сайт.
 *
 * Шлюз Supabase ждёт его отдельным заголовком рядом с токеном пользователя. Без него запрос
 * отвергается ещё до функции, и отказ выглядит как проблема доступа, а не как отсутствующий
 * заголовок.
 */
const ANON_KEY = "sb_publishable_QvdG3S1oMAgXWv53R2_hpQ_osQd_s8_"

/** Пять минут запаса: токен, истёкший в середине заполнения формы, бросает карточку недоделанной. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export const nemoOrigin = () => NEMO_ORIGIN

export async function saveSession(session) {
  const accessToken = typeof session?.access_token === 'string' ? session.access_token : ''
  const expiresAt = Number(session?.expires_at)
  if (!accessToken || !Number.isFinite(expiresAt)) return false
  // expires_at у Supabase в СЕКУНДАХ. Умножение здесь пропустить — значит считать токен
  // истёкшим в 1970 году и требовать перепривязки на каждом запуске.
  await chrome.storage.session.set({ nemo: { accessToken, expiresAtMs: expiresAt * 1000 } })
  return true
}

export async function readSession() {
  return (await sessionState()).session
}

/**
 * Состояние связи ПОДРОБНО: «не связывались» и «связь просрочена» — разные беды.
 *
 * Токен живёт около часа. Раньше оба случая давали одно «нет связи», и владелец, который связался
 * утром, читал днём тот же текст, что и человек, не связавшийся ни разу: «откройте Nemo и
 * нажмите Связать» — совет, который он уже выполнял и потому ему не верит.
 */
export async function sessionState() {
  const stored = await chrome.storage.session.get('nemo')
  const session = stored?.nemo
  if (!session?.accessToken) return { session: null, expired: false }
  if (session.expiresAtMs - EXPIRY_MARGIN_MS <= Date.now()) {
    return { session: null, expired: true }
  }
  return { session, expired: false }
}

export async function forgetSession() {
  await chrome.storage.session.remove('nemo')
}

/**
 * Вызов действия commerce-control.
 *
 * Отказ возвращается объектом, а не исключением: расширение обязано уметь сказать «Nemo не
 * ответил» так же спокойно, как «Uzum отказал», — иначе любая сетевая икота выглядит как поломка
 * карточки.
 */
export async function callNemo(action, body = {}) {
  const session = await readSession()
  if (!session) return { ok: false, error: 'not_linked' }
  try {
    const response = await fetch(FUNCTIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...body }),
    })
    // 401 означает протухшую сессию, а не отсутствие прав: связь надо восстановить, а не искать
    // ошибку в карточке. Забываем токен сразу, чтобы следующий запуск честно попросил перепривязку.
    if (response.status === 401) {
      await forgetSession()
      return { ok: false, error: 'not_linked' }
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok) return { ok: false, error: payload?.error ?? `http_${response.status}` }
    return { ok: true, data: payload }
  } catch {
    return { ok: false, error: 'network' }
  }
}

/** Следующая карточка к отправке. null — работы нет, и это не ошибка. */
export async function nextTask() {
  const result = await callNemo('next_extension_task')
  if (!result.ok) return result
  return { ok: true, task: result.data?.task ?? null }
}

/**
 * Исход попытки — в тот же журнал, что и попытки через API.
 *
 * Один журнал на оба способа выбран намеренно: две таблицы дали бы две несходящиеся статистики
 * «сколько карточек доехало», и разбирать спор пришлось бы, складывая их руками.
 */
export async function reportResult({ draftId, status, reason, message, externalProductId }) {
  return await callNemo('report_extension_result', {
    draft_id: draftId,
    status,
    reason,
    message,
    external_product_id: externalProductId ?? null,
  })
}
