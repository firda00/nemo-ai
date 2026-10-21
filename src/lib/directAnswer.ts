// Direct chat answers (cli-chat) under an HONEST client deadline. The raw
// supabase.functions.invoke has no timeout of its own: a hung function or a hung error body
// would leave the chat's "answering" state spinning forever. The bound here is sized for a
// fast conversational answer — deliberately NOT the 120s file-processing budget.
import { callBoundedFunction } from './boundedBriefingCall'

export const DIRECT_ANSWER_TIMEOUT_MS = 45_000

// ONE model constant for every direct-chat use (the desk's answers AND the document card's
// content step) — the provider stays whatever cli-chat is configured with server-side; the
// client adds no second router/model dependency
export const DIRECT_ANSWER_MODEL = 'openai/gpt-4o-mini'

export async function fetchDirectAnswer(
  invoke: () => PromiseLike<{ data: unknown; error: { context?: Response } | null }>,
  timeoutMs = DIRECT_ANSWER_TIMEOUT_MS,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const result = await callBoundedFunction(invoke, timeoutMs)
  const message = (result.payload as { message?: { content?: unknown } } | null)?.message
  const text = typeof message?.content === 'string' ? message.content.trim() : ''
  return result.ok && text ? { ok: true, text } : { ok: false }
}
