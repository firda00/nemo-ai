import assert from 'node:assert/strict'
import { computeSwarmEfficiency } from '../src/lib/swarmEfficiency.ts'

// Behavior checks for spec §8 Milestone 5 swarm-efficiency aggregates.
// Uses the same trace shape the runtime persists (agent.ts system_trace rows).

const trace = (steps) => JSON.stringify({ version: 1, replyMessageId: 'r1', steps })

const routed = trace([
  { kind: 'lead_decision', agentName: 'Lead', decision: 'delegate' },
  { kind: 'route', agentName: 'Specialist', confidence: 0.9 },
  { kind: 'synthesize', agentName: 'Lead' },
])
const direct = trace([{ kind: 'lead_decision', agentName: 'Lead', decision: 'direct' }])
const consultUnresolved = trace([
  { kind: 'consult', agentName: 'A', task: 'check availability' },
  { kind: 'consult', agentName: 'B', task: 'check pricing' },
  { kind: 'unresolved_delegate', agentName: 'Lead' },
])

const s = computeSwarmEfficiency([
  { message_type: 'chat', content: 'hello' },
  { message_type: 'system_trace', content: routed },
  { message_type: 'system_trace', content: direct },
  { message_type: 'system_trace', content: consultUnresolved },
  { message_type: 'system_trace', content: '{not json' },
  { message_type: 'system_trace', content: JSON.stringify({ version: 2, steps: [] }) },
  { content: routed }, // no type at all defaults to chat and never counts
])

assert.equal(s.tracedReplies, 3, 'only parseable system_trace rows count as traced replies')
assert.equal(s.avgHops, 1.3, 'hops = route+consult+unresolved per reply: (1+0+3)/3 rounds to 1.3')
assert.equal(s.delegatedPct, 67, 'a direct reply (0 hops) is not delegated: 2/3 replies')
assert.equal(s.unresolvedPct, 33, 'one reply carries an unresolved_delegate step: 1/3')

const mock = computeSwarmEfficiency([{ type: 'system_trace', content: routed }])
assert.equal(mock.tracedReplies, 1, 'mock-shaped rows (type instead of message_type) also count')
assert.equal(mock.avgHops, 1, 'lead_decision and synthesize are not hops')

assert.deepEqual(
  computeSwarmEfficiency([{ message_type: 'chat', content: 'x' }]),
  { tracedReplies: 0, avgHops: null, delegatedPct: null, unresolvedPct: null },
  'no traces yields null metrics so the UI can render an empty state instead of fake zeros',
)

console.log('All swarm efficiency behavior assertions passed.')
