// Real shared tool loop + real test-agent/agent-tool handlers + real inbound buildReply.
// All Supabase, model and outbound transports are synthetic; no credentials are read.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'

const outDir = path.resolve('agent-hub/artifacts/employee-deploy-stage')
fs.mkdirSync(outDir, { recursive: true })
const agentId = '10000000-0000-4000-8000-000000000001'
const state = {}
function reset(extra = {}) {
  Object.assign(state, { user: { id: 'user-a' }, account: { id: 'tenant-a', blocked: false, plan: 'free', token_balance: 10000, is_production_e2e: false },
    profile: { id: 'user-a', account_id: 'tenant-a' },
    agent: { id: agentId, account_id: 'tenant-a', type: 'analyst', name: 'Test', status: 'active', action_policy: 'approval_required', model: 'openai/gpt-4o-mini', skills: [] },
    keys: [], google: { refresh_token: 'synthetic' }, custom: [], events: [], approvals: [], writes: [], requests: [], toolReplies: [], chatReplies: [],
    fail: null, lead: null, business: {}, history: [{ author: 'customer', content: 'Help with a task' }], ...extra })
}
reset()
const db = {
  auth: { getUser: async () => ({ data: { user: state.user } }) },
  from(table) {
    const filters = [], query = { columns: '', operation: 'select', values: null }
    const get = key => filters.find(([column]) => column === key)?.[1]
    const result = async (single = false) => {
      state.events.push({ table, operation: query.operation, filters: [...filters] })
      const error = state.fail === table ? { code: 'synthetic_failure' } : null
      if (query.operation === 'insert' || query.operation === 'update') {
        state.writes.push({ table, operation: query.operation, values: query.values })
        if (table === 'approval_requests' && !error) {
          const row = { ...query.values, id: `approval-${state.approvals.length + 1}`, status: 'pending' }
          state.approvals.push(row); return { data: { id: row.id }, error }
        }
        return { data: { id: 'row-a' }, error }
      }
      let data = null
      if (table === 'accounts') data = state.account
      else if (table === 'users') data = state.profile
      else if (table === 'agents') data = single ? state.agent : []
      else if (table === 'provider_keys') data = state.keys.filter(row => !get('provider') || row.provider === get('provider'))
      else if (table === 'google_accounts') data = state.google
      else if (table === 'custom_tools') data = state.custom
      else if (table === 'business_profiles') data = state.business
      else if (table === 'messages') data = state.history
      else if (table === 'leads') data = state.lead
      else if (table === 'dialogues') data = { id: 'dialogue-a', channel: 'telegram', external_id: 'customer-a', channel_id: 'channel-a' }
      else if (table === 'channels') data = { credentials: { bot_token: 'synthetic-never-sent' } }
      else if (table === 'approval_requests') {
        const key = get('evidence')?.nemo?.request_key
        data = state.approvals.find(row => row.account_id === get('account_id') && row.action_type === get('action_type') && row.status === 'pending' && row.evidence.nemo.request_key === key) ?? null
      } else data = single ? null : []
      return { data, error, count: 0 }
    }
    const chain = {
      select(columns) { query.columns = columns; return chain },
      eq(key, value) { filters.push([key, value]); return chain },
      neq() { return chain }, in() { return chain }, order() { return chain }, limit() { return chain }, gte() { return chain }, gt() { return chain },
      contains(key, value) { filters.push([key, value]); return chain },
      insert(values) { query.operation = 'insert'; query.values = values; return chain },
      update(values) { query.operation = 'update'; query.values = values; return chain },
      maybeSingle() { return result(true) }, single() { return result(true) }, then(resolve, reject) { return result().then(resolve, reject) },
    }
    return chain
  },
  async rpc(name, args) {
    state.events.push({ rpc: name, args })
    if (name === 'claim_lead_crm_push') return { data: { claim_token: 'claim-a', lead_fields: state.lead?.fields }, error: null }
    if (name === 'merge_lead_fields') return { data: { lead_id: 'lead-a', lead_fields: { ...state.lead?.fields, ...args.p_patch } }, error: null }
    return { data: true, error: null }
  },
}
globalThis.__agentPolicySmoke = { state, db }
const priorDeno = globalThis.Deno, priorFetch = globalThis.fetch
let capturedHandler
globalThis.Deno = { env: { get: name => ({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_ANON_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' })[name] }, serve: handler => { capturedHandler = handler } }
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions', 'no external mutation/provider call may escape')
  state.requests.push(JSON.parse(String(init.body)))
  const reply = state.toolReplies.shift()
  assert(reply, 'each synthetic model reply must be explicitly supplied')
  return new Response(JSON.stringify({ choices: [{ message: reply }], usage: { total_tokens: 7 } }), { status: 200 })
}
const snippets = {
  client: `export const createClient=()=>globalThis.__agentPolicySmoke.db;`,
  llm: `const s=globalThis.__agentPolicySmoke.state;export const PRIMARY_MODEL='openai/gpt-4o-mini',FALLBACK_MODEL='openai/gpt-4o-mini',SCOPE_GUARD='';export const estimateCostUsd=()=>0;export const buildSystemPrompt=()=>'';export async function callOpenRouter(){s.events.push({chatModel:true});const r=s.chatReplies.shift();if(!r)throw Error('missing synthetic chat reply');return r}`,
  plans: `export const planOf=()=>({premium:false});`,
  keys: `export async function resolveOpenRouterKey(){globalThis.__agentPolicySmoke.state.events.push({keyLookup:true});return 'synthetic'}`,
  knowledge: `export const retrieveKnowledge=async()=>'';export const retrieveTeamKnowledge=async()=>'';`,
  memory: `export const loadMemory=async()=>'';export const saveMemory=async()=>{};`,
  secretBox: `export const openSecret=async v=>v;export const providerSecretContext=()=>'';`,
  google: `export const googleAccessToken=async()=>{throw Error('OAuth must not be reached by a queued mutation')};`,
  net: `export const safeFetch=async url=>{globalThis.__agentPolicySmoke.state.events.push({publicRead:String(url)});return {body:'<p>Verified page</p>',res:new Response('')}};export const assertSafeUrl=async url=>new URL(url);`,
  marketplaceSnapshot: `export const storeSnapshot=async()=>{throw Error('Unexpected store snapshot')};`,
  telegram: `export const tgSend=async()=>{throw Error('Outbound Telegram must not be sent')};`,
}
const mockNames = Object.keys(snippets).filter(name => name !== 'client').join('|')
const plugin = { name: 'agent-policy-offline', setup(build) {
  build.onResolve({ filter: /^https:\/\/esm\.sh\/.*supabase/ }, () => ({ path: 'client', namespace: 'agent-policy-mock' }))
  build.onResolve({ filter: new RegExp(`(^|/)(${mockNames})\\.ts$`) }, args => ({ path: path.basename(args.path, '.ts'), namespace: 'agent-policy-mock' }))
  build.onLoad({ filter: /.*/, namespace: 'agent-policy-mock' }, args => ({ contents: snippets[args.path], loader: 'js' }))
} }
async function bundle(entry, content) {
  const output = await esbuild.build({ ...(content ? { stdin: { contents: content, resolveDir: process.cwd(), loader: 'ts' } } : { entryPoints: [entry] }), bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [plugin] })
  return await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'))
}
const toolCall = (name, args = {}) => ({ content: '', tool_calls: [{ id: 'call-a', function: { name, arguments: JSON.stringify(args) } }] })
const writeTables = () => state.writes.filter(row => !['tool_runs', 'approval_requests', 'messages', 'usage', 'dialogues'].includes(row.table))
const passed = []
async function check(name, run) { await run(); passed.push(name); console.log(`[OK] ${name}`) }
try {
  const { runAgentTools, buildReply } = await bundle(null, `export {runAgentTools} from './supabase/functions/_shared/tools.ts';export {buildReply} from './supabase/functions/_shared/agent.ts';`)
  await bundle('supabase/functions/test-agent/index.ts'); const testHandler = capturedHandler
  await bundle('supabase/functions/agent-tool/index.ts'); const integrationHandler = capturedHandler
  const invoke = async (handler, body) => {
    const response = await handler(new Request('https://synthetic.invalid/function', { method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  const run = (context = { agentId, actorUserId: 'user-a' }, kind = 'analyst') => runAgentTools(db, 'synthetic', 'tenant-a', 'Read https://example.org and help', [], kind, undefined, [], false, context)

  await check('actual tool loop blocks read_only writes and queues approval_required with no second model call', async () => {
    for (const policy of ['read_only', 'approval_required']) {
      reset(); state.agent.action_policy = policy; state.toolReplies.push(toolCall('sheets_create', { title: 'Test' }))
      const result = await run()
      assert.equal(result.ran, true); assert.equal(result.tool, 'sheets_create'); assert.equal(state.requests.length, 1)
      assert.equal(state.approvals.length, policy === 'approval_required' ? 1 : 0)
      assert.equal(writeTables().length, 0); assert.match(result.result, policy === 'approval_required' ? /approval request/ : /read-only/)
    }
  })
  await check('actual loop rejects hidden, disconnected and prototype names before executor', async () => {
    for (const name of ['github_list_repos', 'gmail_send', '__proto__', 'ct_hidden']) {
      reset(); state.toolReplies.push(toolCall(name, { to: 'person@example.org', body: 'Test' }))
      const result = await run(undefined, 'support')
      assert.match(result.result, /недоступен/); assert.equal(state.approvals.length, 0); assert.equal(writeTables().length, 0)
    }
  })
  await check('actual loop blocks draft/bookings/custom HTTP and MCP writes at the same boundary', async () => {
    reset({ google: null }); state.toolReplies.push(toolCall('book_appointment', { datetime_text: 'Tomorrow', datetime_iso: '2026-09-07T10:00:00Z' }))
    assert.match((await run({}, 'booking')).result, /не выполнено/); assert.equal(writeTables().length, 0)
    reset({ google: null }); state.toolReplies.push(toolCall('book_appointment', { datetime_text: 'Tomorrow' }))
    await run(undefined, 'booking'); assert.equal(state.approvals.length, 1); assert.equal(writeTables().length, 0)
    for (const kind of ['http', 'mcp']) {
      reset({ google: null, custom: [{ id: 'custom-a', kind, name: 'Reader', description: 'Claims read only', method: 'GET', url: 'https://synthetic.invalid/write', params: kind === 'mcp' ? [{ name: 'read', inputSchema: { type: 'object' } }] : [] }] })
      state.toolReplies.push(toolCall(kind === 'http' ? 'ct_reader' : 'mcp_reader_read'))
      assert.match((await run()).result, /approval request/); assert.equal(state.approvals.length, 1); assert.equal(writeTables().length, 0)
    }
  })
  await check('actual loop preserves allowed public reads even when saved write policy is unavailable', async () => {
    reset({ fail: 'agents' }); state.toolReplies.push(toolCall('read_webpage', { url: 'https://example.org' }), { content: 'Verified page' })
    const result = await run(); assert.equal(result.result, 'Verified page'); assert.equal(state.requests.length, 2)
    assert(state.events.some(event => event.publicRead === 'https://example.org')); assert.equal(state.approvals.length, 0)
  })
  await check('actual test-agent binds saved actor+tenant, ignores forged submitted policy and blocks failures before model work', async () => {
    for (const policy of ['read_only', 'approval_required']) {
      reset(); state.agent.action_policy = policy; state.toolReplies.push(toolCall('sheets_create', { title: 'Test' }))
      const out = await invoke(testHandler, { agent_id: agentId, agent: { action_policy: 'allow_all' }, message: 'Create a sheet' })
      assert.equal(out.status, 200); assert.equal(out.body.ok, true); assert.equal(state.approvals.length, policy === 'approval_required' ? 1 : 0)
      assert(state.events.some(event => event.table === 'users' && event.filters.some(([key, value]) => key === 'id' && value === 'user-a')))
      if (state.approvals.length) assert.equal(state.approvals[0].evidence.nemo.actor_user_id, 'user-a')
    }
    for (const config of [{ profile: null }, { fail: 'users' }, { account: null }, { fail: 'accounts' }, { agent: null }]) {
      reset(config)
      const out = await invoke(testHandler, { agent_id: agentId, message: 'Create a sheet' })
      assert(out.status >= 400); assert.equal(state.requests.length, 0); assert.equal(state.approvals.length, 0)
      assert(!state.events.some(event => event.keyLookup))
    }
    reset(); state.toolReplies.push(toolCall('sheets_create', { title: 'Draft' }))
    const draft = await invoke(testHandler, { agent: { type: 'analyst', action_policy: 'approval_required' }, message: 'Create a sheet' })
    assert.match(draft.body.reply, /не выполнено/); assert.equal(state.approvals.length, 0)
  })
  await check('existing integration tester keeps authenticated queue-only default and rejects profile failure', async () => {
    reset(); state.toolReplies.push(toolCall('sheets_create', { title: 'Test' }))
    const out = await invoke(integrationHandler, { instruction: 'Create a sheet' })
    assert.equal(out.body.pending_approval, true); assert.equal(state.approvals.length, 1)
    reset({ fail: 'users' }); assert.equal((await invoke(integrationHandler, { instruction: 'Create a sheet' })).status, 403)
    assert.equal(state.requests.length, 0)
  })
  await check('actual inbound runtime binds agent/dialogue and preserves queue-only result', async () => {
    for (const policy of ['read_only', 'approval_required']) {
      reset(); state.agent.action_policy = policy; state.toolReplies.push(toolCall('sheets_create', { title: 'Test' }))
      const result = await buildReply(db, 'synthetic', state.agent, 'dialogue-a')
      assert.match(result, policy === 'approval_required' ? /approval request/ : /read-only/)
      assert.equal(state.approvals.length, policy === 'approval_required' ? 1 : 0)
      if (state.approvals.length) assert.equal(state.approvals[0].evidence.nemo.dialogue_id, 'dialogue-a')
    }
    reset({ account: null }); assert.equal(await buildReply(db, 'synthetic', state.agent, 'dialogue-a'), '')
    assert.equal(state.requests.length, 0); assert(!state.events.some(event => event.keyLookup))
  })
  await check('automatic CRM path queues once, retains internal lead and never claims a remote push', async () => {
    for (const policy of ['read_only', 'approval_required']) {
      reset({ google: null, keys: [{ provider: 'hubspot', api_key: 'synthetic-never-sent' }], lead: { id: 'lead-a', fields: { name: 'Customer', phone: '+998901234567' } } })
      state.agent.type = 'support'; state.agent.action_policy = policy
      for (let turn = 0; turn < 2; turn++) {
        state.toolReplies.push({ content: 'No tool' }); state.chatReplies.push({ content: 'I can help', tokens: 2 })
        assert.equal(await buildReply(db, 'synthetic', state.agent, 'dialogue-a'), 'I can help')
      }
      assert.equal(state.approvals.length, policy === 'approval_required' ? 1 : 0)
      if (state.approvals.length) assert.equal(state.approvals[0].action_type, 'lead_crm_push')
      assert(!state.events.some(event => event.rpc === 'finish_lead_crm_push' && event.args.p_provider))
      assert(state.events.some(event => event.rpc === 'finish_lead_crm_push' && event.args.p_provider === null))
    }
  })
  await check('external escalation notification uses policy while internal human handoff remains available', async () => {
    for (const policy of ['read_only', 'approval_required']) {
      reset({ google: null, business: { notify_chat_id: 'owner-a' } }); state.agent.type = 'support'; state.agent.action_policy = policy
      state.chatReplies.push({ content: '[[ESCALATE]] Need human', tokens: 2 })
      assert.equal(await buildReply(db, 'synthetic', state.agent, 'dialogue-a'), '')
      assert(state.writes.some(row => row.table === 'dialogues' && row.values.status === 'needs_operator'))
      assert.equal(state.approvals.length, policy === 'approval_required' ? 1 : 0)
      if (state.approvals.length) assert.equal(state.approvals[0].action_type, 'escalation_notify')
    }
  })
  fs.writeFileSync(path.join(outDir, 'agent-action-policy-smoke-result.json'), JSON.stringify({ checks: passed, passed: passed.length,
    actualSharedToolLoop: true, actualTestAgentHandler: true, actualAgentToolHandler: true, actualInboundRuntime: true, networkCalls: 0, liveDbCalls: 0 }, null, 2) + '\n')
} finally { globalThis.Deno = priorDeno; globalThis.fetch = priorFetch; delete globalThis.__agentPolicySmoke }
