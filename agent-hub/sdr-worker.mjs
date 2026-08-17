// Воркер очереди SDR: берёт задачу в аренду, прогоняет пайплайн, отчитывается.
//
//   npm run sdr:worker            — один проход (для cron/systemd timer)
//   npm run sdr:worker -- --loop  — непрерывно, с паузой между пустыми проходами
//
// ПОЧЕМУ NODE, А НЕ EDGE FUNCTION. Пайплайн импортирует zod и @supabase/supabase-js обычными
// npm-именами и node:fs — под Deno это не соберётся без переписывания импортов, а переписывание
// сломало бы запуск под Node, где пайплайн уже работает и проверен. Разделение честное: шлюз
// (sdr-api) в Deno только ставит задачи и отдаёт результат, тяжёлую работу делает этот процесс там,
// где его код исполняется без переделок. Второй причиной остаётся время: Edge Function не живёт
// столько, сколько идут N загрузок сайтов и N вызовов модели.
//
// АРЕНДА, А НЕ «ВЗЯЛ И РАБОТАЮ». Воркер, убитый на середине, обязан вернуть задачу в очередь сам —
// без этого одна упавшая задача заблокировала бы очередь навсегда. Срок аренды продлевается
// сердцебиением, пока работа идёт.

import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { loadLocalEnv } from './load-local-env.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
loadLocalEnv(repoRoot)

const { runSdrPipeline } = await import('../supabase/functions/_shared/leadgen/pipeline.ts')
const { resolvePlacesSearch } = await import('../supabase/functions/_shared/leadgen/placesSearch.ts')
const { WebEnricher } = await import('../supabase/functions/_shared/leadgen/enricher.ts')
const { resolveScorer } = await import('../supabase/functions/_shared/leadgen/scorer.ts')
const { resolveNotifier } = await import('../supabase/functions/_shared/leadgen/notifier.ts')

const LEASE_SECONDS = 900
const HEARTBEAT_MS = 240_000
const IDLE_PAUSE_MS = 15_000

const ref = process.env.SUPABASE_PROJECT_REF
const serviceKey = process.env.SUPABASE_SECRET_KEY
if (!ref || !serviceKey) {
  console.error('[worker] нужны SUPABASE_PROJECT_REF и SUPABASE_SECRET_KEY (подхватываются из .secrets.local)')
  process.exit(1)
}
const admin = createClient(`https://${ref}.supabase.co`, serviceKey)

/** Лиды задачи пишутся здесь, а не общим store из notifier.ts: нужна привязка job_id. */
async function saveLeads(job, leads) {
  if (!leads.length) return { added: 0 }
  const rows = leads.map((lead) => ({
    job_id: job.id,
    place_id: lead.place_id,
    dedupe_key: lead.dedupe_key,
    name: lead.name,
    normalized_name: lead.normalized_name,
    city: lead.city,
    address: lead.address,
    phone: lead.phone,
    website: lead.website,
    rating: lead.rating,
    reviews: lead.reviews,
    operational: lead.operational,
    enrichment: lead.enrichment,
    score: lead.score,
    found_at: lead.found_at,
  }))
  const { error } = await admin.from('sdr_leads').upsert(rows, { onConflict: 'dedupe_key' })
  if (error) throw new Error(`sdr_leads upsert: ${error.message}`)
  return { added: rows.length }
}

/**
 * Алерты по горячим лидам — ПОСЛЕ того, как они записаны.
 *
 * Ни одна неудача Telegram не должна помешать зафиксировать задачу: сообщение можно отправить
 * повторно, а потерянная фиксация означает, что воркер возьмёт ту же задачу снова и спишет кредиты
 * второй раз. Поэтому здесь всё завёрнуто, и наружу уходит только счёт отправленного и списком —
 * причины отказов, чтобы они попали в stats задачи.
 */
async function alertHotLeads(leads) {
  const notifier = resolveNotifier()
  if (!notifier) return { sent: 0, skipped: 'нет SDR_TELEGRAM_BOT_TOKEN/SDR_TELEGRAM_CHAT_ID', errors: [] }

  const hot = (leads ?? []).filter((lead) => lead.score?.status === 'HOT')
  let sent = 0
  const errors = []
  for (const lead of hot) {
    try {
      const outcome = await notifier.alertHot(lead)
      if (outcome.ok) sent += 1
      else errors.push(`${lead.name}: ${outcome.error ?? 'unknown'}`)
    } catch (error) {
      // alertHot по контракту не бросает, но полагаться на это в коде, который защищает фиксацию
      // задачи, нельзя: одна неожиданная ошибка тут стоила бы двойного списания кредитов.
      errors.push(`${lead.name}: ${String(error?.message ?? error)}`)
    }
  }
  return { sent, skipped: null, errors }
}

