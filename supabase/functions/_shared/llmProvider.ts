// Provider-neutral chat adapter — the reviewed alternative to the OpenRouter-only path.
//
// Contract (Codex conditions):
//   • the tenant's OWN keys come from provider_keys (the rows connect-provider already stores,
//     sealed with providerSecretContext) — no second vault, no re-entering keys;
//   • the platform default (OpenRouter, env key) applies ONLY when the caller made no explicit
//     choice; a missing key for an EXPLICITLY selected provider is an actionable error, never a
//     silent switch to another provider or another payer;
//   • requests, tool calls, vision parts and usage are NORMALIZED: callers speak one
//     OpenAI-style dialect, adapters translate to each provider's native wire and back;
//   • capabilities are checked BEFORE any key is read or any request is sent — a provider that
//     cannot do what the request needs answers with a typed mismatch, not garbled output;
//   • no key and no provider config is ever logged; Gemini gets its key via a HEADER, never the
//     URL, so infra request logs cannot capture it;
//   • every network call is bounded by the caller's absolute deadline (plus a per-call cap) and
//     response bodies are read STREAMED under a byte cap;
//   • there is NO automatic paid fallback here: one selection, one call, a typed error out.
import { readBytesBounded } from './boundedBody.ts'
import { type CliMessage } from './cliChat.ts'

export type TenantChatProvider = 'openai' | 'anthropic' | 'gemini' | 'groq'
export type ChatProvider = TenantChatProvider | 'openrouter'
export const TENANT_CHAT_PROVIDERS: readonly TenantChatProvider[] = ['openai', 'anthropic', 'gemini', 'groq']

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const PER_CALL_TIMEOUT_MS = 45_000

export interface ChatCallSelection {
  provider: ChatProvider
  model: string
  key: string
}

export interface ChatCallRequest {
  messages: CliMessage[]
  maxTokens: number
  temperature?: number
  tools?: Array<Record<string, unknown>>
  /** OpenRouter-only routing passthrough (e.g. { sort: 'throughput' }); ignored elsewhere. */
  openrouterRouting?: Record<string, unknown>
}

export interface ChatCallOk {
  ok: true
  content: string | null
  toolCalls: Array<Record<string, unknown>>
  model: string
  /** Wire evidence; unlike model, never filled from the request default. */
  reportedModel?: string
  upstreamProvider?: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number | null }
}
export interface ChatCallFail {
  ok: false
  code: 'NO_CREDITS' | 'RATE_LIMITED' | 'KEY_REJECTED' | 'PROVIDER_ERROR' | 'PROVIDER_UNAVAILABLE' | 'INVALID_PROVIDER_RESPONSE'
}
export type ChatCallResult = ChatCallOk | ChatCallFail

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

// ── capabilities ─────────────────────────────────────────────────────────────────────────────────

interface ProviderCapabilities { tools: boolean; visionData: boolean; visionHttp: boolean; video: boolean }
const CAPABILITIES: Record<ChatProvider, ProviderCapabilities> = {
  openrouter: { tools: true, visionData: true, visionHttp: true, video: true },
  openai: { tools: true, visionData: true, visionHttp: true, video: false },
  anthropic: { tools: true, visionData: true, visionHttp: true, video: false },
  // Gemini REST accepts inline (base64) media; remote http URLs need the Files API we do not use.
  gemini: { tools: true, visionData: true, visionHttp: false, video: false },
  // Groq's OpenAI-compatible endpoint: text + tools; vision models are out of this adapter's scope.
  groq: { tools: true, visionData: false, visionHttp: false, video: false },
}

/** What the request actually needs — computed from the payload, not trusted from the caller. */
export function requestNeeds(request: { messages: CliMessage[]; tools?: Array<Record<string, unknown>> }) {
  let visionData = false; let visionHttp = false; let video = false
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === 'image_url') {
        if ((part.image_url?.url ?? '').startsWith('data:')) visionData = true
        else visionHttp = true
      }
      if (part.type === 'video_url') video = true
    }
  }
  return { tools: (request.tools?.length ?? 0) > 0, visionData, visionHttp, video }
}

