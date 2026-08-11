/**
 * Отказ по подписке, вынутый из ответа edge-функции.
 *
 * `supabase.functions.invoke` на любой не-2xx НЕ кладёт тело в `data`. Оно возвращает
 * `FunctionsHttpError`, у которого исходный `Response` спрятан в `context`, а `data` равен null.
 * Поэтому наивная проверка `data.error === 'subscription_required'` не сработала бы никогда:
 * владелец увидел бы общее «не удалось собрать черновик» и не узнал бы, что дело в подписке.
 */
export type Paywall = { reason: string; message: string }

const PAYWALL_ERROR = 'subscription_required'

/** Тело ответа, откуда бы оно ни пришло: из `data` при 2xx или из `error.context` при отказе. */
export async function payloadOf(error: unknown, data: unknown): Promise<Record<string, unknown> | null> {
  if (data && typeof data === 'object') return data as Record<string, unknown>
  const context = (error as { context?: unknown })?.context
  // `context` — это Response. Читаем его один раз и молча: разобранное тело здесь бонус, а не
  // обязательство, и падение разбора не должно превращаться в падение страницы.
  if (context && typeof (context as Response).json === 'function') {
    try { return await (context as Response).json() as Record<string, unknown> } catch { return null }
  }
  return null
}

/** Пейволл или нет. Строка `subscription_required` — единственный признак; коды HTTP не читаем. */
export function paywallFrom(payload: Record<string, unknown> | null): Paywall | null {
  if (!payload || payload.error !== PAYWALL_ERROR) return null
  const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : ''
  return { reason: typeof payload.reason === 'string' ? payload.reason : 'trial_expired', message }
}

/**
 * Куда ведёт кнопка оплаты.
 *
 * Тарифов в интерфейсе пока нет, поэтому кнопка ведёт в чат — там живой человек и там же владелец
 * уже разговаривает с Nemo. Адрес берётся из окружения: вписывать в код чужой телеграм-хендл
 * значит однажды отправить клиента не туда и не узнать об этом.
 */
export function salesChatUrl(): string {
  const configured = import.meta.env?.VITE_SALES_TELEGRAM
  return typeof configured === 'string' && configured.startsWith('https://t.me/')
    ? configured
    : 'https://t.me/tset_nemo_bot'
}