async function runOne() {
  const { data: claimed, error: claimError } = await admin.rpc('claim_sdr_job', { p_lease_seconds: LEASE_SECONDS })
  if (claimError) throw new Error(`claim_sdr_job: ${claimError.message}`)
  const job = Array.isArray(claimed) ? claimed[0] : claimed
  if (!job) return null

  console.log(`[worker] взял задачу ${job.id} (попытка ${job.attempts}): ${JSON.stringify(job.params)}`)

  // Сердцебиение живёт всё время прогона: без него долгая, но здоровая задача выглядела бы
  // брошенной, и её отобрал бы второй воркер — та же работа дважды за те же деньги.
  const heartbeat = setInterval(() => {
    admin.rpc('heartbeat_sdr_job', {
      p_job_id: job.id, p_claim_token: job.claim_token, p_lease_seconds: LEASE_SECONDS,
    }).then(({ error }) => { if (error) console.warn(`[worker] сердцебиение не прошло: ${error.message}`) })
  }, HEARTBEAT_MS)

  try {
    const search = resolvePlacesSearch()
    const result = await runSdrPipeline(
      {
        query: job.params.query,
        city: job.params.city,
        limit: job.params.limit,
        icp: job.params.icp ?? undefined,
      },
      {
        search,
        enrich: new WebEnricher(),
        score: resolveScorer(),
        // Запись делаем сами — с job_id, которого общий store не знает.
        store: null,
        // И уведомления тоже сами, ПОСЛЕ записи. Пайплайн шлёт их сразу после оценки, а запись у
        // нас идёт после его возврата: алерт ушёл бы раньше, чем лид попал в базу, и по ссылке из
        // Telegram владелец не нашёл бы ничего. В местном режиме CLI такого нет — там store внутри
        // пайплайна и стоит перед notify.
        notify: null,
        log: (message) => console.log(`[worker] ${message}`),
      },
    )

    const saved = await saveLeads(job, result.leads)
    const alerted = await alertHotLeads(result.leads)
    const stats = {
      found: result.found,
      qualified: result.qualified,
      hot: result.hot,
      leads_saved: saved.added,
      duplicates: result.duplicates,
      rejected: result.rejected.length,
      // Сколько алертов ушло и почему не ушли остальные — в те же stats. Молча пропавшее
      // уведомление о горячем лиде выглядит как «лида не было».
      alerts_sent: alerted.sent,
      alerts_skipped: alerted.skipped,
      alert_errors: alerted.errors.slice(0, 10),
      failures: result.failures.slice(0, 20),
    }

    // Полный отказ поиска — это провал задачи: возвращать кредиты за ноль лидов честнее, чем
    // отдать «completed» с пустым списком. Остальные сбои деградируют осмысленно.
    const searchFailed = result.failures.some((one) => one.stage === 'search')
    const { data: finished } = await admin.rpc('finish_sdr_job', {
      p_job_id: job.id,
      p_claim_token: job.claim_token,
      p_status: searchFailed ? 'failed' : 'completed',
      p_stats: stats,
      p_error: searchFailed ? result.failures.find((one) => one.stage === 'search')?.detail ?? 'search_failed' : null,
    })
    if (finished === false) console.warn(`[worker] аренда ${job.id} потеряна — результат не записан`)
    if (alerted.skipped) console.log(`[worker] Telegram: ${alerted.skipped}`)
    else console.log(`[worker] Telegram: отправлено ${alerted.sent} из ${result.hot}${alerted.errors.length ? `, отказов ${alerted.errors.length}` : ''}`)
    for (const one of alerted.errors) console.warn(`[worker] Telegram не доставил — ${one}`)
    console.log(`[worker] задача ${job.id}: ${searchFailed ? 'провал' : 'готово'}, лидов ${saved.added}, горячих ${result.hot}`)
    return job.id
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 500)
    // Есть ли ещё попытки — решает база (attempts < 3 в claim_sdr_job). Здесь задача возвращается
    // в очередь, и только исчерпав попытки, она станет 'failed' с возвратом кредитов.
    const giveUp = (job.attempts ?? 1) >= 3
    await admin.rpc('finish_sdr_job', {
      p_job_id: job.id,
      p_claim_token: job.claim_token,
      p_status: giveUp ? 'failed' : 'queued',
      p_stats: null,
      p_error: detail,
    })
    console.error(`[worker] задача ${job.id} упала (${giveUp ? 'попытки исчерпаны' : 'вернули в очередь'}): ${detail}`)
    return job.id
  } finally {
    clearInterval(heartbeat)
  }
}

const loop = process.argv.includes('--loop')
if (!loop) {
  const id = await runOne()
  console.log(id ? `[worker] проход завершён: ${id}` : '[worker] очередь пуста')
  process.exit(0)
}

console.log('[worker] непрерывный режим; Ctrl+C для остановки')
let stop = false
process.on('SIGINT', () => { console.log('\n[worker] останавливаюсь после текущей задачи'); stop = true })
while (!stop) {
  let handled = null
  try {
    handled = await runOne()
  } catch (error) {
    console.error(`[worker] ошибка обхода очереди: ${String(error?.message ?? error)}`)
  }
  // Пауза только когда делать нечего: очередь с задачами разбирается без задержек.
  if (!handled) await new Promise((resolve) => setTimeout(resolve, IDLE_PAUSE_MS))
}
process.exit(0)
