/*
 * Порядок входа при запуске CLI.
 *
 * Собран отдельно от точки входа, чтобы его можно было проверить без запуска терминала: спрашивание
 * и запись на диск переданы зависимостями, а решения (нужен ли вход, годится ли сессия, стоит ли
 * продлевать) — обычный код, который проверяется таблицей случаев.
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './defaults.ts'
import { clearSession, needsRefresh, readSession, refresh, writeSession, type Session } from './auth.ts'
import type { BrowserLoginResult } from './browser-login.ts'

export interface LoginDeps {
  read: () => Session | null
  write: (session: Session) => void
  clear: () => void
  browserLogin: () => Promise<BrowserLoginResult>
  say: (line: string) => void
  now?: () => number
  fetchImpl?: typeof fetch
}

const endpoints = { supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }

/**
 * Отдаёт действующую сессию: из файла, продлением или новым входом.
 *
 * ПРОДЛЕНИЕ ПРОБУЕТСЯ ДО ОТКРЫТИЯ БРАУЗЕРА. Иначе человек, оставивший CLI на ночь, утром получает
 * новый OAuth-экран при живом refresh-токене — и решает, что «оно опять разлогинилось».
 *
 * НЕУДАЧНОЕ ПРОДЛЕНИЕ СТИРАЕТ ФАЙЛ. Просроченный refresh-токен не станет годным сам собой, а
 * оставленный на диске он заставляет CLI ходить в сеть за отказом при каждом запуске.
 */
export async function ensureSession(deps: LoginDeps): Promise<Session | null> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const io = { ...endpoints, fetchImpl: deps.fetchImpl }

  const saved = deps.read()
  if (saved && !needsRefresh(saved, now())) return saved

  if (saved) {
    const renewed = await refresh(io, saved, now())
    if (renewed.ok) { deps.write(renewed.session); return renewed.session }
    deps.clear()
    deps.say(`Сессия истекла (${renewed.error}). Нужно войти заново.`)
  }

  const result = await deps.browserLogin()
  if (!result.ok) {
    deps.say(`Не вошли: ${result.error}`)
    return null
  }
  deps.write(result.session)
  return result.session
}

/** Выход: файл сессии удаляется. Токены на сервере при этом остаются действительными до истечения. */
export function logout(): void {
  clearSession()
}

export { readSession, writeSession }