/** null = fine; otherwise the first capability the provider lacks (actionable detail). */
export function capabilityGap(provider: ChatProvider, request: { messages: CliMessage[]; tools?: Array<Record<string, unknown>> }): string | null {
  const has = CAPABILITIES[provider]
  const needs = requestNeeds(request)
  if (needs.tools && !has.tools) return 'tools'
  if (needs.visionData && !has.visionData) return 'vision'
  if (needs.visionHttp && !has.visionHttp) return 'vision_url'
  if (needs.video && !has.video) return 'video'
  return null
}

// ── tenant key resolution (reuses connect-provider's rows; NOT resolveMediaAccess — that one
// carries media-plan entitlement logic that must not decide chat access) ─────────────────────────

export interface TenantKeyDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase service-role client shape
  admin: any
  decrypt: (sealed: string, accountId: string, provider: string) => Promise<string>
}

export async function resolveTenantChatKey(
  deps: TenantKeyDeps,
  accountId: string,
  provider: TenantChatProvider,
): Promise<{ ok: true; key: string } | { ok: false; code: 'NEED_KEY' | 'KEY_UNAVAILABLE' }> {
  const { data, error } = await deps.admin
    .from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', provider).maybeSingle()
  // fail closed and DISTINCT: a DB outage must not read as "no key" (which the caller could
  // phrase as "connect a key"), and neither may become a silent switch to another provider
  if (error) return { ok: false, code: 'KEY_UNAVAILABLE' }
  const sealed = typeof data?.api_key === 'string' ? data.api_key : ''
  if (!sealed) return { ok: false, code: 'NEED_KEY' }
  try {
    const key = await deps.decrypt(sealed, accountId, provider)
    return key ? { ok: true, key } : { ok: false, code: 'KEY_UNAVAILABLE' }
  } catch {
    return { ok: false, code: 'KEY_UNAVAILABLE' }
  }
}

// ── request/response normalization per provider ──────────────────────────────────────────────────

const textOf = (content: CliMessage['content']): string =>
  typeof content === 'string'
    ? content
    : (content ?? []).map((part) => part.type === 'text' ? part.text ?? '' : '').join('')

const parseDataUrl = (url: string): { mediaType: string; data: string } | null => {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url)
  return match ? { mediaType: match[1], data: match[2] } : null
}

