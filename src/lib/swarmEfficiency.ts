import { parseAgentTrace } from './agentTrace.ts'

// Swarm efficiency aggregates (spec §8 Milestone 5: "how many hops to a solution"),
// computed from the system_trace rows the runtime already persists — no extra queries.
// A "hop" is one hand-off to another agent: route, consult, or unresolved_delegate.
// lead_decision and synthesize describe the lead's own work, so they are not hops;
// a direct reply therefore counts as 0 hops in the average instead of being dropped.

export interface SwarmEfficiency {
  /** replies that carried a parseable multi-agent trace */
  tracedReplies: number
  /** average hops per traced reply, 1 decimal (null when no traces) */
  avgHops: number | null
  /** % of traced replies with at least one hop (null when no traces) */
  delegatedPct: number | null
  /** % of traced replies containing an unresolved_delegate step (null when no traces) */
  unresolvedPct: number | null
}

const HOP_KINDS = new Set(['route', 'consult', 'unresolved_delegate'])

/** Accepts raw live rows (message_type) and mock messages (type) alike. */
export function computeSwarmEfficiency(
  rows: Array<{ message_type?: string | null; type?: string | null; content?: string | null }>,
): SwarmEfficiency {
  let traced = 0
  let hops = 0
  let delegated = 0
  let unresolved = 0
  for (const r of rows) {
    if ((r.message_type ?? r.type ?? 'chat') !== 'system_trace') continue
    const trace = parseAgentTrace(r.content ?? '')
    if (!trace) continue
    traced += 1
    const h = trace.steps.filter((s) => HOP_KINDS.has(s.kind)).length
    hops += h
    if (h > 0) delegated += 1
    if (trace.steps.some((s) => s.kind === 'unresolved_delegate')) unresolved += 1
  }
  if (!traced) return { tracedReplies: 0, avgHops: null, delegatedPct: null, unresolvedPct: null }
  return {
    tracedReplies: traced,
    avgHops: Math.round((hops / traced) * 10) / 10,
    delegatedPct: Math.round((delegated / traced) * 100),
    unresolvedPct: Math.round((unresolved / traced) * 100),
  }
}
