// API Gateway Nemo: HTTP-шлюз на Fastify перед очередью SDR и приёмником событий CRM.
//
// ЗАЧЕМ ОН НУЖЕН, если есть Edge Function `sdr-api`. Две разные причины, и обе про пределы Deno Deploy:
//
//   1. ОЖИДАНИЕ. Edge Function ограничена по времени выполнения и по числу одновременных экземпляров;
//      её нельзя заставить висеть на соединении с Dragonfly. Шлюз в контейнере — можно, и именно он
//      публикует сигнал, будящий воркеров мгновенно вместо опроса раз в пятнадцать секунд.
//   2. ВЕБХУКИ CRM. amoCRM и HubSpot шлют события пачками и повторяют доставку при любом не-2xx.
//      Приёмник должен отвечать быстро и стабильно, а не через холодный старт.
//
// Edge Function ОСТАЁТСЯ и не отключается. Это разные пути к одному состоянию: у обоих Postgres —
// источник правды, обоим один и тот же `apiTokens.ts` считает отпечаток и решает про права. Второй
// реализации авторизации здесь нет и быть не должно: расхождение между ними означало бы, что токен
// пускают в одну дверь и не пускают в другую, а разбираться в этом будут по жалобе клиента.
//
// ЧЕГО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ. Он не выполняет пайплайн. Тридцать-пятьдесят лидов — это запрос к Overpass,
// N загрузок чужих сайтов и N вызовов модели, то есть минуты; HTTP-запрос столько не живёт. Шлюз ставит
// задачу и отдаёт 202, работу делает воркер.

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  REFUSAL_STATUS,
  authorizeAction,
  hashToken,
  tokenFromHeader,
  type SdrAction,
  type TokenRefusal,
  type TokenRow,
} from '../../supabase/functions/_shared/apiTokens.ts'
import { createRuntimeClient, RuntimeRpcError } from '../../supabase/functions/_shared/runtime.ts'
import { ingestCrmEventInShadow } from '../../supabase/functions/_shared/runtimeCrm.ts'
import { UnifiedCRMEventSchema, crmIdempotencyKey, parseContract } from '../contracts/v5.ts'
import {
  AmoWebhookParseError,
  ingestNativeAmoWebhook,
  parseNativeAmoWebhook,
} from './amocrm-native.ts'
import { disabledQueue, type JobQueue } from './queue.ts'

/** Столько же, сколько в Edge Function. Расхождение означало бы разную цену за один и тот же прогон. */
const TOKENS_PER_LEAD = 700
const MAX_LIMIT = 200

/** Тело вебхука ограничено: гигабайтный «вебхук» — это не событие CRM, а попытка занять память. */
const MAX_BODY_BYTES = 256 * 1024

export interface SupabaseLike {
  from(table: string): {
    select: (columns: string) => {
      eq: (column: string, value: unknown) => {
        eq?: (column: string, value: unknown) => { maybeSingle: () => Promise<{ data: unknown }> }
        maybeSingle: () => Promise<{ data: unknown }>
        order: (column: string, options: { ascending: boolean }) => Promise<{ data: unknown[] | null }>
      }
      limit?: (n: number) => Promise<{ data: unknown[] | null; error: unknown }>
    }
    update: (values: Record<string, unknown>) => { eq: (column: string, value: unknown) => Promise<unknown> }
    insert: (values: Record<string, unknown>) => Promise<{ error: { code?: string; message?: string } | null }>
  }
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>
}

export interface GatewayDeps {
  admin: SupabaseLike
  queue: JobQueue
  pepper: string
  /** Общий секрет приёмника вебхуков CRM. Пустой — приём выключен, см. handleCrmWebhook. */
  crmSecret: string
  /** Проверка подписки. Отдельным параметром, потому что в Node модуль Edge Function недоступен. */
  entitlement?: (accountId: string) => Promise<{ allowed: boolean; reason?: string }>
  now?: () => number
}

export interface GatewayResponse {
  status: number
  body: Record<string, unknown>
}