function openAiWire(selection: ChatCallSelection, request: ChatCallRequest, url: string, extraHeaders: Record<string, string>, extraBody: Record<string, unknown>) {
  return {
    url,
    headers: { Authorization: `Bearer ${selection.key}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: {
      model: selection.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools?.length ? { tools: request.tools, tool_choice: 'auto' } : {}),
      ...extraBody,
    },
  }
}

function anthropicWire(selection: ChatCallSelection, request: ChatCallRequest) {
  const systemParts: string[] = []
  const messages: Array<Record<string, unknown>> = []
  for (const message of request.messages) {
    if (message.role === 'system') { systemParts.push(textOf(message.content)); continue }
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: textOf(message.content) }],
      })
      continue
    }
    const blocks: Array<Record<string, unknown>> = []
    if (typeof message.content === 'string') {
      if (message.content) blocks.push({ type: 'text', text: message.content })
    } else {
      for (const part of message.content ?? []) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text ?? '' })
        if (part.type === 'image_url') {
          const url = part.image_url?.url ?? ''
          const inline = parseDataUrl(url)
          blocks.push({
            type: 'image',
            source: inline ? { type: 'base64', media_type: inline.mediaType, data: inline.data } : { type: 'url', url },
          })
        }
      }
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use', id: call.id, name: call.function.name,
          input: ((): unknown => { try { return JSON.parse(call.function.arguments) } catch { return {} } })(),
        })
      }
    }
    if (blocks.length) messages.push({ role: message.role, content: blocks })
  }
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': selection.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: {
      model: selection.model,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(systemParts.length ? { system: systemParts.join('\n') } : {}),
      messages,
      ...(request.tools?.length
        ? {
          tools: request.tools.map((tool) => {
            const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } }).function ?? {}
            return { name: fn.name ?? '', description: fn.description ?? '', input_schema: fn.parameters ?? { type: 'object' } }
          }),
        }
        : {}),
    },
  }
}

function geminiWire(selection: ChatCallSelection, request: ChatCallRequest) {
  const systemParts: string[] = []
  const contents: Array<Record<string, unknown>> = []
  for (const message of request.messages) {
    if (message.role === 'system') { systemParts.push(textOf(message.content)); continue }
    const parts: Array<Record<string, unknown>> = []
    if (message.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: message.name ?? 'tool', response: { result: textOf(message.content) } } }] })
      continue
    }
    if (typeof message.content === 'string') {
      if (message.content) parts.push({ text: message.content })
    } else {
      for (const part of message.content ?? []) {
        if (part.type === 'text') parts.push({ text: part.text ?? '' })
        if (part.type === 'image_url') {
          const inline = parseDataUrl(part.image_url?.url ?? '')
          if (inline) parts.push({ inline_data: { mime_type: inline.mediaType, data: inline.data } })
        }
      }
    }
    for (const call of message.tool_calls ?? []) {
      parts.push({
        functionCall: {
          name: call.function.name,
          args: ((): unknown => { try { return JSON.parse(call.function.arguments) } catch { return {} } })(),
        },
      })
    }
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  return {
    // the key travels in a HEADER: a query-string key would land in every infra request log
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selection.model)}:generateContent`,
    headers: { 'x-goog-api-key': selection.key, 'Content-Type': 'application/json' },
    body: {
      ...(systemParts.length ? { systemInstruction: { parts: [{ text: systemParts.join('\n') }] } } : {}),
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      ...(request.tools?.length
        ? {
          tools: [{
            functionDeclarations: request.tools.map((tool) => {
              const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } }).function ?? {}
              return { name: fn.name ?? '', description: fn.description ?? '', parameters: fn.parameters ?? { type: 'object' } }
            }),
          }],
        }
        : {}),
    },
  }
}

export function buildProviderRequest(selection: ChatCallSelection, request: ChatCallRequest) {
  if (selection.provider === 'anthropic') return anthropicWire(selection, request)
  if (selection.provider === 'gemini') return geminiWire(selection, request)
  if (selection.provider === 'groq') return openAiWire(selection, request, 'https://api.groq.com/openai/v1/chat/completions', {}, {})
  if (selection.provider === 'openai') return openAiWire(selection, request, 'https://api.openai.com/v1/chat/completions', {}, {})
  return openAiWire(selection, request, 'https://openrouter.ai/api/v1/chat/completions',
    { 'HTTP-Referer': 'https://nemoai.uz', 'X-Title': 'Nemo AI' },
    request.openrouterRouting ? { provider: request.openrouterRouting } : {})
}

const num = (value: unknown): number => Math.max(0, Number(value) || 0)

