import { auth } from './mock-auth'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__ownerCalls = []; g.__ownerPending = []; g.__ownerMode = {}; g.__ownerTakeover = false; g.__ownerStatus = 'needs_operator'
const aid = '10000000-0000-4000-8000-000000000001', did = '20000000-0000-4000-8000-000000000002'
const approval = (suffix: string) => ({ id: 'approval-' + suffix, source: 'agent', action_type: 'sheets_create', summary: 'PRIVATE-REQUEST-' + suffix, evidence: { title: 'Draft ' + suffix }, status: 'pending', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() })
function record(kind: string, options: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) {
  const call = { kind, authorization: options.headers?.Authorization, body: options.body, aborted: false }
  options.signal?.addEventListener('abort', () => { call.aborted = true }, { once: true })
  g.__ownerCalls.push(call)
  return call
}
export const isSupabaseEnabled = true
export const supabase = { auth,
  functions: { invoke: async (name: string, options: { body: Record<string, unknown>; headers: Record<string, string>; signal: AbortSignal }) => {
    const kind = name === 'operator-send' ? 'send' : String(options.body.action)
    record(kind, options)
    if (g.__ownerMode[kind] === 'hold') return new Promise(resolve => g.__ownerPending.push({ kind, resolve }))
    if (g.__ownerMode[kind] === 'error') return { data: { ok: false }, error: { message: 'Synthetic failure' } }
    const suffix = options.headers.Authorization.includes('user-b') ? 'B' : 'A'
    return { data: kind === 'list' ? { ok: true, requests: [approval(suffix)] } : { ok: true, delivered: false }, error: null }
  } },
  channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch }, removeChannel: async () => {},
}
g.__ownerApproval = approval
g.__ownerFetch = async (input: string | URL, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
  const url = new URL(String(input)); if (url.hostname !== 'synthetic.invalid') throw new Error('Non-synthetic fetch blocked')
  const table = url.pathname.split('/').at(-1), patch = options.method === 'PATCH'
  const kind = patch ? 'patch' : table
  record(String(kind), { ...options, body: options.body ? JSON.parse(options.body) : undefined })
  if (g.__ownerMode[kind] === 'hold') return new Promise(resolve => g.__ownerPending.push({ kind, resolve }))
  if (g.__ownerMode[kind] === 'error') return new Response('[]', { status: 500 })
  const suffix = options.headers?.Authorization.includes('user-b') ? 'B' : 'A'
  if (patch) { const change = JSON.parse(options.body ?? '{}'); g.__ownerTakeover = change.operator_takeover; g.__ownerStatus = change.status; return new Response(JSON.stringify([{ id: did, ...change }])) }
  const data = table === 'users' ? [{ account_id: 'account-' + suffix }] : table === 'agents' ? [{ id: aid, name: 'Employee ' + suffix }] :
    table === 'dialogues' ? [{ id: did, agent_id: aid, customer_name: 'PRIVATE-CUSTOMER-' + suffix, customer_contact: 'customer@example.invalid', channel: 'widget', status: g.__ownerStatus, operator_takeover: g.__ownerTakeover, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] :
      [{ id: 'message-' + suffix, dialogue_id: did, author: 'customer', content: 'PRIVATE-MESSAGE-' + suffix, message_type: 'chat', created_at: new Date().toISOString() }]
  return new Response(JSON.stringify(data))
}
