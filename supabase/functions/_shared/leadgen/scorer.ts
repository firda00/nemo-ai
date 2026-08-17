// LLM ICP-скоринг: сравнение компании с профилем идеального клиента.
//
// Статус НЕ спрашивается у модели и не берётся из её ответа — модель охотно ставит «HOT» рядом с
// оценкой 45, если формулировка ей понравилась (см. schemas.ts:statusFor). Свежий, а не общий
// _shared/llm.ts клиент: тот читает Deno.env.get(...) на уровне модуля и падает при импорте под
// Node, на котором целиком работает этот пайплайн.

import { z } from 'zod'
import { backoffDelays, type Scorer } from './contracts.ts'
import { LeadScore, statusFor, type CleanCompany, type Enrichment } from './schemas.ts'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini'

const SCORE_SYSTEM_PROMPT = `Ты оцениваешь, насколько компания подходит под профиль идеального клиента (ICP).

Верни ТОЛЬКО JSON без пояснений вокруг:
{"score": <0-100>, "reason": "<одно ёмкое предложение>", "key_decision_maker": "<имя руководителя или null>", "icebreaker_pitch": "<хук для холодного сообщения, до 400 символов, или null>"}

Правила:
1. score — насколько компания похожа на идеального клиента. Не завышай из вежливости: 0 для явно нерелевантной компании — нормальный, честный ответ.
2. reason — ОДНО предложение, почему именно такая оценка. Не пересказывай данные компании — объясни решение.
3. key_decision_maker — имя из переданных people, если оно похоже на человека, принимающего решения (директор, основатель, руководитель). Иначе null. Не выдумывай имя, которого нет в данных.
4. icebreaker_pitch — короткий персонализированный хук: одна конкретная деталь о компании плюс что мы предлагаем. Без «Здравствуйте, меня зовут…» — сразу к сути. Null, если данных недостаточно для персонализации.
5. Поля status в ответе быть не должно — статус решает не модель, а порог по числу.`

/** То, что обязана вернуть модель. Без status — его здесь нет и не будет, статус решается отдельно. */
const ModelScoreResponse = z.object({
  score: z.number().int().min(0).max(100),
  reason: z.string().min(1).max(300),
  key_decision_maker: z.string().max(160).nullable().optional(),
  icebreaker_pitch: z.string().max(400).nullable().optional(),
})

/** Модели заворачивают JSON в ```json``` или добавляют фразу вокруг — вырезаем внешний объект. */
export function stripJsonFence(content: string): string {
  const text = String(content ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/** Разметка и селекторы наружу не уходят — только то, что видит человек и по чему решает модель. */
export function buildScorerUserPrompt(company: CleanCompany, enrichment: Enrichment, icp: string): string {
  return JSON.stringify({
    icp,
    company: {
      name: company.name,
      city: company.city,
      website: company.website,
      rating: company.rating,
      reviews: company.reviews,
    },
    enrichment: {
      description: enrichment.description,
      people: enrichment.people,
      has_email: enrichment.emails.length > 0,
      socials: Object.entries(enrichment.socials).filter(([, value]) => value).map(([key]) => key),
    },
  })
}

interface TransientError extends Error { transient?: boolean }

async function callOpenRouterOnce(
  apiKey: string, model: string, messages: Array<{ role: string; content: string }>, fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 500, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const error: TransientError = new Error(`OpenRouter HTTP ${res.status}`)
    if (res.status === 429 || res.status >= 500) error.transient = true
    throw error
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data?.choices?.[0]?.message?.content ?? ''
}

export class LlmIcpScorer implements Scorer {
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(apiKey: string, model: string = DEFAULT_MODEL, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
  }

  async score(company: CleanCompany, enrichment: Enrichment, icp: string): Promise<LeadScore | null> {
    const messages = [
      { role: 'system', content: SCORE_SYSTEM_PROMPT },
      { role: 'user', content: buildScorerUserPrompt(company, enrichment, icp) },
    ]
    const delays = backoffDelays(3, 800)
    let content = ''
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        content = await callOpenRouterOnce(this.apiKey, this.model, messages, this.fetchImpl)
        break
      } catch (error) {
        const transient = Boolean((error as TransientError)?.transient)
        if (!transient || attempt === delays.length) return null
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      }
    }
    if (!content) return null

    let parsed: unknown
    try { parsed = JSON.parse(stripJsonFence(content)) } catch { return null }
    const modelResult = ModelScoreResponse.safeParse(parsed)
    if (!modelResult.success) return null

    // Статус — из числа, не из ответа модели: она его и не спрашивалась, но на случай, если
    // формат когда-нибудь изменится и поле просочится, здесь оно всё равно пересчитывается заново.
    const full = LeadScore.safeParse({
      score: modelResult.data.score,
      status: statusFor(modelResult.data.score),
      reason: modelResult.data.reason,
      key_decision_maker: modelResult.data.key_decision_maker ?? null,
      icebreaker_pitch: modelResult.data.icebreaker_pitch ?? null,
    })
    return full.success ? full.data : null
  }
}

/** Собирает Scorer по ключу в окружении — null, если ключа нет: пайплайн решит сам, что с этим делать. */
export function resolveScorer(env: NodeJS.ProcessEnv = process.env): LlmIcpScorer | null {
  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) return null
  return new LlmIcpScorer(apiKey, env.SDR_SCORER_MODEL ?? DEFAULT_MODEL)
}