export function parseProviderResponse(provider: ChatProvider, payload: Record<string, unknown>, fallbackModel: string): ChatCallOk | null {
  if (provider === 'anthropic') {
    const blocks = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : null
    if (!blocks) return null
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
    const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
      id: String(b.id ?? ''), type: 'function',
      function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
    }))
    const usage = (payload.usage ?? {}) as Record<string, unknown>
    const promptTokens = num(usage.input_tokens)
    const completionTokens = num(usage.output_tokens)
    return {
      ok: true, content: text || null, toolCalls,
      model: String(payload.model ?? fallbackModel),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, costUsd: null },
    }
  }
  if (provider === 'gemini') {
    const candidate = (payload.candidates as Array<Record<string, unknown>> | undefined)?.[0]
    const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts ?? null) as Array<Record<string, unknown>> | null
    if (!parts) return null
    const text = parts.map((p) => typeof p.text === 'string' ? p.text : '').join('')
    const toolCalls = parts
      .filter((p) => p.functionCall && typeof p.functionCall === 'object')
      .map((p, index) => {
        const call = p.functionCall as { name?: unknown; args?: unknown }
        return { id: `call_${index}`, type: 'function', function: { name: String(call.name ?? ''), arguments: JSON.stringify(call.args ?? {}) } }
      })
    const meta = (payload.usageMetadata ?? {}) as Record<string, unknown>
    const promptTokens = num(meta.promptTokenCount)
    const completionTokens = num(meta.candidatesTokenCount)
    return {
      ok: true, content: text || null, toolCalls,
      model: String(payload.modelVersion ?? fallbackModel),
      usage: { promptTokens, completionTokens, totalTokens: num(meta.totalTokenCount) || promptTokens + completionTokens, costUsd: null },
    }
  }
  const choice = (payload.choices as Array<Record<string, unknown>> | undefined)?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  if (!message) return null
  const usage = (payload.usage ?? {}) as Record<string, unknown>
  const promptTokens = num(usage.prompt_tokens)
  const completionTokens = num(usage.completion_tokens)
  return {
    ok: true,
    content: typeof message.content === 'string' ? message.content : null,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [],
    model: String(payload.model ?? fallbackModel),
    reportedModel: typeof payload.model === 'string' ? payload.model : undefined,
    upstreamProvider: typeof payload.provider === 'string' ? payload.provider : undefined,
    usage: {
      promptTokens, completionTokens,
      totalTokens: num(usage.total_tokens) || promptTokens + completionTokens,
      costUsd: usage.cost != null && Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null,
    },
  }
}

// ── the bounded call ─────────────────────────────────────────────────────────────────────────────

export async function callChatProvider(
  fetchImpl: FetchLike,
  selection: ChatCallSelection,
  request: ChatCallRequest,
  options: { deadlineAt: number; now?: () => number },
): Promise<ChatCallResult> {
  const nowMs = options.now ?? (() => Date.now())
  const deadlineAt = Math.min(options.deadlineAt, nowMs() + PER_CALL_TIMEOUT_MS)
  if (nowMs() >= deadlineAt) return { ok: false, code: 'PROVIDER_UNAVAILABLE' }
  const wire = buildProviderRequest(selection, request)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - nowMs()))
  try {
    let response: Response
    try {
      response = await fetchImpl(wire.url, {
        method: 'POST',
        headers: wire.headers,
        body: JSON.stringify(wire.body),
        signal: controller.signal,
        redirect: 'error',
      })
    } catch {
      return { ok: false, code: 'PROVIDER_UNAVAILABLE' }
    }
    if (!response.ok) {
      // provider error bodies can echo internals — never forward them, never log the config
      void response.body?.cancel().catch(() => {})
      if (response.status === 402) return { ok: false, code: 'NO_CREDITS' }
      if (response.status === 429) return { ok: false, code: 'RATE_LIMITED' }
      if (response.status === 401 || response.status === 403) return { ok: false, code: 'KEY_REJECTED' }
      return { ok: false, code: 'PROVIDER_ERROR' }
    }
    const read = await readBytesBounded(
      { headers: { get: () => null }, body: response.body },
      { maxBytes: MAX_RESPONSE_BYTES, deadlineAt, now: nowMs },
    )
    if (!read.ok) { controller.abort(); return { ok: false, code: read.reason === 'timeout' ? 'PROVIDER_UNAVAILABLE' : 'INVALID_PROVIDER_RESPONSE' } }
    const payload = ((): Record<string, unknown> | null => {
      try { return JSON.parse(new TextDecoder().decode(read.bytes)) } catch { return null }
    })()
    if (!payload) return { ok: false, code: 'INVALID_PROVIDER_RESPONSE' }
    return parseProviderResponse(selection.provider, payload, selection.model) ?? { ok: false, code: 'INVALID_PROVIDER_RESPONSE' }
  } finally {
    clearTimeout(timer)
  }
}
