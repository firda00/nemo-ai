// CORS + JSON helpers for browser-invoked Edge Functions.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-setup-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PROD_ORIGIN = 'https://nemo.185.8.213.144.sslip.io'

/**
 * Расширение-загрузчик. Origin у него свой — chrome-extension://<идентификатор>.
 *
 * Разрешение точечное: один идентификатор, не подстановка. Он закреплён открытым ключом в
 * манифесте, поэтому не меняется при переносе папки, и «любое расширение» сюда не пролезет.
 *
 * Почему разрешение вообще понадобилось: без него предзапрос от расширения получал 403 ещё до
 * функции, и наружу это выглядело как «сеть недоступна» — при полностью исправной сети. Одного
 * host_permissions в манифесте мало: он снимает проверку на стороне браузера, а не на нашей.
 */
const EXTENSION_ORIGIN = 'chrome-extension://mafjjfinnlpigcbmhiabkiamnhnmgcca'

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '')
}

function originAllowed(origin: string): boolean {
  if (!origin) return true // server-to-server clients do not send Origin
  const configured = [Deno.env.get('APP_URL'), Deno.env.get('SITE_URL'), PROD_ORIGIN, EXTENSION_ORIGIN]
    .filter(Boolean)
    .map((v) => String(v).replace(/\/$/, ''))
  if (configured.includes(normalizeOrigin(origin))) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

/** A safe browser return origin for payment flows. Never reflect an arbitrary Origin header. */
export function trustedAppOrigin(req: Request): string {
  const origin = req.headers.get('origin') ?? ''
  // Расширение разрешено ЗВОНИТЬ, но не быть адресом возврата: касса после оплаты должна вернуть
  // покупателя на веб-страницу, а не в chrome-extension://, куда он попасть не может.
  if (origin && origin !== EXTENSION_ORIGIN && originAllowed(origin)) return normalizeOrigin(origin)
  return normalizeOrigin(String(Deno.env.get('APP_URL') || Deno.env.get('SITE_URL') || PROD_ORIGIN))
}

/** Reject browser preflights from untrusted origins before the function runs. */
export function corsPreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  const origin = req.headers.get('origin') ?? ''
  if (!originAllowed(origin)) return new Response('forbidden origin', { status: 403 })
  return new Response('ok', {
    headers: { ...corsHeaders, ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) },
  })
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
