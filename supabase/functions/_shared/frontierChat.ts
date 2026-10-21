import { readBytesBounded } from './boundedBody.ts'
import { isFrontierSelection, type FrontierSelection } from './frontierModels.ts'

// Bounded first layer: text, inline images, client-executed function calls. Hosted tools,
// arbitrary provider options and audio/video are deliberately outside this adapter.
export const FRONTIER_MAX_OUTPUT_TOKENS = 8_192
export const FRONTIER_MAX_HISTORY_BYTES = 1_000_000
export const FRONTIER_MAX_RESPONSE_BYTES = 1_000_000
export const FRONTIER_DEADLINE_MS = 60_000
export const FRONTIER_CONTINUATION_TTL_MS = 60 * 60 * 1000
export const FRONTIER_MAX_TURNS = 40
// A deadline bounds awaits even when a dependency ignores AbortSignal. Callers also pass
// the signal to real transports so the losing operation releases its resources.
export async function withinFrontierDeadline<T>(promise: PromiseLike<T>, deadlineAt: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('deadline')
  let expire: () => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = () => reject(new Error('deadline')) })
  const timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()))
  signal?.addEventListener('abort', expire, { once: true })
  try {
    const result = await Promise.race([Promise.resolve(promise), expired])
    if (signal?.aborted || Date.now() >= deadlineAt) throw new Error('deadline')
    return result
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', expire) }
}
type Row = Record<string, unknown>
type ImagePart = { type: 'image_url'; image_url: { url: string } }
type TextPart = { type: 'text'; text: string }
export type FrontierMessage = {
  role: 'system' | 'user' | 'tool'
  content: string | Array<TextPart | ImagePart>
  tool_call_id?: string
}
export type FrontierTool = { type: 'function'; function: { name: string; description?: string; parameters: Row } }
export type FrontierInput = {
  selection: FrontierSelection
  messages: FrontierMessage[]
  tools: FrontierTool[]
  continuation?: string
}
export type FrontierCode = 'INVALID_REQUEST' | 'INVALID_MODEL' | 'UNSUPPORTED_CAPABILITY' | 'INVALID_CONTINUATION'
  | 'INVALID_TOOL_RESULTS' | 'CONTEXT_LIMIT' | 'NEED_KEY' | 'KEY_UNAVAILABLE' | 'CONTINUATION_UNAVAILABLE'
  | 'PROVIDER_REFUSAL' | 'OUTPUT_INCOMPLETE' | 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' | 'KEY_REJECTED'
  | 'PROVIDER_ERROR' | 'INVALID_PROVIDER_RESPONSE'
export type FrontierFail = { ok: false; code: FrontierCode }
const fail = (code: FrontierCode): FrontierFail => ({ ok: false, code })
const rowOf = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (row: Row, keys: string[]) => Object.keys(row).every(key => keys.includes(key))
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const namePattern = /^[a-zA-Z0-9_-]{1,64}$/
const idPattern = /^[a-zA-Z0-9_-]{1,200}$/

export function parseFrontierInput(value: unknown): { ok: true; data: FrontierInput } | FrontierFail {
  if (!rowOf(value) || !only(value, ['selection', 'messages', 'tools', 'continuation'])) return fail('INVALID_REQUEST')
  if (!isFrontierSelection(value.selection)) return fail('INVALID_MODEL')
  if (value.continuation !== undefined && (typeof value.continuation !== 'string'
    || !value.continuation.startsWith('enc:v2:') || value.continuation.length > 1_600_000)) return fail('INVALID_CONTINUATION')
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 16) return fail('INVALID_REQUEST')
  for (const message of value.messages) {
    if (!rowOf(message) || !only(message, ['role', 'content', 'tool_call_id'])) return fail('INVALID_REQUEST')
    if (!['system', 'user', 'tool'].includes(String(message.role))) return fail('INVALID_REQUEST')
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !idPattern.test(message.tool_call_id)
        || typeof message.content !== 'string' || message.content.length > 40_000) return fail('INVALID_TOOL_RESULTS')
    } else if (message.tool_call_id !== undefined) return fail('INVALID_REQUEST')
    if (typeof message.content === 'string') {
      if (!message.content.trim() || message.content.length > 40_000) return fail('INVALID_REQUEST')
    } else {
      if (message.role !== 'user' || !Array.isArray(message.content) || !message.content.length || message.content.length > 3) return fail('INVALID_REQUEST')
      let imageCount = 0
      for (const part of message.content) {
        if (!rowOf(part)) return fail('INVALID_REQUEST')
        if (part.type === 'text') {
          if (!only(part, ['type', 'text']) || typeof part.text !== 'string' || part.text.length > 40_000) return fail('INVALID_REQUEST')
        } else if (part.type === 'image_url') {
          if (!only(part, ['type', 'image_url']) || !rowOf(part.image_url) || !only(part.image_url, ['url'])) return fail('INVALID_REQUEST')
          const url = part.image_url.url
          // Inline only: URL fetch semantics and provider Files APIs are a separate capability.
          if (typeof url !== 'string' || url.length > 400_000
            || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return fail('UNSUPPORTED_CAPABILITY')
          if (++imageCount > 2) return fail('CONTEXT_LIMIT')
        } else return fail('UNSUPPORTED_CAPABILITY')
      }
    }
  }
  const tools = value.tools ?? []
  if (!Array.isArray(tools) || tools.length > 16 || bytes(tools) > 32_000) return fail('INVALID_REQUEST')
  const names = new Set<string>()
  for (const tool of tools) {
    if (!rowOf(tool) || tool.type !== 'function') return fail('UNSUPPORTED_CAPABILITY')
    if (!only(tool, ['type', 'function']) || !rowOf(tool.function)) return fail('INVALID_REQUEST')
    const fn = tool.function
    if (!only(fn, ['name', 'description', 'parameters']) || typeof fn.name !== 'string' || !namePattern.test(fn.name)
      || names.has(fn.name) || (fn.description !== undefined && (typeof fn.description !== 'string' || fn.description.length > 2_000))
      || !rowOf(fn.parameters) || fn.parameters.type !== 'object') return fail('INVALID_REQUEST')
    names.add(fn.name)
  }
  if (bytes(value.messages) > FRONTIER_MAX_HISTORY_BYTES) return fail('CONTEXT_LIMIT')
  return { ok: true, data: { selection: value.selection, messages: value.messages as FrontierMessage[], tools: tools as FrontierTool[], ...(value.continuation ? { continuation: value.continuation as string } : {}) } }
}

