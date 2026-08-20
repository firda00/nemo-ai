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
import { syncHotLeadsToCrm } from './crm-sync.ts'
import { createBrowserBridge } from './tools/enrich-browser.ts'
import { connectConsumer, BLOCK_SECONDS } from './server/queue.ts'

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

/*
 * АДРЕС БЕРЁТСЯ ЦЕЛИКОМ, ЕСЛИ ОН ЗАДАН, И ТОЛЬКО ПОТОМ СТРОИТСЯ ИЗ REF.
 *
 * Здесь стояло `https://${ref}.supabase.co` без вариантов — то есть воркер умел работать ТОЛЬКО с
 * облаком. В контуре на своём сервере (docker-compose.prod.yml) Supabase живёт за собственным Kong,
 * и такой воркер поднялся бы, отчитался о готовности и продолжил разбирать очередь ОБЛАКА, пока
 * всё остальное работает локально. Две базы, один воркер, задвоенная рассылка — и ни одной ошибки
 * в журнале.
 *
 * Порядок тот же, что в agent-hub/server/env.ts и agent-hub/media/main.ts: приём в репозитории уже
 * есть, и заводить рядом второй было бы хуже, чем повторить существующий.
 */
const serviceKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
const ref = process.env.SUPABASE_PROJECT_REF
const url = process.env.SUPABASE_URL ?? (ref ? `https://${ref}.supabase.co` : '')
if (!url || !serviceKey) {
  console.error('[worker] нужны SUPABASE_URL (или SUPABASE_PROJECT_REF) и SUPABASE_SECRET_KEY (подхватываются из .secrets.local)')
  process.exit(1)
}
const admin = createClient(url, serviceKey)

/** Лиды задачи пишутся здесь, а не общим store из notifier.ts: нужна привязка job_id. */
async function saveLeads(job, leads) {
  // Пустая карта, а не отсутствующее поле: вызывающий не должен помнить, что при нуле лидов
  // idByKey не бывает.
  if (!leads.length) return { added: 0, idByKey: new Map() }
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
  // .select() ради id: внешней CRM нужна ссылка НА СТРОКУ, а не только устойчивый ключ, иначе
  // связать её запись с нашей потом нечем.
  const { data, error } = await admin.from('sdr_leads')
    .upsert(rows, { onConflict: 'dedupe_key' })
    .select('id, dedupe_key')
  if (error) throw new Error(`sdr_leads upsert: ${error.message}`)
  const idByKey = new Map((data ?? []).map((row) => [row.dedupe_key, row.id]))
  return { added: rows.length, idByKey }
}

/**
 * Отправка горячих лидов во внешнюю CRM — ПОСЛЕ записи, рядом с алертами Telegram.
 *
 * Ни один отказ приёмника не должен помешать зафиксировать задачу: незафиксированная задача будет
 * взята повторно и спишет кредиты второй раз, а недоставленный лид лежит в базе с пустым
 * crm_synced_at и уедет следующим прогоном.
 */