const refuse = (refusal: TokenRefusal): GatewayResponse => ({
  status: REFUSAL_STATUS[refusal],
  body: { error: refusal },
})

/**
 * Проверка входящего запроса: форма → существование → состояние → права → лимит частоты.
 *
 * Порядок повторяет Edge Function буквально, и это важно: расход минутного лимита считается ПОСЛЕДНИМ
 * и только после подтверждения права. Иначе чужой подобранный ключ жёг бы квоту настоящего владельца,
 * ничего при этом не выполняя.
 */
export async function authenticate(
  deps: GatewayDeps,
  authorizationHeader: string | null | undefined,
  action: SdrAction,
): Promise<{ ok: true; tokenId: string; accountId: string } | { ok: false; response: GatewayResponse }> {
  if (!deps.pepper) {
    // Без перца отпечаток посчитать нечем. Отказываем ЗАКРЫТО: работать «пока без проверки» означало
    // бы принимать любой токен, то есть открыть очередь всему интернету.
    return { ok: false, response: { status: 503, body: { error: 'gateway_not_configured' } } }
  }

  const token = tokenFromHeader(authorizationHeader)
  if (!token) return { ok: false, response: refuse('no_token') }

  const hash = await hashToken(token, deps.pepper)
  const { data } = await deps.admin
    .from('nemo_api_tokens')
    .select('id, account_id, allowed_actions, rate_limit_per_minute, is_active, expires_at')
    .eq('token_hash', hash)
    .maybeSingle()

  const row = (data as TokenRow | null) ?? null
  const verdict = authorizeAction(row, action)
  if (!verdict.ok) return { ok: false, response: refuse(verdict.refusal) }

  const { data: allowed } = await deps.admin.rpc('nemo_token_consume_rate', {
    p_token_id: verdict.tokenId,
    p_limit: row!.rate_limit_per_minute,
  })
  if (allowed === false) return { ok: false, response: refuse('rate_limited') }

  // Отметка использования — для ревокации по признаку «ключом давно не пользовались». Отказ записи не
  // должен ломать запрос: это наблюдение, а не разрешение.
  await deps.admin
    .from('nemo_api_tokens')
    .update({ last_used_at: new Date(deps.now?.() ?? Date.now()).toISOString() })
    .eq('id', verdict.tokenId)
    .catch?.(() => {})

  return { ok: true, tokenId: verdict.tokenId, accountId: verdict.accountId }
}

// ── POST /v1/sdr/jobs ─────────────────────────────────────────────────────────────────────────────

/** Разбор тела постановки задачи. Пределы те же, что в Edge Function. */
export function parseJobRequest(body: unknown): { ok: true; params: { query: string; city: string; limit: number; icp: string | null } } | { ok: false; error: string } {
  const raw = (body ?? {}) as Record<string, unknown>
  const query = String(raw.query ?? '').trim().slice(0, 200)
  const city = String(raw.city ?? '').trim().slice(0, 120)
  // Пределы применяются в том же порядке: сначала число, потом границы. `Number('много') || 50`
  // даёт 50, а не отказ, — так же, как в Edge Function, чтобы одинаковый запрос стоил одинаково.
  const limit = Math.min(Math.max(Number(raw.limit ?? 50) || 50, 1), MAX_LIMIT)
  const icp = String(raw.icp ?? '').trim().slice(0, 2000)
  if (query.length < 2 || city.length < 2) return { ok: false, error: 'query_and_city_required' }
  return { ok: true, params: { query, city, limit, icp: icp || null } }
}