export type FrontierState = {
  version: 1
  selection: FrontierSelection
  system: string
  history: Row[]
  tools: FrontierTool[]
  pending: string[]
  expiresAt: number
  turns: number
}
const sameSelection = (left: FrontierSelection, right: FrontierSelection) => left.provider === right.provider && left.model === right.model && left.effort === right.effort
const exactTools = (left: FrontierTool[], right: FrontierTool[]) => JSON.stringify(left) === JSON.stringify(right)

export function frontierContinuationContext(accountId: string, userId: string, selection: FrontierSelection): string {
  // A separate authenticated-encryption purpose prevents a credential ciphertext from being
  // replayed as a conversation. Include the user, not just the shared tenant.
  return `frontier-chat:v1:${accountId}:${userId}:${selection.provider}:${selection.model}:${selection.effort}`
}

export function prepareFrontierState(input: FrontierInput, previous: unknown, now: number): { ok: true; state: FrontierState } | FrontierFail {
  let state: FrontierState
  if (input.continuation) {
    if (!rowOf(previous) || previous.version !== 1 || !isFrontierSelection(previous.selection)
      || !sameSelection(previous.selection, input.selection) || typeof previous.system !== 'string'
      || !Array.isArray(previous.history) || !previous.history.every(rowOf) || !Array.isArray(previous.tools)
      || !exactTools(previous.tools as FrontierTool[], input.tools) || !Array.isArray(previous.pending)
      || !previous.pending.every(item => typeof item === 'string' && idPattern.test(item))
      || !Number.isSafeInteger(previous.expiresAt) || Number(previous.expiresAt) <= now
      || !Number.isSafeInteger(previous.turns) || Number(previous.turns) < 1) return fail('INVALID_CONTINUATION')
    if (Number(previous.turns) >= FRONTIER_MAX_TURNS) return fail('CONTEXT_LIMIT')
    state = structuredClone(previous) as FrontierState
    if (state.pending.length) {
      const actual = input.messages.map(item => item.tool_call_id)
      if (input.messages.some(item => item.role !== 'tool') || actual.length !== state.pending.length
        || new Set(actual).size !== actual.length || actual.some(id => !state.pending.includes(id!))) return fail('INVALID_TOOL_RESULTS')
    } else if (input.messages.length !== 1 || input.messages[0].role !== 'user') return fail('INVALID_REQUEST')
  } else {
    // Do not import fabricated native assistant/tool history. Start a new conversation using
    // one stable system instruction and one user message; later history is server issued.
    const messages = input.messages
    if (!((messages.length === 1 && messages[0].role === 'user')
      || (messages.length === 2 && messages[0].role === 'system' && messages[1].role === 'user'))) return fail('INVALID_REQUEST')
    state = { version: 1, selection: input.selection, system: messages[0].role === 'system' ? messages[0].content as string : '',
      history: [], tools: input.tools, pending: [], expiresAt: now + FRONTIER_CONTINUATION_TTL_MS, turns: 0 }
  }
  const incoming = input.messages.filter(item => item.role !== 'system')
  if (input.selection.provider === 'openai') {
    for (const message of incoming) {
      if (message.role === 'tool') state.history.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
      else state.history.push({ role: 'user', content: typeof message.content === 'string'
        ? [{ type: 'input_text', text: message.content }]
        : message.content.map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url }) })
    }
  } else if (state.pending.length) {
    // Anthropic requires all results for a parallel tool-use turn in the immediately
    // following user message, preserving the preceding assistant blocks exactly.
    state.history.push({ role: 'user', content: incoming.map(message => ({ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content })) })
  } else {
    for (const message of incoming) state.history.push({ role: 'user', content: typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url)!
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
      }) })
  }
  state.pending = []
  // Reserve room for the next bounded model output BEFORE any paid request. A long history
  // cannot incur a bill and then discover that its continuation cannot be retained.
  if (bytes(state) > FRONTIER_MAX_HISTORY_BYTES - 200_000) return fail('CONTEXT_LIMIT')
  return { ok: true, state }
}

