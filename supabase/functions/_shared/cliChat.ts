export const CLI_MAX_MESSAGES = 80
export const CLI_MAX_TOOLS = 64
export const CLI_MAX_BODY_BYTES = 6_000_000
export const CLI_MAX_COMPLETION_TOKENS = 2_000

export type CliMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<{
    type: 'text' | 'image_url' | 'video_url'
    text?: string
    image_url?: { url: string }
    video_url?: { url: string }
  }>
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
    if (message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) return { ok: false, code: 'INVALID_MESSAGE' }
    if (typeof message.content === 'string' && message.content.length > 40_000) return { ok: false, code: 'MESSAGE_TOO_LARGE' }
    if (Array.isArray(message.content)) {
      if (!message.content.length || message.content.length > 8) return { ok: false, code: 'INVALID_MESSAGE' }
      for (const rawPart of message.content) {
        if (!rawPart || typeof rawPart !== 'object') return { ok: false, code: 'INVALID_MESSAGE' }
        const part = rawPart as Record<string, unknown>
        if (!['text', 'image_url', 'video_url'].includes(String(part.type))) return { ok: false, code: 'INVALID_MESSAGE' }
        if (part.type === 'text' && (typeof part.text !== 'string' || part.text.length > 20_000)) return { ok: false, code: 'INVALID_MESSAGE' }
        const media = part.type === 'image_url' ? part.image_url : part.type === 'video_url' ? part.video_url : null
        if (media) {
          const url = (media as Record<string, unknown>).url
          if (typeof url !== 'string' || url.length > 3_000_000 || !/^(https?:\/\/|data:(image|video)\/)/.test(url)) return { ok: false, code: 'INVALID_MESSAGE' }
        }
      }
    }
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
