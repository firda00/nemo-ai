import { z } from 'zod'

export const EdgeTaskRequirementsSchema = z.object({
  task_type: z.enum(['license_plate', 'categorization', 'ocr', 'summarization', 'complex_reasoning']),
  complexity_score: z.number().min(0).max(1),
  data_policy: z.enum(['local_only', 'prefer_local', 'cloud_allowed']).default('prefer_local'),
}).strict()

export type EdgeTaskRequirements = z.infer<typeof EdgeTaskRequirementsSchema>

export interface ModelRoute {
  provider: 'ollama_local' | 'nemo_cloud'
  model: string
  base_url: string
  timeout_ms: number
  reason: 'LOCAL_PRIORITY' | 'LOCAL_ONLY' | 'LOCAL_UNAVAILABLE' | 'COMPLEX_REASONING'
}

export interface ModelRouterOptions {
  ollamaBaseUrl?: string
  cloudBaseUrl?: string
  localModel?: string
  cloudModel?: string
  complexityThreshold?: number
  healthTimeoutMs?: number
  fetchImpl?: typeof fetch
}

const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'ollama-local', 'host.docker.internal'])

function localOllamaUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !ALLOWED_LOCAL_HOSTS.has(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error('OLLAMA_LOCAL_URL_INVALID')
  return url
}

function cloudUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('EDGE_CLOUD_MODEL_URL_INVALID')
  }
  return url
}

const OllamaTagsSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1) }).passthrough()).max(1_000),
}).passthrough()

function sameOllamaModel(available: string, requested: string): boolean {
  if (available === requested) return true
  const normalizeLatest = (value: string) => value.endsWith(':latest') ? value.slice(0, -7) : value
  return normalizeLatest(available) === normalizeLatest(requested)
}

async function ollamaHealthy(
  baseUrl: URL,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  requiredModel: string,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const endpoint = new URL('/api/tags', baseUrl)
    const response = await fetchImpl(endpoint, { method: 'GET', redirect: 'error', signal: controller.signal })
    if (!response.ok) return false
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > 1024 * 1024) return false
    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) return false
    const tags = OllamaTagsSchema.safeParse(JSON.parse(body))
    return tags.success && tags.data.models.some((model) => sameOllamaModel(model.name, requiredModel))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveModelProvider(
  rawRequirements: EdgeTaskRequirements,
  options: ModelRouterOptions = {},
): Promise<ModelRoute> {
  const requirements = EdgeTaskRequirementsSchema.parse(rawRequirements)
  const threshold = options.complexityThreshold ?? 0.7
  const healthTimeoutMs = Math.min(3_000, Math.max(100, options.healthTimeoutMs ?? 1_500))
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) throw new Error('EDGE_MODEL_THRESHOLD_INVALID')
  const local = localOllamaUrl(options.ollamaBaseUrl ?? 'http://ollama-local:11434')
  const cloud = cloudUrl(options.cloudBaseUrl ?? 'https://gateway.nemo-ai.uz/v1/models')
  const localModel = options.localModel ?? 'qwen2.5:7b-instruct'
  const cloudModel = options.cloudModel ?? 'anthropic/claude-sonnet-4'

  if (requirements.complexity_score >= threshold && requirements.data_policy === 'cloud_allowed') {
    return {
      provider: 'nemo_cloud', model: cloudModel, base_url: cloud.toString(), timeout_ms: 30_000,
      reason: 'COMPLEX_REASONING',
    }
  }

  const healthy = await ollamaHealthy(local, healthTimeoutMs, options.fetchImpl ?? fetch, localModel)
  if (healthy) {
    return {
      provider: 'ollama_local', model: localModel, base_url: local.toString(), timeout_ms: 10_000,
      reason: requirements.data_policy === 'local_only' ? 'LOCAL_ONLY' : 'LOCAL_PRIORITY',
    }
  }
  if (requirements.data_policy === 'local_only') throw new Error('LOCAL_MODEL_UNAVAILABLE')
  if (requirements.data_policy !== 'cloud_allowed') throw new Error('CLOUD_FALLBACK_NOT_ALLOWED')
  return {
    provider: 'nemo_cloud', model: cloudModel, base_url: cloud.toString(), timeout_ms: 30_000,
    reason: 'LOCAL_UNAVAILABLE',
  }
}

export const edgeModelRoutingLimits = Object.freeze({
  maximumHealthTimeoutMs: 3_000,
  defaultComplexityThreshold: 0.7,
})