export function buildFrontierRequest(state: FrontierState, key: string): { url: string; headers: Record<string, string>; body: Row } {
  const { selection } = state
  if (selection.provider === 'openai') return {
    url: 'https://api.openai.com/v1/responses',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: { model: selection.model, store: false, include: ['reasoning.encrypted_content'],
      ...(state.system ? { instructions: state.system } : {}), input: state.history,
      reasoning: { effort: selection.effort }, max_output_tokens: FRONTIER_MAX_OUTPUT_TOKENS,
      ...(state.tools.length ? { tools: state.tools.map(tool => ({ type: 'function', ...tool.function, strict: false })), tool_choice: 'auto' } : {}) },
  }
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: { model: selection.model, max_tokens: FRONTIER_MAX_OUTPUT_TOKENS, output_config: { effort: selection.effort },
      ...(state.system ? { system: state.system } : {}), messages: state.history,
      ...(state.tools.length ? { tools: state.tools.map(tool => ({ name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}), input_schema: tool.function.parameters })), tool_choice: { type: 'auto' } } : {}) },
  }
}

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type FrontierCompletion = {
  ok: true
  message: { role: 'assistant'; content: string | null; tool_calls: ToolCall[] }
  model: FrontierSelection['model']
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; payer: 'tenant_provider' }
  state: FrontierState
}