export async function handleCreateJob(
  deps: GatewayDeps,
  authorizationHeader: string | null | undefined,
  body: unknown,
): Promise<GatewayResponse> {
  const auth = await authenticate(deps, authorizationHeader, 'sdr:trigger')
  if (!auth.ok) return auth.response

  if (deps.entitlement) {
    // Замок подписки остаётся и здесь: токен отвечает на «кто», подписка — на «вправе ли вообще».
    const access = await deps.entitlement(auth.accountId)
    if (!access.allowed) {
      return { status: 402, body: { error: 'subscription_required', reason: access.reason ?? null } }
    }
  }

  const parsed = parseJobRequest(body)
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } }

  const { data, error } = await deps.admin.rpc('enqueue_sdr_job', {
    p_account_id: auth.accountId,
    p_token_id: auth.tokenId,
    p_params: parsed.params,
    p_cost: parsed.params.limit * TOKENS_PER_LEAD,
  })
  if (error) return { status: 500, body: { error: 'enqueue_failed' } }

  const result = data as { ok?: boolean; job_id?: string; reserved?: number } | null
  // Отказ по кредитам приходит значением, а не исключением: `enqueue_sdr_job` возвращает
  // {ok:false, error:'insufficient_credits'} и это ОТВЕТ, а не сбой.
  if (result?.ok !== true) return { status: 402, body: (result ?? { error: 'enqueue_failed' }) as Record<string, unknown> }

  // Сигнал публикуется ПОСЛЕ того, как задача создана в Postgres, и его неудача НЕ отменяет ответ.
  // Задача уже существует и кредиты уже зарезервированы; сказать клиенту «не получилось» значило бы
  // заставить его поставить её второй раз и заплатить дважды. Не ушедший сигнал стоит одной задержки
  // до следующего опроса воркера — и это всё.
  //
  // catch ЗДЕСЬ, хотя publish и так не бросает по своему контракту. Это не дублирование: защита от
  // денежной ошибки не должна зависеть от того, что чужая реализация JobQueue соблюдает договор.
  // Мутационный прогон показал, что без этой строки достаточно одной новой очереди, нарушающей
  // контракт, — и клиенты начнут платить дважды за уже принятые задачи.
  const signalled = await deps.queue.publish(result.job_id!).catch(() => false)

  // 202, а не 200: задача принята, но НЕ выполнена. Двести здесь означало бы «готово», и клиент,
  // прочитавший ответ буквально, ушёл бы за результатом, которого ещё нет.
  return {
    status: 202,
    body: {
      ok: true,
      job_id: result.job_id,
      status: 'queued',
      reserved_tokens: result.reserved,
      // Честно сообщаем, разбудили воркера или он узнает о задаче опросом: разница между секундой и
      // пятнадцатью заметна, и клиент вправе о ней знать.
      dispatch: signalled ? 'signalled' : 'polling',
    },
  }
}

// ── GET /v1/sdr/jobs/:id ──────────────────────────────────────────────────────────────────────────

export const JOB_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function handleGetJob(
  deps: GatewayDeps,
  authorizationHeader: string | null | undefined,
  jobId: string,
): Promise<GatewayResponse> {
  const auth = await authenticate(deps, authorizationHeader, 'sdr:read')
  if (!auth.ok) return auth.response

  if (!JOB_ID_SHAPE.test(jobId)) return { status: 400, body: { error: 'bad_job_id' } }

  // ПРИВЯЗКА К АККАУНТУ ОБЯЗАТЕЛЬНА. Без неё чужой job_id — подобранный или подсмотренный в логах —
  // отдал бы лиды другого аккаунта. Это единственное место, где токен касается данных, и порядок
  // условий здесь не косметика: account_id стоит первым и не может быть забыт при правке фильтра.
  const table = deps.admin.from('sdr_jobs')
    .select('id, status, params, stats, error, attempts, created_at, finished_at')
    .eq('account_id', auth.accountId)
  const { data: job } = await (table as { eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> } })
    .eq('id', jobId)
    .maybeSingle()

  if (!job) return { status: 404, body: { error: 'job_not_found' } }

  const { data: leads } = await deps.admin
    .from('sdr_leads')
    .select('name, city, phone, website, address, rating, reviews, enrichment, score, found_at')
    .eq('job_id', (job as { id: string }).id)
    .order('created_at', { ascending: true })

  return { status: 200, body: { ok: true, job: job as Record<string, unknown>, leads: leads ?? [] } }
}

