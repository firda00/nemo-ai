// Daily-briefing delivery worker — Step 2b, extended with the monthly-reminder kinds. PUBLIC
// function (pg_cron cannot send a Supabase JWT), so authorization is entirely ours and fails
// CLOSED: no configured CRON_SECRET means every request is refused, and the comparison is
// constant-time. Kill-switch envs are PER MODULE: DAILY_BRIEFING_DELIVERY gates the briefing
// kinds, REMINDER_DELIVERY (default OFF — sends require an explicit 'on') gates the reminder
// drain. All behavior lives in the offline-tested _shared modules; this wrapper only wires
// real dependencies.
//   POST /functions/v1/daily-briefing-worker  (header: x-cron-secret)
//     { kind: 'morning'|'evening'|'drain'|'reminder-plan'|'reminder-drain' }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { timingSafeEqual } from '../_shared/safeEqual.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'
import { openSecret, accountSecretContext } from '../_shared/secretBox.ts'
import { createTelegramSender, runDeliveryTick } from '../_shared/dailyBriefingDelivery.ts'
import { readRequestBodyBounded } from '../_shared/dailyBriefingHandler.ts'
import { fetchOwnerCalendarSection } from '../_shared/dailyBriefingGoogle.ts'
import { type FetchLike } from '../_shared/dailyBriefingSources.ts'
import { runReminderWorkerKind } from '../_shared/reminderWorker.ts'
import { readBytesBounded } from '../_shared/boundedBody.ts'
import { MAX_MARGIN_UPLOAD_BYTES } from '../_shared/marginReportHandler.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const OPENWEATHER_KEY = Deno.env.get('OPENWEATHER_API_KEY') ?? ''
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const DELIVERY_SWITCH = Deno.env.get('DAILY_BRIEFING_DELIVERY') ?? ''
const REMINDER_SWITCH = Deno.env.get('REMINDER_DELIVERY') ?? ''

const fetchImpl: FetchLike = (url, init) => fetch(url, init)

const tashkentToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  // fail closed: no secret configured → nobody is authorized, constant-time when it is
  const provided = req.headers.get('x-cron-secret') ?? ''
  if (!CRON_SECRET || !timingSafeEqual(provided, CRON_SECRET)) return new Response('forbidden', { status: 403 })
  if (!SUPABASE_URL || !SERVICE_ROLE) return json({ ok: false, error: 'not_configured' }, 500)

  // strict input: POST only, small bounded body, EXPLICIT kind from the allowlist — a malformed
  // request must never default into a mutating drain
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  const bodyRead = await readRequestBodyBounded(req, { maxBytes: 2_048, timeoutMs: 10_000 })
  if (!bodyRead.ok) {
    return bodyRead.reason === 'too_large'
      ? json({ ok: false, error: 'body_too_large' }, 413)
      : json({ ok: false, error: 'timeout' }, 408)
  }
  const KINDS = ['morning', 'evening', 'drain', 'reminder-plan', 'reminder-drain'] as const
  let kind: (typeof KINDS)[number]
  try {
    const parsed = JSON.parse(bodyRead.text || '{}') as { kind?: unknown }
    const match = KINDS.find((candidate) => candidate === parsed?.kind)
    if (!match) return json({ ok: false, error: 'unknown_kind' }, 400)
    kind = match
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400)
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)

  if (kind === 'reminder-plan' || kind === 'reminder-drain') {
    // offline-tested glue: bounded planning, external-action guard before any dispatch,
    // tenant-scoped telegram-typed token read, default-OFF kill switch on sends
    const result = await runReminderWorkerKind({
      admin,
      send: async (token, chatId, text) => {
        const outcome = await createTelegramSender(fetchImpl)(token, chatId, text)
        if (outcome.status === 'sent') return { ok: true, messageId: outcome.messageId }
        return { ok: false, kind: outcome.status === 'rejected' ? 'rejected' : 'ambiguous' }
      },
      blocksExternal: (accountId) => blocksExternalActions(admin, accountId),
      killSwitch: REMINDER_SWITCH,
      fetchImpl,
      // streamed read of the retained monthly source: tenant path built HERE, capped while it
      // arrives, aborted with the request — never a whole-object buffer on trust
      getSourceFile: async (accountId, fileSha256) => {
        const controller = new AbortController()
        const deadlineAt = Date.now() + 60_000
        const timer = setTimeout(() => controller.abort(), 60_000)
        try {
          const objectPath = `tenants/${accountId}/margin-uploads/${fileSha256}.xlsx`
          const response = await fetch(`${SUPABASE_URL}/storage/v1/object/margin-files/${objectPath}`, {
            headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
            signal: controller.signal,
            redirect: 'error',
          })
          if (!response.ok) { void response.body?.cancel().catch(() => {}); return { error: `storage_${response.status}` } }
          const read = await readBytesBounded(
            { headers: response.headers, body: response.body },
            { maxBytes: MAX_MARGIN_UPLOAD_BYTES, deadlineAt },
          )
          if (!read.ok) { controller.abort(); return { error: read.reason } }
          return { bytes: read.bytes }
        } catch {
          return { error: 'read_failed' }
        } finally {
          clearTimeout(timer)
        }
      },
    }, kind, { todayTashkent: tashkentToday() })
    return json(result.body, result.status)
  }

  // kill-switch for the BRIEFING kinds only: delivery off without a deploy
  if (DELIVERY_SWITCH.toLowerCase() === 'off') return json({ ok: true, disabled: true })
  const summaries = await runDeliveryTick({
    admin,
    fetchImpl,
    openWeatherKey: OPENWEATHER_KEY,
    calendarSection: (accountId, date) => fetchOwnerCalendarSection({
      db: admin,
      fetchImpl,
      decrypt: (sealed, forAccount, purpose) => openSecret(sealed, accountSecretContext(forAccount, purpose)),
      envApp: { id: GOOGLE_CLIENT_ID, secret: GOOGLE_CLIENT_SECRET },
    }, { accountId, date }),
    sendMessage: createTelegramSender(fetchImpl),
    blocksExternal: (accountId) => blocksExternalActions(admin, accountId),
    budgetMs: 100_000,
  }, { kind })
  return json({ ok: true, kind, summaries })
})