async function syncToCrm(leads, idByKey) {
  try {
    const outcome = await syncHotLeadsToCrm(leads, { idByKey })
    if (outcome.syncedKeys.length) {
      const { error } = await admin.from('sdr_leads')
        .update({ crm_synced_at: new Date().toISOString() })
        .in('dedupe_key', outcome.syncedKeys)
      // Отметка не поставилась — лид уедет в CRM ещё раз следующим прогоном. Idempotency-Key в
      // запросе для этого и нужен: приёмник, который его понимает, дубля не создаст.
      if (error) outcome.errors.push(`отметка crm_synced_at: ${error.message}`)
    }
    return outcome
  } catch (error) {
    return { sent: 0, failed: 0, skipped: null, syncedKeys: [], errors: [String(error?.message ?? error)] }
  }
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

  // Браузер — ОДИН на задачу и закрывается в finally ниже. Воркер живёт часами и берёт задачу за
  // задачей: браузер, оставленный открытым хотя бы в одной ветке, к вечеру превратится в десяток
  // процессов Chromium, и машина уйдёт в свап на ровном месте.
  const browser = createBrowserBridge()
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
        enrich: new WebEnricher(process.env, fetch, browser.fallback),
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
    // Алерты и CRM — одним блоком и оба ПОСЛЕ записи: и уведомление, и запись в CRM ссылаются на
    // лид, которого до saveLeads в базе нет.
    const alerted = await alertHotLeads(result.leads)
    const crm = await syncToCrm(result.leads, saved.idByKey)
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
      crm_sent: crm.sent,
      crm_failed: crm.failed,
      crm_skipped: crm.skipped,
      crm_errors: crm.errors.slice(0, 10),
      // Сколько раз понадобился браузер — цена задачи в секундах и памяти. Без этой цифры непонятно,
      // почему одна задача считалась десять секунд, а вторая — минуту.
      browser: browser.stats(),
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
    if (crm.skipped) console.log(`[worker] CRM: ${crm.skipped}`)
    else console.log(`[worker] CRM: отправлено ${crm.sent}${crm.failed ? `, отказов ${crm.failed}` : ''}`)
    for (const one of crm.errors) console.warn(`[worker] CRM не приняла — ${one}`)
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
    // Браузер закрывается ПОСЛЕ фиксации задачи и в обеих ветках. Порядок именно такой: сначала
    // задача перестаёт считаться выполняемой, потом освобождаются ресурсы — если закрытие браузера
    // само упадёт, задача уже зафиксирована и второй раз кредиты не спишет.
    await browser.close()
  }
}

const loop = process.argv.includes('--loop')
if (!loop) {
  const id = await runOne()
  console.log(id ? `[worker] проход завершён: ${id}` : '[worker] очередь пуста')
  process.exit(0)
}

// ОТДЕЛЬНОЕ соединение под ожидание: BLPOP блокирует весь клиент, и публиковать что-либо по нему
// одновременно нельзя. Воркер только слушает, поэтому одного соединения ему достаточно.
const queue = await connectConsumer()
console.log(`[worker] непрерывный режим; Ctrl+C для остановки; очередь: ${
  queue.enabled ? `Dragonfly, ожидание до ${BLOCK_SECONDS} с` : `опрос раз в ${IDLE_PAUSE_MS / 1000} с`}`)

let stop = false
process.on('SIGINT', () => { console.log('\n[worker] останавливаюсь после текущей задачи'); stop = true })
while (!stop) {
  let handled = null
  try {
    handled = await runOne()
  } catch (error) {
    console.error(`[worker] ошибка обхода очереди: ${String(error?.message ?? error)}`)
  }
  // Делать нечего — ЖДЁМ СИГНАЛА, а не спим вслепую.
  //
  // Раньше здесь стояла глухая пауза на пятнадцать секунд: воркер спрашивал claim_sdr_job снова и
  // снова, всегда, даже при пустой очереди. Четыре воркера — шестнадцать запросов в минуту
  // круглосуточно и ни одной полезной строки в ответ. Теперь воркер висит на Dragonfly и просыпается
  // в момент постановки задачи.
  //
  // Сигнал НЕ обязателен и его содержимое НЕ используется: пришёл — идём в базу за задачей, не
  // пришёл за отведённое время — идём всё равно. Брать задачу по идентификатору из сигнала было бы
  // ошибкой: право на неё выдаёт claim_sdr_job с арендой, и в обход него два воркера получили бы одну
  // задачу. Dragonfly здесь будильник, а не источник правды.
  if (!handled) {
    if (queue.enabled) await queue.waitForJob(BLOCK_SECONDS)
    else await new Promise((resolve) => setTimeout(resolve, IDLE_PAUSE_MS))
  }
}
// Соединение с Dragonfly закрывается до выхода: незакрытый сокет держит процесс живым, и воркер,
// остановленный по Ctrl+C, не завершается — выглядит это как зависание при остановке.
await queue.close()
process.exit(0)
