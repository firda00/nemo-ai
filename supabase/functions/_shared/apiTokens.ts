// Платформенные токены Nemo: выдача, отпечаток, разрешение действия.
//
// Модуль намеренно НЕ читает окружение сам. Перец приходит аргументом, и это не стилистика: общий
// llm.ts этого проекта вызывает Deno.env.get() на уровне модуля и потому не импортируется из Node
// вовсе — из-за этого пришлось писать второй клиент OpenRouter для скорера. Здесь та же ошибка
// стоила бы дороже: проверить логику авторизации без запущенного Deno было бы нельзя.
//
// Web Crypto (crypto.subtle) есть и в Deno, и в Node 18+, поэтому один и тот же код считает
// отпечаток в обеих средах и проверяется тестами под Node.

/** Префикс виден в логах и в коде клиентов; по нему же отличается наш ключ от чужого. */
export const TOKEN_PREFIX = 'nemo_live_'
/** 32 символа из этого алфавита — около 165 бит энтропии. Перебор отпечатка бессмысленен. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const RANDOM_LENGTH = 32

/** Формат целиком, включая длину: короткий «токен» не должен случайно пройти как валидный. */
export const TOKEN_SHAPE = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9]{${RANDOM_LENGTH}}$`)

/**
 * Новый токен.
 *
 * crypto.getRandomValues, а не Math.random: второй предсказуем, и предсказуемый ключ доступа — это
 * не ключ. Отбрасывание остатка (rejection sampling) убрано намеренно: 62 не делит 256 нацело, но
 * смещение здесь порядка 1.5% на символ и на 165 битах энтропии не имеет значения; зато код без
 * цикла нельзя случайно сломать так, чтобы он молча выдавал короткие строки.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(RANDOM_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return `${TOKEN_PREFIX}${out}`
}

/**
 * Отпечаток токена — HMAC-SHA256 с серверным перцем, hex.
 *
 * Не argon2/bcrypt: те защищают ПАРОЛИ, то есть строки с малой энтропией, которые человек придумал.
 * Здесь строка случайная на 165 бит — перебирать её нечем, а платить сотни миллисекунд на КАЖДЫЙ
 * запрос шлюза было бы бессмысленной ценой.
 *
 * Не голый SHA-256: перец означает, что украденный дамп базы нельзя проверить на совпадение с
 * заранее посчитанной таблицей, не украв заодно секрет сервера.
 */
export async function hashToken(token: string, pepper: string): Promise<string> {
  if (!pepper) throw new Error('token_pepper_missing')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Токен из заголовка. Возвращает null на любой непохожей форме — разбирать чужое не наша задача. */
export function tokenFromHeader(header: string | null | undefined): string | null {
  const value = String(header ?? '').trim()
  const match = value.match(/^Bearer\s+(\S+)$/i)
  const token = match?.[1]
  return token && TOKEN_SHAPE.test(token) ? token : null
}

export interface TokenRow {
  id: string
  account_id: string
  allowed_actions: string[] | null
  rate_limit_per_minute: number
  is_active: boolean
  expires_at: string | null
}

export type TokenRefusal =
  | 'no_token'
  | 'unknown_token'
  | 'token_inactive'
  | 'token_expired'
  | 'action_not_allowed'
  | 'rate_limited'

export type TokenVerdict =
  | { ok: true; tokenId: string; accountId: string }
  | { ok: false; refusal: TokenRefusal }

/**
 * Вправе ли этот токен выполнить это действие.
 *
 * DENY BY DEFAULT — единственное правило, которое здесь нельзя ослаблять. Отсутствующий,
 * пустой или не содержащий действие список означает «нельзя». Обратная трактовка («не указано
 * значит всё») однажды превратила бы забытое поле в ключ от всех операций аккаунта.
 *
 * Проверки идут в порядке дешевизны и убывания вреда: сначала форма, потом существование, потом
 * состояние, потом права, и только в самом конце — расход лимита. Считать расход раньше проверки
 * прав значило бы позволить чужому ключу жечь лимит настоящего.
 */
export function authorizeAction(row: TokenRow | null | undefined, action: string): TokenVerdict {
  if (!row) return { ok: false, refusal: 'unknown_token' }
  if (!row.is_active) return { ok: false, refusal: 'token_inactive' }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, refusal: 'token_expired' }
  }
  const allowed = Array.isArray(row.allowed_actions) ? row.allowed_actions : []
  if (!allowed.includes(action)) return { ok: false, refusal: 'action_not_allowed' }
  return { ok: true, tokenId: row.id, accountId: row.account_id }
}

/** Человеческие ответы на отказ. Причина названа, но НИКОГДА не раскрывает, чем именно она вызвана
 * больше необходимого: «неизвестный токен» и «токен отключён» для чужого выглядят одинаково полезно,
 * а вот «действие не разрешено» подсказывает владельцу настоящего ключа, что править. */
export const REFUSAL_STATUS: Record<TokenRefusal, number> = {
  no_token: 401,
  unknown_token: 401,
  token_inactive: 401,
  token_expired: 401,
  action_not_allowed: 403,
  rate_limited: 429,
}

/** Действия, которые вообще существуют у этого шлюза. Шлюз НЕ проксирует commerce-control. */
export const SDR_ACTIONS = ['sdr:trigger', 'sdr:read'] as const
export type SdrAction = typeof SDR_ACTIONS[number]
