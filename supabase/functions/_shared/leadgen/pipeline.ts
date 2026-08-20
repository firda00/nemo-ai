// Пайплайн целиком: поиск → очистка → дедупликация → обогащение → оценка → сохранение → уведомление.
//
// Ни один сбой одной компании не должен останавливать весь прогон — иначе неудачное обогащение
// ОДНОЙ компании роняет список, найденный до неё. Каждый шаг для каждой компании обёрнут отдельно;
// его отказ уходит в failures (contracts.ts:PipelineResult), а не наружу исключением.

import { dropDuplicates, sanitizePlace } from './sanitizer.ts'
import type { Enricher, LeadStore, Notifier, PipelineResult, PlacesSearch, Scorer } from './contracts.ts'
import { Enrichment, LeadSearchRequest, type Lead } from './schemas.ts'

/**
 * Этапы прогона для показа снаружи.
 *
 * Обогащение и оценка — ОДИН этап, а не два: в цикле ниже они идут для каждой компании подряд, и
 * рисовать их как последовательные блоки значило бы врать о том, что происходит. Отдельный этап
 * «оценка» показывал бы 0% всё время, пока первая половина списка уже оценена.
 */
export type PipelinePhase = 'search' | 'clean' | 'enrich_score' | 'store' | 'notify'

export interface PhaseEvent {
  phase: PipelinePhase
  /** Номер этапа и сколько их всего — чтобы снаружи не пересчитывать. */
  step: number
  total: number
  message: string
  /** Прогресс внутри этапа, когда он есть: обогащение идёт по одной компании. */
  done?: number
  of?: number
}

export interface PipelineDeps {
  search: PlacesSearch
  enrich: Enricher
  /** null — оценка пропускается для всех лидов (например, нет ключа OpenRouter), а не весь пайплайн. */
  score: Scorer | null
  store: LeadStore | null
  notify: Notifier | null
  log?: (message: string) => void
  /**
   * Структурные события этапов — для спиннера и любого другого показа.
   *
   * Отдельно от log() намеренно: разбирать русские строки журнала регулярками, чтобы понять, где
   * мы находимся, — это связь, которая рвётся от любой правки формулировки, причём молча.
   */
  onPhase?: (event: PhaseEvent) => void
}

const TOTAL_PHASES = 3

const EMPTY_ENRICHMENT: Enrichment = {
  description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null, whatsapp: null },
  people: [], failed: ['enrich_threw'],
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error)
}

export async function runSdrPipeline(
  request: { query: string; city: string; limit?: number; icp?: string },
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const log = deps.log ?? (() => {})
  const phase = deps.onPhase ?? (() => {})
  const parsedRequest = LeadSearchRequest.parse({
    query: request.query,
    city: request.city,
    limit: request.limit ?? 50,
    icp: request.icp,
  })
  const icp = parsedRequest.icp ?? ''
  const failures: PipelineResult['failures'] = []

  log(`поиск: "${parsedRequest.query}" в ${parsedRequest.city}, лимит ${parsedRequest.limit}`)
  phase({ phase: 'search', step: 1, total: TOTAL_PHASES, message: `Поиск геоданных: ${parsedRequest.query} в ${parsedRequest.city}` })
  let places: Awaited<ReturnType<PlacesSearch['search']>>['places'] = []
  try {
    const result = await deps.search.search(parsedRequest)
    places = result.places
    log(`найдено сырых записей: ${places.length} (страниц: ${result.stats.pages}, выдача исчерпана: ${result.stats.exhausted})`)
  } catch (error) {
    failures.push({ stage: 'search', detail: errorMessage(error) })
  }

  phase({ phase: 'clean', step: 2, total: TOTAL_PHASES, message: `Очистка и дедупликация: ${places.length} записей` })
  const rejected: PipelineResult['rejected'] = []
  const companies = []
  for (const raw of places) {
    const outcome = sanitizePlace(raw, parsedRequest.city)
    if (outcome.ok) companies.push(outcome.company)
    else rejected.push({ place_id: outcome.place_id, reason: outcome.reason })
  }
  log(`прошли очистку: ${companies.length}, отброшено: ${rejected.length}`)

  const { unique, duplicates } = dropDuplicates(companies)
  log(`уникальных после дедупликации: ${unique.length} (дублей: ${duplicates})`)

  const leads: Lead[] = []
  for (const company of unique) {
    // Прогресс объявляется ПЕРЕД работой над компанией: строка «12 из 39» должна означать «беру
    // двенадцатую», а не «уже сделал двенадцать», иначе последняя компания никогда не показывается.
    phase({
      phase: 'enrich_score',
      step: 3,
      total: TOTAL_PHASES,
      message: `Обогащение и оценка: ${company.name}`,
      done: leads.length + 1,
      of: unique.length,
    })
    let enrichment = EMPTY_ENRICHMENT
    try {
      enrichment = await deps.enrich.enrich(company)
    } catch (error) {
      failures.push({ stage: 'enrich', detail: `${company.name}: ${errorMessage(error)}` })
    }

    let score: Lead['score'] = null
    if (deps.score) {
      try {
        score = await deps.score.score(company, enrichment, icp)
        if (!score) failures.push({ stage: 'score', detail: `${company.name}: не удалось получить оценку` })
      } catch (error) {
        failures.push({ stage: 'score', detail: `${company.name}: ${errorMessage(error)}` })
      }
    }

    leads.push({ ...company, enrichment, score, found_at: new Date().toISOString() })
  }

  const hot = leads.filter((lead) => lead.score?.status === 'HOT')
  const qualified = leads.filter((lead) => lead.score?.status === 'QUALIFIED')
  log(`оценено: ${leads.filter((lead) => lead.score).length} из ${leads.length}, горячих: ${hot.length}, тёплых: ${qualified.length}`)

  if (deps.store) {
    try {
      const stored = await deps.store.save(leads)
      log(`сохранено: добавлено ${stored.added}, уже было ${stored.skipped}`)
    } catch (error) {
      failures.push({ stage: 'store', detail: errorMessage(error) })
    }
  }

  // ТОЛЬКО горячие. Уведомление о каждом найденном лиде превращается в поток, который выключают
  // на второй день, — и вместе с ним выключают те несколько сообщений в неделю, ради которых всё
  // делалось.
  if (deps.notify) {
    for (const lead of hot) {
      try {
        const sent = await deps.notify.alertHot(lead)
        if (!sent.ok) failures.push({ stage: 'notify', detail: `${lead.name}: ${sent.error ?? 'unknown'}` })
      } catch (error) {
        failures.push({ stage: 'notify', detail: `${lead.name}: ${errorMessage(error)}` })
      }
    }
  }

  return {
    found: places.length,
    qualified: qualified.length,
    hot: hot.length,
    leads,
    rejected,
    duplicates,
    failures,
  }
}