// ── POST /v1/crm/webhook ──────────────────────────────────────────────────────────────────────────

/**
 * Сравнение секретов за постоянное время.
 *
 * Обычное `===` на строках выходит из сравнения на первом несовпавшем байте, и по времени ответа
 * секрет подбирается посимвольно. Длины сравниваются отдельно, потому что timingSafeEqual бросает на
 * разных длинах — но длина секрета и так не тайна.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (!expected) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Приём событий от amoCRM и HubSpot.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЕНО И ЧТО НЕТ. Доступ закрыт общим секретом в заголовке `x-nemo-crm-secret` и
 * сравнивается за постоянное время. Это НАША схема, и она работает. Собственные подписи провайдеров
 * (amoCRM подписывает тело своим ключом, HubSpot присылает X-HubSpot-Signature-v3) здесь НЕ
 * реализованы: их точный алгоритм — версия схемы, состав подписываемой строки, окно допустимого
 * расхождения времени — надо брать из их документации, а не угадывать. Угаданная проверка подписи
 * хуже отсутствующей: она создаёт впечатление защиты и отвергает законные события.
 *
 * ОТВЕТ НА ПОВТОР — 200, А НЕ ОШИБКА. Обе CRM повторяют доставку при любом не-2xx. Вернуть 409 на
 * дубликат значит получить его снова через минуту, потом через пять, и так до исчерпания их попыток.
 * Повтор — это штатная работа протокола, а не отказ, и уникальный ключ в базе уже сделал своё дело.
 */
export async function handleCrmWebhook(
  deps: GatewayDeps,
  secretHeader: string | null | undefined,
  body: unknown,
): Promise<GatewayResponse> {
  if (!deps.crmSecret) {
    // Приём выключен, а не «открыт для всех». Незаданный секрет — это незавершённая настройка, и
    // принимать в таком состоянии чужие события значит писать в свою базу что угодно.
    return { status: 503, body: { error: 'crm_webhook_not_configured' } }
  }
  if (!secretsMatch(String(secretHeader ?? ''), deps.crmSecret)) {
    return { status: 401, body: { error: 'bad_webhook_secret' } }
  }

  const checked = parseContract(UnifiedCRMEventSchema, body)
  if (!checked.ok) {
    // 400 — событие не пройдёт и на повторе, поэтому просить прислать его снова незачем. Причина
    // называется полем: «contactPhone: неверный формат» чинится за минуту, «invalid» — за час.
    return { status: 400, body: { error: 'invalid_event', details: checked.issues } }
  }

  const event = checked.data
  const idempotencyKey = crmIdempotencyKey({
    provider: event.provider,
    direction: 'INBOUND',
    eventType: event.eventType,
    externalId: event.externalDealId,
    occurredAt: event.occurredAt,
  })

  const { error } = await deps.admin.from('crm_sync_logs').insert({
    tenant_id: event.tenantId,
    idempotency_key: idempotencyKey,
    provider: event.provider,
    direction: 'INBOUND',
    payload: event as unknown as Record<string, unknown>,
    status: 'PROCESSED',
  })

  let duplicate = false
  if (error) {
    // 23505 — нарушение уникального ключа, то есть ровно повторная доставка. Именно ради этого случая
    // ключ и существует; отвечаем 200 и говорим прямо, что событие уже было.
    if (error.code === '23505') {
      duplicate = true
    } else {
      return { status: 500, body: { error: 'sync_log_failed' } }
    }
  }

  /*
   * SHADOW DUAL-WRITE NEVER BREAKS THE LEGACY ACK.
   *
   * By this point the legacy audit row is durable (or was already present). Returning a non-2xx
   * because the experimental runtime path failed would make amoCRM redeliver an event that legacy
   * already accepted. The runtime error is returned as a bounded code for metrics; no raw database
   * message or payload is reflected to the caller.
   */
  let runtimeShadow: Record<string, unknown>
  if (event.provider !== 'AMOCRM') {
    // ADR 001 explicitly names amoCRM as the first shadow connector. HubSpot stays legacy-only
    // until its own identity, replay and comparison contracts are approved.
    runtimeShadow = { ok: true, status: 'skipped_provider' }
  } else {
    try {
      const ingested = await ingestCrmEventInShadow(createRuntimeClient(deps.admin), {
        event,
        idempotencyKey,
      })
      runtimeShadow = {
        ok: true,
        status: ingested.status,
        workflow_id: ingested.workflow_id,
        inbox_event_id: ingested.inbox_event_id,
      }
    } catch (runtimeError) {
      runtimeShadow = {
        ok: false,
        error_code: runtimeError instanceof RuntimeRpcError
          ? runtimeError.code
          : 'RUNTIME_SHADOW_UNEXPECTED',
      }
    }
  }

  return {
    status: 200,
    body: { ok: true, duplicate, idempotency_key: idempotencyKey, runtime_shadow: runtimeShadow },
  }
}

