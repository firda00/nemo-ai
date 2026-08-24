// Публичный приём заявок с /waitlist и экрана входа. Пишет в waitlist_requests через
// атомарный RPC waitlist_submit (advisory-lock + лимит 5/час на ip + дедуп по email за сутки).
//
//   POST /functions/v1/waitlist
//   body { name?, email, phone?, company?, leads?, note?, source?, website? }  ->  { ok }
//
// Защиты: honeypot-поле `website` (заполнено => «успех» без записи), потолки длины всех полей,
// allowlist для source, лимит размера тела. IP хэшируется HMAC-SHA256 с обязательным секретом
// WAITLIST_IP_PEPPER — без секрета функция отвечает 503 (fail closed), голый SHA-256 от IPv4
// обращается перебором. Наружу не возвращаются ни тексты ошибок БД, ни присланные данные.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const IP_PEPPER = Deno.env.get('WAITLIST_IP_PEPPER') ?? ''

const MAX_BODY = 10_000
const MIN_PEPPER = 32
const SOURCES = new Set(['waitlist', 'auth', 'pricing'])
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/

// Поля принимаются ТОЛЬКО строками: объект или массив в JSON превратился бы в '[object Object]'.
const field = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, max)
  return s || null
}

async function hashIp(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(IP_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  // Короткий перец превращает HMAC в перебираемый: без нормального секрета не работаем вовсе.
  if (IP_PEPPER.length < MIN_PEPPER) return json({ ok: false, error: 'unavailable' }, 503)

  try {
    // Отсечь большое тело ДО чтения: req.text() иначе прочитал бы его целиком.
    const declared = Number(req.headers.get('content-length') ?? '')
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_BODY) {
      return json({ ok: false, error: 'too_large' }, 413)
    }
    const raw = await req.text()
    if (raw.length > MAX_BODY) return json({ ok: false, error: 'too_large' }, 413)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ ok: false, error: 'bad_request' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ ok: false, error: 'bad_request' }, 400)
    }

    const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : ''
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'bad_email' }, 400)

    // Honeypot: людям поле не видно; заполнено — отвечаем как при успехе, ничего не сохраняя.
    if (typeof body.website === 'string' && body.website.trim()) return json({ ok: true })
    if (body.website != null && typeof body.website !== 'string') return json({ ok: true })

    const source = typeof body.source === 'string' ? body.source : 'waitlist'
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
    const ipHash = ip ? await hashIp(ip) : null

    const db = createClient(SUPABASE_URL, SERVICE_ROLE)
    const { data, error } = await db.rpc('waitlist_submit', {
      p_name: field(body.name, 200),
      p_email: email,
      p_phone: field(body.phone, 200),
      p_company: field(body.company, 200),
      p_leads: field(body.leads, 200),
      p_note: field(body.note, 1000),
      p_source: SOURCES.has(source) ? source : 'waitlist',
      p_ip_hash: ipHash,
    })
    if (error) return json({ ok: false, error: 'failed' }, 500)
    if (data === 'rate_limited') return json({ ok: false, error: 'rate_limited' }, 429)
    // 'ok' и 'duplicate' наружу неразличимы: повтор той же заявки — это успех, а не повод
    // сообщать посетителю (или боту), какие email уже есть в базе.
    return json({ ok: true })
  } catch {
    return json({ ok: false, error: 'failed' }, 500)
  }
})