export function parseFrontierResponse(state: FrontierState, payload: unknown): FrontierCompletion | FrontierFail {
  if (!rowOf(payload) || payload.model !== state.selection.model || !rowOf(payload.usage)) return fail('INVALID_PROVIDER_RESPONSE')
  const usage = payload.usage
  let promptTokens = usage.input_tokens
  const completionTokens = usage.output_tokens
  if (!Number.isSafeInteger(promptTokens) || Number(promptTokens) < 0 || Number(promptTokens) > 1_100_000
    || !Number.isSafeInteger(completionTokens) || Number(completionTokens) < 0 || Number(completionTokens) > FRONTIER_MAX_OUTPUT_TOKENS) return fail('INVALID_PROVIDER_RESPONSE')
  if (state.selection.provider === 'anthropic') {
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheWrite = usage.cache_creation_input_tokens ?? 0
    if (!Number.isSafeInteger(cacheRead) || Number(cacheRead) < 0 || !Number.isSafeInteger(cacheWrite) || Number(cacheWrite) < 0) return fail('INVALID_PROVIDER_RESPONSE')
    promptTokens = Number(promptTokens) + Number(cacheRead) + Number(cacheWrite)
    if (Number(promptTokens) > 1_100_000) return fail('INVALID_PROVIDER_RESPONSE')
  }
  let text = ''
  const toolCalls: ToolCall[] = []
  let nativeOutput: Row[]
  const toolNames = new Set(state.tools.map(tool => tool.function.name))
  const addTool = (id: unknown, name: unknown, args: unknown) => {
    if (typeof id !== 'string' || !idPattern.test(id) || typeof name !== 'string' || !toolNames.has(name)
      || !rowOf(args) || toolCalls.some(tool => tool.id === id) || toolCalls.length >= 16 || bytes(args) > 40_000) return false
    toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
    return true
  }
  if (state.selection.provider === 'openai') {
    if (payload.status === 'incomplete') return fail('OUTPUT_INCOMPLETE')
    if (payload.status !== 'completed' || !Array.isArray(payload.output) || !payload.output.every(rowOf)) return fail('INVALID_PROVIDER_RESPONSE')
    nativeOutput = payload.output
    for (const item of nativeOutput) {
      if (item.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content) || !item.content.every(rowOf)) return fail('INVALID_PROVIDER_RESPONSE')
        for (const part of item.content) {
          if (part.type === 'refusal') return fail('PROVIDER_REFUSAL')
          if (part.type !== 'output_text' || typeof part.text !== 'string') return fail('INVALID_PROVIDER_RESPONSE')
          text += part.text
        }
      } else if (item.type === 'function_call') {
        let args: unknown
        try { args = JSON.parse(String(item.arguments)) } catch { return fail('INVALID_PROVIDER_RESPONSE') }
        if (!addTool(item.call_id, item.name, args)) return fail('INVALID_PROVIDER_RESPONSE')
      } else if (item.type === 'reasoning') {
        if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) return fail('INVALID_PROVIDER_RESPONSE')
      } else return fail('UNSUPPORTED_CAPABILITY')
    }
  } else {
    if (payload.stop_reason === 'refusal') return fail('PROVIDER_REFUSAL')
    if (payload.stop_reason === 'max_tokens' || payload.stop_reason === 'pause_turn') return fail('OUTPUT_INCOMPLETE')
    if (!['end_turn', 'tool_use'].includes(String(payload.stop_reason)) || !Array.isArray(payload.content)
      || !payload.content.every(rowOf)) return fail('INVALID_PROVIDER_RESPONSE')
    const blocks = payload.content
    for (const block of blocks) {
      if (block.type === 'text') {
        if (typeof block.text !== 'string') return fail('INVALID_PROVIDER_RESPONSE')
        text += block.text
      } else if (block.type === 'tool_use') {
        if (!addTool(block.id, block.name, block.input)) return fail('INVALID_PROVIDER_RESPONSE')
      } else if (block.type === 'thinking') {
        if (typeof block.signature !== 'string' || !block.signature) return fail('INVALID_PROVIDER_RESPONSE')
      } else if (block.type === 'redacted_thinking') {
        if (typeof block.data !== 'string' || !block.data) return fail('INVALID_PROVIDER_RESPONSE')
      } else return fail('UNSUPPORTED_CAPABILITY')
    }
    if ((payload.stop_reason === 'tool_use') !== (toolCalls.length > 0)) return fail('INVALID_PROVIDER_RESPONSE')
    nativeOutput = [{ role: 'assistant', content: blocks }]
  }
  if ((!text.trim() && !toolCalls.length) || bytes(nativeOutput) > 200_000) return fail('INVALID_PROVIDER_RESPONSE')
  const next = { ...state, history: [...state.history, ...nativeOutput], pending: toolCalls.map(tool => tool.id), turns: state.turns + 1 }
  if (bytes(next) > FRONTIER_MAX_HISTORY_BYTES) return fail('CONTEXT_LIMIT')
  return { ok: true, message: { role: 'assistant', content: text || null, tool_calls: toolCalls }, model: state.selection.model,
    usage: { prompt_tokens: Number(promptTokens), completion_tokens: Number(completionTokens), total_tokens: Number(promptTokens) + Number(completionTokens), payer: 'tenant_provider' }, state: next }
}

export async function callFrontierProvider(state: FrontierState, key: string, options: {
  fetchImpl: typeof fetch; deadlineAt: number; signal?: AbortSignal; now?: () => number
}): Promise<FrontierCompletion | FrontierFail> {
  const now = options.now ?? Date.now
  if (options.signal?.aborted || now() >= options.deadlineAt) return fail('PROVIDER_UNAVAILABLE')
  const wire = buildFrontierRequest(state, key)
  const controller = new AbortController()
  let expire: (reason: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => { expire = reject })
  expired.catch(() => {})
  const abort = () => { controller.abort(); expire(new Error('aborted')) }
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { controller.abort(); expire(new Error('deadline')) }, Math.max(0, options.deadlineAt - now()))
  try {
    const response = await Promise.race([options.fetchImpl(wire.url, { method: 'POST', headers: wire.headers,
      body: JSON.stringify(wire.body), signal: controller.signal, redirect: 'error' }), expired])
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      return fail(response.status === 429 ? 'RATE_LIMITED' : response.status === 401 || response.status === 403 ? 'KEY_REJECTED' : 'PROVIDER_ERROR')
    }
    const read = await Promise.race([readBytesBounded(response, { maxBytes: FRONTIER_MAX_RESPONSE_BYTES, deadlineAt: options.deadlineAt, now }), expired])
    if (!read.ok) return fail(read.reason === 'timeout' ? 'PROVIDER_UNAVAILABLE' : 'INVALID_PROVIDER_RESPONSE')
    let payload: unknown
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)) } catch { return fail('INVALID_PROVIDER_RESPONSE') }
    if (options.signal?.aborted || now() >= options.deadlineAt) return fail('PROVIDER_UNAVAILABLE')
    return parseFrontierResponse(state, payload)
  } catch { return fail('PROVIDER_UNAVAILABLE') }
  finally { clearTimeout(timer); controller.abort(); options.signal?.removeEventListener('abort', abort) }
}
