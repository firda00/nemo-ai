export const CLI_MAX_MESSAGES = 80
export const CLI_MAX_TOOLS = 64
export const CLI_MAX_BODY_BYTES = 180_000
export const CLI_MAX_COMPLETION_TOKENS = 2_000

export type CliMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export interface CliChatInput {
  model: string
  messages: CliMessage[]
  tools: Array<Record<string, unknown>>
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const SAFE_MODEL = /^[a-z0-9._:-]+\/[a-z0-9._:-]+$/i

export function parseCliChatInput(value: unknown): { ok: true; data: CliChatInput } | { ok: false; code: string } {
  if (!value || typeof value !== 'object') return { ok: false, code: 'INVALID_REQUEST' }
  const row = value as Record<string, unknown>
  const model = typeof row.model === 'string' ? row.model.trim() : ''
  const messages = Array.isArray(row.messages) ? row.messages : []
  const tools = Array.isArray(row.tools) ? row.tools : []
  if (!SAFE_MODEL.test(model) || model.length > 120) return { ok: false, code: 'INVALID_MODEL' }
  if (!messages.length || messages.length > CLI_MAX_MESSAGES || tools.length > CLI_MAX_TOOLS) {
    return { ok: false, code: 'INVALID_REQUEST' }
  }

  const checked: CliMessage[] = []
  for (const item of messages) {
    if (!item || typeof item !== 'object') return { ok: false, code: 'INVALID_MESSAGE' }
    const message = item as Record<string, unknown>
    if (typeof message.role !== 'string' || !ROLES.has(message.role)) return { ok: false, code: 'INVALID_MESSAGE' }
    if (message.content !== null && typeof message.content !== 'string') return { ok: false, code: 'INVALID_MESSAGE' }
    if (typeof message.content === 'string' && message.content.length > 40_000) return { ok: false, code: 'MESSAGE_TOO_LARGE' }
    checked.push(message as CliMessage)
  }

  const serializedTools = JSON.stringify(tools)
  if (serializedTools.length > 80_000) return { ok: false, code: 'TOOLS_TOO_LARGE' }
  return { ok: true, data: { model, messages: checked, tools: tools as Array<Record<string, unknown>> } }
}

export function reservedCliTokens(input: CliChatInput): number {
  const inputBytes = new TextEncoder().encode(JSON.stringify(input.messages) + JSON.stringify(input.tools)).length
  return Math.max(1_000, inputBytes + CLI_MAX_COMPLETION_TOKENS + 1_000)
}
