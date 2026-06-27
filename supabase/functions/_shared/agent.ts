// Shared agent runtime — used by every channel webhook (Telegram/WhatsApp/Instagram).
// Builds context (system prompt + knowledge + recent history), calls the LLM,
// stores the agent reply + token usage, and returns the reply text ('' on failure).
import { callOpenRouter, buildSystemPrompt, type ChatMsg } from './llm.ts'
import { loadMemory, saveMemory } from './memory.ts'
import { resolveOpenRouterKey } from './keys.ts'

const RATE_LIMIT_PER_MIN = 20

// "HH:MM" now in a timezone (falls back to UTC on a bad zone).
function nowInTz(tz: string): string {
  try {
    return new Date().toLocaleTimeString('en-GB', { timeZone: tz || 'UTC', hour12: false, hour: '2-digit', minute: '2-digit' })
  } catch {
    return new Date().toISOString().slice(11, 16)
  }
}
// Is `now` within [start, end)? Supports overnight windows (e.g. 22:00–06:00).
function withinWorkHours(tz: string, start: string, end: string): boolean {
  if (!start || !end || start === end) return true
  const now = nowInTz(tz)
  return start < end ? now >= start && now < end : now >= start || now < end
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function buildReply(db: any, openrouterKey: string, agent: any, dialogueId: string): Promise<string> {
  // Paused/blocked agents don't reply (admin block pauses all of an account's agents).
  if (agent.status && agent.status !== 'active') return ''

  // Honor custom work hours — 24/7 always replies; 'work-hours' only inside the window.
  if (agent.schedule === 'work-hours' && !withinWorkHours(agent.timezone, agent.work_start, agent.work_end)) return ''

  // Cost guard — per-customer rate limit (a dialogue maps 1:1 to an external_id).
  const since = new Date(Date.now() - 60_000).toISOString()
  const { count: recent } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('dialogue_id', dialogueId)
    .eq('author', 'customer')
    .gte('created_at', since)
  if ((recent ?? 0) > RATE_LIMIT_PER_MIN) return ''

  // Cost guard — stop when the account has no AI tokens left.
  const { data: acc } = await db.from('accounts').select('token_balance').eq('id', agent.account_id).single()
  if (acc && Number(acc.token_balance) <= 0) return ''

  const { data: history } = await db
    .from('messages')
    .select('author, content')
    .eq('dialogue_id', dialogueId)
    .order('created_at', { ascending: true })
    .limit(20)

  const { data: docs } = await db.from('knowledge_docs').select('name, content').eq('owner_id', agent.id).limit(10)
  const knowledge = (docs ?? [])
    .map((d: any) => `- ${d.name ?? ''}: ${d.content ?? ''}`)
    .join('\n')
    .slice(0, 4000)

  // self-improving agents recall memory across dialogues
  const isLearning = agent.type === 'learning'
  const memory = isLearning ? await loadMemory(db, agent.id) : ''

  const messages: ChatMsg[] = [
    { role: 'system', content: buildSystemPrompt(agent, knowledge, memory) },
    ...(history ?? []).map((m: any): ChatMsg => ({ role: m.author === 'customer' ? 'user' : 'assistant', content: m.content })),
  ]

  try {
    // use the account's own OpenRouter key if they set one, else Nemo's shared key
    const apiKey = await resolveOpenRouterKey(db, agent.account_id, openrouterKey)
    const out = await callOpenRouter({ apiKey, model: agent.model, messages, temperature: Number(agent.temperature) })
    if (out.content) {
      await db.from('messages').insert({ dialogue_id: dialogueId, author: 'agent', content: out.content })
      await db.from('usage').insert({ account_id: agent.account_id, tokens: out.tokens, model: agent.model })
      // decrement the account's token balance by what we just spent
      if (out.tokens) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: out.tokens })
      // learn from the latest customer turn (newest 'customer' message)
      if (isLearning) {
        const lastCustomer = [...(history ?? [])].reverse().find((m: any) => m.author === 'customer')
        if (lastCustomer?.content) await saveMemory(db, agent.account_id, agent.id, dialogueId, lastCustomer.content)
      }
    }
    return out.content
  } catch (e) {
    console.error('buildReply LLM error:', e)
    return ''
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
