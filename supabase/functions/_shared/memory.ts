// Lightweight persistent memory for self-improving ("learning") agents.
// Stores short summaries of past exchanges and feeds the most recent ones back
// into the system prompt so the agent keeps continuity across dialogues/sessions.
// Account-scoped via RLS (agent_memory table).

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Recent memory lines for an agent, newest last, joined for the prompt. */
export async function loadMemory(db: any, agentId: string, limit = 8): Promise<string> {
  if (!agentId) return ''
  const { data } = await db
    .from('agent_memory')
    .select('summary, created_at')
    .eq('agent_id', agentId)
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
  const summary = String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
  if (!agentId || summary.length < 4) return
  await db.from('agent_memory').insert({
    account_id: accountId,
    agent_id: agentId,
    dialogue_id: dialogueId,
    summary,
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
