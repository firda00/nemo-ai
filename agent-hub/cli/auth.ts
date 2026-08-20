/*
 * Вход в Nemo из терминала и хранение сессии.
 *
 * ЧТО ЗДЕСЬ ХРАНИТСЯ И ЧЕГО ЗДЕСЬ НЕТ.
 *
 * На диск ложатся ТОЛЬКО токены — access и refresh, выданные Supabase. Пароль не сохраняется
 * никогда и нигде: он живёт ровно столько, сколько идёт запрос на вход, и не попадает ни в файл,
 * ни в журнал, ни в историю оболочки. Файл кладётся с правами 0600 — читать его может только
 * владелец; в общей системе иначе его прочтёт кто угодно.
 *
 * ПОЧЕМУ ПАРОЛЬ, А НЕ КОД ЧЕРЕЗ БРАУЗЕР. Кодовый вход надёжнее (пароль вообще не проходит через
 * терминал), но требует эндпоинта, который выдаёт и подтверждает код. Такого пока нет, а
 * придумывать его «на глазок» — это самодельная аутентификация, что хуже пароля по HTTPS.
 * Когда эндпоинт появится, здесь меняется одна функция.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Куда складывается сессия. Каталог создаётся с правами 0700. */
export function authPath(home = os.homedir()): string {
  return path.join(home, '.nemo', 'auth.json')
}

export interface Session {
  access_token: string
  refresh_token: string
  /** Секунды эпохи. Сравнивается с запасом: токен, истекающий через минуту, уже негоден. */
  expires_at: number
  email: string
}

/**
 * Токен пора обновлять?
 *
 * Запас в 60 секунд намеренный. Без него токен, истекающий в момент отправки, проходит проверку
 * здесь и получает отказ на сервере — а выглядит это как «CLI сломался», хотя сессия просто
 * закончилась в неудачную секунду.
 */
export function needsRefresh(session: Pick<Session, 'expires_at'>, nowSeconds: number): boolean {
  return !Number.isFinite(session.expires_at) || session.expires_at - 60 <= nowSeconds
}

export function readSession(file = authPath()): Session | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Session>
    if (!parsed?.access_token || !parsed?.refresh_token) return null
    return {
      access_token: String(parsed.access_token),
      refresh_token: String(parsed.refresh_token),
      expires_at: Number(parsed.expires_at ?? 0),
      email: String(parsed.email ?? ''),
    }
  } catch { return null }
}

export function writeSession(session: Session, file = authPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  // Права выставляются ОТДЕЛЬНО: mode в writeFileSync применяется только при СОЗДАНИИ файла, и
  // перезапись поверх существующего оставила бы прежние — например, 0644 от старой версии.
  try { fs.chmodSync(file, 0o600) } catch { /* на Windows прав POSIX нет — там защищает ACL профиля */ }
}

export function clearSession(file = authPath()): void {
  try { fs.rmSync(file) } catch { /* нечего удалять */ }
}

/** Ответ Supabase на вход или обновление. Поля берутся выборочно: остальное нам не нужно. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  user?: { email?: string }
  error?: string
  error_description?: string
  msg?: string
}

const failureText = (body: TokenResponse, status: number): string =>
  body.error_description || body.msg || body.error || `сервер ответил ${status}`

/**
 * Вход по паролю. Возвращает сессию либо человеческое объяснение отказа.
 *
 * Пароль передаётся аргументом и НЕ возвращается наружу ни в каком виде — в том числе в тексте
 * ошибки. Сообщение, в котором процитировано введённое, уходит в буфер прокрутки терминала, в
 * журнал сборки и в переписку с поддержкой — то есть живёт дольше самой ошибки.
 */
export async function signIn(
  deps: { supabaseUrl: string; anonKey: string; fetchImpl?: typeof fetch },
  email: string,
  password: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const doFetch = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${deps.supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: deps.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  } catch (error) {
    return { ok: false, error: `не удалось связаться с сервером: ${String((error as Error).message).slice(0, 80)}` }
  }
  const body = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || !body.access_token || !body.refresh_token) {
    return { ok: false, error: failureText(body, response.status) }
  }
  return {
    ok: true,
    session: {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: nowSeconds + Number(body.expires_in ?? 3600),
      email: body.user?.email ?? email,
    },
  }
}

/** Продление сессии по refresh-токену. Тот же контракт ответа, что и у входа. */
export async function refresh(
  deps: { supabaseUrl: string; anonKey: string; fetchImpl?: typeof fetch },
  session: Session,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  const doFetch = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${deps.supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: deps.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    })
  } catch (error) {
    return { ok: false, error: `не удалось связаться с сервером: ${String((error as Error).message).slice(0, 80)}` }
  }
  const body = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || !body.access_token || !body.refresh_token) {
    return { ok: false, error: failureText(body, response.status) }
  }
  return {
    ok: true,
    session: {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: nowSeconds + Number(body.expires_in ?? 3600),
      email: body.user?.email ?? session.email,
    },
  }
}
