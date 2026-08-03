// Lightweight persistent memory for self-improving ("learning") agents.
// Stores short summaries of past exchanges and feeds the most recent ones back
// into the system prompt so the agent keeps continuity across dialogues/sessions.
// Account-scoped via RLS (agent_memory table).

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Recent memory lines for an agent, newest last, joined for the prompt. */
export async function loadMemory(db: any, accountId: string, agentId: string, dialogueId: string | null = null, limit = 8): Promise<string> {
  if (!accountId || !agentId) return ''
  let query = db
    .from('agent_memory')
    .select('summary, created_at')
    .eq('account_id', accountId)
    .eq('agent_id', agentId)
  query = dialogueId ? query.eq('dialogue_id', dialogueId) : query.is('dialogue_id', null)
  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(limit)
  const rows = (data ?? []) as { summary: string }[]
  return rows
    .reverse()
    .map((r) => `- ${r.summary}`)
    .join('\n')
    .slice(0, 2000)
}

/** Persist one compact memory line. Cheap (no extra LLM call) — stores what the
 *  customer said, trimmed; that's the durable signal (names, preferences, facts). */
export async function saveMemory(
  db: any,
  accountId: string,
  agentId: string,
  dialogueId: string | null,
  userText: string,
): Promise<void> {
  const summary = redactSensitiveText(String(userText ?? '')).replace(/\s+/g, ' ').trim().slice(0, 240)
  if (!agentId || summary.length < 4) return
  await db.from('agent_memory').insert({
    account_id: accountId,
    agent_id: agentId,
    dialogue_id: dialogueId,
    summary,
  })
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD REDACTED]')
    .replace(/\b(?:password|passwd|пароль|парол|cvv|cvc|pin)\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,})\b/g, '[TOKEN REDACTED]')
}
/* eslint-enable @typescript-eslint/no-explicit-any */