// ── POST /v1/crm/amocrm/webhook/:secret ─────────────────────────────────────────────────────────

interface AmoIntegrationResolution {
  account_id: string
  integration_id: string
  account_domain: string
}

/**
 * Native amoCRM webhook receiver.
 *
 * Regular amoCRM CRM webhooks are form-urlencoded and do not carry a documented provider
 * signature. The destination therefore contains a per-integration high-entropy secret. Only its
 * SHA-256 digest is stored, and the body subdomain must match the same integration row. The raw,
 * bounded event enters Runtime first; contact/lead enrichment happens asynchronously after claim.
 */
export async function handleNativeAmoWebhook(
  deps: GatewayDeps,
  routeSecret: string | null | undefined,
  body: unknown,
): Promise<GatewayResponse> {
  const secret = String(routeSecret ?? '')
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(secret)) {
    return { status: 401, body: { error: 'invalid_amocrm_webhook' } }
  }
  if (typeof body !== 'string') {
    return { status: 415, body: { error: 'expected_form_urlencoded' } }
  }

  let parsed
  try {
    parsed = parseNativeAmoWebhook(body)
  } catch (error) {
    return {
      status: 400,
      body: {
        error: 'invalid_amocrm_webhook',
        reason: error instanceof AmoWebhookParseError ? error.code : 'invalid_form',
      },
    }
  }

  const secretHash = createHash('sha256').update(secret, 'utf8').digest('hex')
  const { data, error } = await deps.admin.rpc('resolve_amocrm_webhook', {
    p_secret_hash: secretHash,
    p_account_domain: parsed.accountSubdomain,
  })
  if (error) return { status: 503, body: { error: 'amocrm_identity_unavailable' } }

  const matches = Array.isArray(data) ? data as AmoIntegrationResolution[] : []
  if (matches.length !== 1 || !matches[0]?.account_id) {
    // Deliberately identical for an unknown secret and a mismatched subdomain: the endpoint must not
    // become an oracle that reveals which customer domains are connected.
    return { status: 401, body: { error: 'invalid_amocrm_webhook' } }
  }

  try {
    const results = await ingestNativeAmoWebhook(
      createRuntimeClient(deps.admin),
      matches[0].account_id,
      parsed,
    )
    return {
      status: 200,
      body: {
        ok: true,
        accepted: results.length,
        created: results.filter((result) => result.status === 'created').length,
        duplicate: results.filter((result) => result.status === 'duplicate').length,
        mode: 'shadow',
        enrichment: 'queued',
      },
    }
  } catch (runtimeError) {
    // A transient Runtime failure must produce a retryable status. Successfully ingested siblings
    // are harmless on replay because Inbox identity is enforced by PostgreSQL.
    return {
      status: 503,
      body: {
        error: 'amocrm_runtime_ingest_failed',
        error_code: runtimeError instanceof RuntimeRpcError
          ? runtimeError.code
          : 'RUNTIME_SHADOW_UNEXPECTED',
      },
    }
  }
}

// ── GET /health ───────────────────────────────────────────────────────────────────────────────────

