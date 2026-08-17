// Шлюз платформенных токенов Nemo для SDR.
//
// ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ВЕТКА В commerce-control — и это главное архитектурное решение здесь.
// В commerce-control около тридцати действий, включая set_auto_submit, apply_proposal и
// report_extension_result. Если бы токен принимался там, единственной защитой опасных операций
// оставался бы белый список — то есть одна проверка, которую можно однажды забыть добавить к новому
// действию. Здесь опасные действия ФИЗИЧЕСКИ недостижимы: их код живёт в другой функции, и никакой
// белый список этого не отменяет и не может ослабить.
//
// Пайплайн отсюда НЕ запускается. Тридцать-пятьдесят лидов — это запрос к Overpass, N загрузок
// чужих сайтов и N вызовов модели, то есть минуты работы; Edge Function будет убита по времени
// раньше, чем закончит, и клиент получит обрыв вместо результата. Задача ставится в очередь,
// работает воркер, клиент забирает результат по job_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { entitlementFor, lockMessage } from '../_shared/entitlement.ts'
import {
  REFUSAL_STATUS,
  authorizeAction,
  hashToken,
  tokenFromHeader,
  type SdrAction,
  type TokenRefusal,
  type TokenRow,
} from '../_shared/apiTokens.ts'

const URL_ = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PEPPER = Deno.env.get('NEMO_TOKEN_PEPPER') ?? ''

/** Оценка расхода: один лид — примерно один вызов модели. Списывается при постановке, возвращается
 * при окончательном провале (см. finish_sdr_job). Число намеренно грубое и явное, а не спрятанное
 * в коде воркера: владелец должен видеть цену прогона ДО того, как он начнётся. */
const TOKENS_PER_LEAD = 700
const MAX_LIMIT = 200

function refuse(refusal: TokenRefusal) {
  return json({ error: refusal }, REFUSAL_STATUS[refusal])
}

/** Токен → строка таблицы. Один запрос по уникальному индексу отпечатка, без перебора. */
async function loadToken(admin: ReturnType<typeof createClient>, token: string): Promise<TokenRow | null> {
  const hash = await hashToken(token, PEPPER)
  const { data } = await admin
    .from('nemo_api_tokens')
    .select('id, account_id, allowed_actions, rate_limit_per_minute, is_active, expires_at')
    .eq('token_hash', hash)
    .maybeSingle()
  return (data as TokenRow | null) ?? null
}

/**
 * Полная проверка входящего запроса: форма → существование → состояние → права → лимит частоты.
 *
 * Расход лимита считается ПОСЛЕДНИМ и только после того, как право подтверждено: иначе чужой
 * подобранный ключ жёг бы минутную квоту настоящего владельца, ничего не выполняя.
 */
async function authenticate(
  admin: ReturnType<typeof createClient>,
  req: Request,
  action: SdrAction,
): Promise<{ ok: true; tokenId: string; accountId: string } | { ok: false; response: Response }> {
  if (!PEPPER) {
    // Без перца отпечаток посчитать нечем. Отказываем закрыто: работать «пока без проверки» тут
    // означало бы принимать любой токен.
    console.error('[sdr-api] NEMO_TOKEN_PEPPER не задан — шлюз отключён')
    return { ok: false, response: json({ error: 'gateway_not_configured' }, 503) }
  }

  const token = tokenFromHeader(req.headers.get('Authorization'))
  if (!token) return { ok: false, response: refuse('no_token') }

  const row = await loadToken(admin, token)
  const verdict = authorizeAction(row, action)
  if (!verdict.ok) return { ok: false, response: refuse(verdict.refusal) }

  const { data: allowed } = await admin.rpc('nemo_token_consume_rate', {
    p_token_id: verdict.tokenId,
    p_limit: row!.rate_limit_per_minute,
  })
  if (allowed === false) return { ok: false, response: refuse('rate_limited') }

  // Отметка использования — для ревокации по признаку «ключом давно не пользовались» и для аудита.
  // Ошибка записи здесь не должна ломать запрос: это наблюдение, а не разрешение.
  await admin.from('nemo_api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', verdict.tokenId)

  return { ok: true, tokenId: verdict.tokenId, accountId: verdict.accountId }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight

  const admin = createClient(URL_, SERVICE)
  const url = new URL(req.url)
  // Путь приходит как /sdr-api/jobs[/:id] — имя функции в начале срезается.
  const path = url.pathname.replace(/^\/+sdr-api/, '').replace(/\/+$/, '') || '/'

  // ── Постановка задачи ───────────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/jobs') {
    const auth = await authenticate(admin, req, 'sdr:trigger')
    if (!auth.ok) return auth.response

    // Замок подписки остаётся и здесь: токен отвечает на «кто», подписка — на «вправе ли вообще».
    const access = await entitlementFor(admin, auth.accountId)
    if (!access.allowed) {
      return json({ error: 'subscription_required', reason: access.reason, message: lockMessage(access) }, 402)
    }

    const body = await req.json().catch(() => null)
    const query = String(body?.query ?? '').trim().slice(0, 200)
    const city = String(body?.city ?? '').trim().slice(0, 120)
    const limit = Math.min(Math.max(Number(body?.limit ?? 50) || 50, 1), MAX_LIMIT)
    const icp = String(body?.icp ?? '').trim().slice(0, 2000)
    if (query.length < 2 || city.length < 2) return json({ error: 'query_and_city_required' }, 400)

    const { data, error } = await admin.rpc('enqueue_sdr_job', {
      p_account_id: auth.accountId,
      p_token_id: auth.tokenId,
      p_params: { query, city, limit, icp: icp || null },
      p_cost: limit * TOKENS_PER_LEAD,
    })
    if (error) {
      console.error('[sdr-api] enqueue failed:', error.message)
      return json({ error: 'enqueue_failed' }, 500)
    }
    if (data?.ok !== true) return json(data ?? { error: 'enqueue_failed' }, 402)

    // 202: задача принята, но НЕ выполнена. Двести здесь означало бы «готово», и клиент,
    // прочитавший его буквально, ушёл бы за результатом, которого ещё нет.
    return json({ ok: true, job_id: data.job_id, status: 'queued', reserved_tokens: data.reserved }, 202)
  }

  // ── Состояние задачи и её лиды ──────────────────────────────────────────────────────────────
  const jobMatch = path.match(/^\/jobs\/([0-9a-f-]{36})$/i)
  if (req.method === 'GET' && jobMatch) {
    const auth = await authenticate(admin, req, 'sdr:read')
    if (!auth.ok) return auth.response

    const { data: job } = await admin
      .from('sdr_jobs')
      .select('id, status, params, stats, error, attempts, created_at, finished_at')
      // Привязка к аккаунту токена ОБЯЗАТЕЛЬНА: без неё чужой job_id, подобранный или подсмотренный,
      // отдал бы лиды другого аккаунта. Это единственное место, где токен касается чужих данных.
      .eq('account_id', auth.accountId)
      .eq('id', jobMatch[1])
      .maybeSingle()
    if (!job) return json({ error: 'job_not_found' }, 404)

    const { data: leads } = await admin
      .from('sdr_leads')
      .select('name, city, phone, website, address, rating, reviews, enrichment, score, found_at')
      .eq('job_id', job.id)
      .order('created_at', { ascending: true })

    return json({ ok: true, job, leads: leads ?? [] })
  }

  return json({ error: 'not_found' }, 404)
})
