// Пайплайн целиком: поиск → очистка → дедупликация → обогащение → оценка → сохранение → уведомление.
//
// Ни один сбой одной компании не должен останавливать весь прогон — иначе неудачное обогащение
// ОДНОЙ компании роняет список, найденный до неё. Каждый шаг для каждой компании обёрнут отдельно;
// его отказ уходит в failures (contracts.ts:PipelineResult), а не наружу исключением.

import { dropDuplicates, sanitizePlace } from './sanitizer.ts'
import type { Enricher, LeadStore, Notifier, PipelineResult, PlacesSearch, Scorer } from './contracts.ts'
import { Enrichment, LeadSearchRequest, type Lead } from './schemas.ts'

export interface PipelineDeps {
  search: PlacesSearch
  enrich: Enricher
  /** null — оценка пропускается для всех лидов (например, нет ключа OpenRouter), а не весь пайплайн. */
  score: Scorer | null
  store: LeadStore | null
  notify: Notifier | null
  log?: (message: string) => void
}

const EMPTY_ENRICHMENT: Enrichment = {
  description: null, emails: [], socials: { linkedin: null, instagram: null, telegram: null, facebook: null },
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
  const parsedRequest = LeadSearchRequest.parse({
    query: request.query,
    city: request.city,
    limit: request.limit ?? 50,
    icp: request.icp,
  })
  const icp = parsedRequest.icp ?? ''
  const failures: PipelineResult['failures'] = []

  log(`поиск: "${parsedRequest.query}" в ${parsedRequest.city}, лимит ${parsedRequest.limit}`)
  let places: Awaited<ReturnType<PlacesSearch['search']>>['places'] = []
  try {
    const result = await deps.search.search(parsedRequest)
    places = result.places
    log(`найдено сырых записей: ${places.length} (страниц: ${result.stats.pages}, выдача исчерпана: ${result.stats.exhausted})`)
  } catch (error) {
    failures.push({ stage: 'search', detail: errorMessage(error) })
  }

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
