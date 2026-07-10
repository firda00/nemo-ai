import type { AgentTrace, AgentTraceKind, AgentTraceStep } from '../types/platform'

// Defensive parser for system_trace message content (written by the agent runtime).
// A malformed or unknown payload returns null so a bad trace can never crash the
// conversation view; unknown step kinds are skipped, sizes are capped, and steps
// missing their kind's required fields are rejected rather than rendered with
// fabricated defaults (e.g. a route step without a numeric confidence).

const KINDS = new Set<string>(['route', 'lead_decision', 'consult', 'unresolved_delegate', 'synthesize'])
const MAX_STEPS = 12

/** True when a dialogue message should render as a normal chat bubble (strict allowlist). */
export function isChatMessage(m: { type?: string }): boolean {
  return (m.type ?? 'chat') === 'chat'
}

export function parseAgentTrace(content: string): AgentTrace | null {
  try {
    const j = JSON.parse(content)
    if (!j || j.version !== 1 || !Array.isArray(j.steps)) return null
    const steps: AgentTraceStep[] = []
    for (const s of j.steps.slice(0, MAX_STEPS)) {
      if (!s || typeof s !== 'object' || !KINDS.has(String(s.kind))) continue
      if (s.kind === 'route' && !(typeof s.confidence === 'number' && isFinite(s.confidence))) continue
      if (s.kind === 'lead_decision' && s.decision !== 'direct' && s.decision !== 'delegate') continue
      steps.push({
        kind: s.kind as AgentTraceKind,
        agentName: String(s.agentName ?? '').slice(0, 120) || '—',
        agentId: typeof s.agentId === 'string' ? s.agentId : null,
        fromAgentName: typeof s.fromAgentName === 'string' && s.fromAgentName.trim() ? s.fromAgentName.slice(0, 120) : undefined,
        fromAgentId: typeof s.fromAgentId === 'string' ? s.fromAgentId : null,
        task: typeof s.task === 'string' && s.task.trim() ? s.task.slice(0, 200) : undefined,
        confidence: typeof s.confidence === 'number' && isFinite(s.confidence) ? Math.max(0, Math.min(1, s.confidence)) : undefined,
        decision: s.decision === 'direct' || s.decision === 'delegate' ? s.decision : undefined,
      })
    }
    if (!steps.length) return null
    return { replyMessageId: typeof j.replyMessageId === 'string' ? j.replyMessageId : null, steps }
  } catch {
    return null
  }
}
