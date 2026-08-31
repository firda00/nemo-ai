import type { AgentDeps, ChatMessage, StreamChunk, ToolCall } from '../agent-runtime.ts'
import { GATEWAY_URL } from './defaults.ts'

export interface CloudUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface CloudReply {
  ok?: boolean
  code?: string
  message?: {
    content?: string | null
    tool_calls?: ToolCall[]
  }
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/cli/chat`
}

function publicError(status: number, body: CloudReply): string {
  if (status === 401) return 'Сессия истекла. Выполните nemo login.'
  if (status === 402 || body.code === 'LIMIT_REACHED') return 'Лимит Nemo исчерпан. Проверьте тариф в веб-панели.'
  if (status === 403) return 'Доступ к облачной модели запрещён для этого аккаунта.'
  if (status === 429) return 'Слишком много запросов. Повторите через несколько секунд.'
  return `Облачный сервис Nemo временно недоступен (${status}).`
}

/**
 * Облачный вызов модели через Nemo. В CLI нет и не должно быть ключа провайдера: наружу уходит
 * только Supabase access token текущей сессии, а лимиты и фактическое потребление считает сервер.
 * Ответ пока приходит одним JSON-блоком; наружу он всё равно представлен как AsyncIterable, чтобы
 * агентный цикл и локальная Ollama использовали один контракт.
 */
export function createNemoCloudStream(options: {
  accessToken: string
  model: string
  gatewayUrl?: string
  fetchImpl?: typeof fetch
  onUsage?: (usage: CloudUsage) => void
}): AgentDeps['stream'] {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = endpoint(options.gatewayUrl ?? GATEWAY_URL)

  return async function* stream(messages: ChatMessage[], tools: unknown[], signal: AbortSignal): AsyncIterable<StreamChunk> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: options.model, messages, tools }),
      signal,
    })
    const body = await response.json().catch(() => ({})) as CloudReply
    if (!response.ok || !body.ok || !body.message) throw new Error(publicError(response.status, body))

    const usage = {
      promptTokens: Number(body.usage?.prompt_tokens) || 0,
      completionTokens: Number(body.usage?.completion_tokens) || 0,
      totalTokens: Number(body.usage?.total_tokens) || 0,
    }
    if (usage.totalTokens > 0) options.onUsage?.(usage)

    if (body.message.content) yield { kind: 'text', delta: body.message.content }
    for (const [index, call] of (body.message.tool_calls ?? []).entries()) {
      yield {
        kind: 'tool_delta', index, id: call.id,
        name: call.function.name, argsDelta: call.function.arguments,
      }
    }
    yield { kind: 'done', reason: body.message.tool_calls?.length ? 'tool_calls' : 'stop' }
  }
}

export async function fetchNemoBalance(options: {
  accessToken: string
  gatewayUrl?: string
  fetchImpl?: typeof fetch
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint(options.gatewayUrl ?? GATEWAY_URL), {
      headers: { Authorization: `Bearer ${options.accessToken}` },
    })
    const body = await response.json().catch(() => ({})) as {
      ok?: boolean; plan?: string; credits?: number; used_tokens?: number; token_limit?: number
    }
    if (!response.ok || !body.ok) return { ok: false, error: publicError(response.status, body) }
    const used = Number(body.used_tokens) || 0
    const limit = Number(body.token_limit) || 0
    return {
      ok: true,
      text: `Nemo: тариф ${body.plan ?? 'free'}, кредитов ${Number(body.credits) || 0}, токенов ${used.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')}`,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