/**
 * Проверка живости для балансировщика и docker-compose.
 *
 * РАЗНЫЕ зависимости значат разное, и одинаковый ответ на них был бы враньём:
 *
 *   Postgres недоступен → 503. Без него шлюз не может ни поставить задачу, ни отдать её состояние:
 *     он бесполезен, и балансировщик обязан перестать слать на него трафик.
 *   Dragonfly недоступен → 200 с пометкой degraded. Шлюз при этом полностью работоспособен, просто
 *     воркер узнаёт о задаче опросом, а не сигналом. Возвращать 503 значило бы уронить рабочий сервис
 *     из-за потери ускорения — и, в docker-compose с restart-политикой, зациклить перезапуск.
 */
export async function handleHealth(deps: GatewayDeps): Promise<GatewayResponse> {
  const startedAt = deps.now?.() ?? Date.now()
  let databaseOk = false
  let databaseError: string | null = null
  try {
    // Самый дешёвый запрос, который всё же доходит до базы: одна строка по индексу.
    const selected = deps.admin.from('nemo_api_tokens').select('id') as { limit?: (n: number) => Promise<{ error: unknown }> }
    const result = await selected.limit?.(1)
    databaseOk = !result?.error
    if (result?.error) databaseError = String((result.error as { message?: string }).message ?? 'ошибка запроса')
  } catch (error) {
    databaseError = error instanceof Error ? error.message : String(error)
  }

  const queue = await deps.queue.health()

  return {
    status: databaseOk ? 200 : 503,
    body: {
      ok: databaseOk,
      // degraded означает «работаю, но хуже» и отличается от «не работаю». Смешивать их нельзя:
      // по первому не нужно ничего перезапускать, по второму нужно.
      degraded: databaseOk && queue.configured && !queue.reachable,
      checkedInMs: (deps.now?.() ?? Date.now()) - startedAt,
      database: { ok: databaseOk, error: databaseError },
      queue,
    },
  }
}

// ── Fastify ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Сборка сервера.
 *
 * Обработчики выше НЕ ЗНАЮТ про Fastify и возвращают {status, body}. Это не абстракция ради
 * абстракции: так их проверяют без поднятия сокета, а маршрутизация проверяется отдельно и целиком.
 * Смешать одно с другим значило бы получить набор тестов, который поднимает сервер ради проверки
 * границы прав.
 */
export async function buildGateway(deps: GatewayDeps, options: { logger?: boolean } = {}) {
  const { default: Fastify } = await import('fastify')
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_BODY_BYTES,
    // Заголовки прокси учитываем: без этого в журнале окажется адрес самого прокси, а не клиента.
    trustProxy: true,
  })

  // Fastify core intentionally does not parse HTML forms. Keep the raw string so our bounded parser
  // can reject duplicate/ambiguous PHP-style bracket paths instead of silently choosing one value.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  )

  const send = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, response: GatewayResponse) =>
    reply.code(response.status).send(response.body)

  app.post('/v1/sdr/jobs', async (request, reply) =>
    send(reply, await handleCreateJob(deps, request.headers.authorization, request.body)))

  app.get('/v1/sdr/jobs/:id', async (request, reply) =>
    send(reply, await handleGetJob(deps, request.headers.authorization, (request.params as { id: string }).id)))

  app.post('/v1/crm/webhook', async (request, reply) =>
    send(reply, await handleCrmWebhook(deps, request.headers['x-nemo-crm-secret'] as string | undefined, request.body)))

  app.post('/v1/crm/amocrm/webhook/:secret', { logLevel: 'silent' }, async (request, reply) =>
    send(reply, await handleNativeAmoWebhook(
      deps,
      (request.params as { secret: string }).secret,
      request.body,
    )))

  app.get('/health', async (request, reply) => send(reply, await handleHealth(deps)))

  // Неизвестный путь — 404 с именем, а не пустой ответ Fastify: клиент, перепутавший версию пути,
  // должен это увидеть.
  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({ error: 'not_found', path: request.url }))

  return app
}
