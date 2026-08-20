/*
 * Порядок входа при запуске CLI.
 *
 * Собран отдельно от точки входа, чтобы его можно было проверить без запуска терминала: спрашивание
 * и запись на диск переданы зависимостями, а решения (нужен ли вход, годится ли сессия, стоит ли
 * продлевать) — обычный код, который проверяется таблицей случаев.
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './defaults.ts'
import { clearSession, needsRefresh, readSession, refresh, signIn, writeSession, type Session } from './auth.ts'

export interface LoginDeps {
  read: () => Session | null
  write: (session: Session) => void
  clear: () => void
  askEmail: () => Promise<string>
  askPassword: () => Promise<string>
  say: (line: string) => void
  now?: () => number
  fetchImpl?: typeof fetch
  /** Сколько раз переспросить при неверных данных. Ноль означает «не спрашивать вовсе». */
  attempts?: number
}

const endpoints = { supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }

/**
 * Отдаёт действующую сессию: из файла, продлением или новым входом.
 *
 * ПРОДЛЕНИЕ ПРОБУЕТСЯ ДО ВОПРОСА О ПАРОЛЕ. Иначе человек, оставивший CLI на ночь, утром получает
 * форму входа при живом refresh-токене — и решает, что «оно опять разлогинилось».
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

  const attempts = deps.attempts ?? 3
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const email = await deps.askEmail()
    if (!email) { deps.say('Почта не введена.'); continue }
    const password = await deps.askPassword()
    if (!password) { deps.say('Пароль не введён.'); continue }

    const result = await signIn(io, email, password, now())
    if (result.ok) {
      deps.write(result.session)
      deps.say(`Вход выполнен: ${result.session.email}`)
      return result.session
    }
    // Причина отказа показывается как есть от сервера, но БЕЗ введённых данных: сообщение с
    // паролем внутри уходит в буфер прокрутки и в переписку с поддержкой.
    deps.say(`Не вошли: ${result.error}${attempt < attempts ? ' — попробуйте ещё раз' : ''}`)
  }
  return null
}

/** Выход: файл сессии удаляется. Токены на сервере при этом остаются действительными до истечения. */
export function logout(): void {
  clearSession()
}

export { readSession, writeSession }
