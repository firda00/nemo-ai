// Actual cli-chat Deno handler, fake Supabase and fake transports only. Provider wire,
// tenant-key lookup, AES-GCM continuation binding and the legacy branch remain real code.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'

const dir = path.resolve('agent-hub/artifacts/auth-latency-stage')
fs.mkdirSync(dir, { recursive: true })
const state = { account: { blocked: false, token_balance: 1000, plan: 'free' }, user: { id: 'u1' },
  accountId: 'a1', key: 'synthetic-key-never-sent', vaultError: null, stall: null, events: [], requests: [], replies: [] }
globalThis.__frontierEndpoint = state
const previousDeno = globalThis.Deno, previousFetch = globalThis.fetch
let handler
const fakeEncryption = Buffer.alloc(32, 11).toString('base64')
globalThis.Deno = { env: { get: name => ({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_ANON_KEY: 'synthetic',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic', CREDENTIAL_ENCRYPTION_KEY: fakeEncryption })[name] }, serve: value => { handler = value } }
globalThis.fetch = async (url, init) => {
  assert(['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages', 'https://openrouter.ai/api/v1/chat/completions'].includes(String(url)), 'unexpected transport')
  state.events.push('fake-model')
  const body = JSON.parse(String(init.body))
  state.requests.push({ url: String(url), body })
  const reply = state.replies.shift()
  assert(reply, 'the test must explicitly provide every model response')
  return new Response(JSON.stringify(reply), { status: 200 })
}
const snippets = {
  client: `const state=globalThis.__frontierEndpoint; export function createClient(){ return {
    auth:{getUser:async()=>state.stall==='auth'?new Promise(()=>{}):({data:{user:state.user}})},
    from(table){state.events.push(table); const query={select:()=>query,eq:(column,value)=>{state.events.push(column+':'+value);return query},
      maybeSingle:async()=>state.stall===table?new Promise(()=>{}):table==='users'?{data:{account_id:state.accountId}}:{data:state.key?{api_key:state.key}:null,error:state.vaultError},
      single:async()=>state.stall===table?new Promise(()=>{}):({data:state.account,error:null})}; return query},
    rpc:async(name)=>{state.events.push(name);return {error:null}}
  }}`,
  llm: `export const PRIMARY_MODEL='openai/gpt-4o-mini';export const CLIENT_RESPONSE_STYLE='Test style.';export const estimateCostUsd=()=>0;`,
  plans: `export const planOf=()=>({tokens:10000,premium:false});export const monthlyTokens=async()=>{globalThis.__frontierEndpoint.events.push('monthlyTokens');return 0}`, 
}
const astra = { provider: 'openai', model: 'gpt-6-astra', effort: 'low' }
const fable = { provider: 'anthropic', model: 'claude-fable-5-1', effort: 'medium' }
const input = (selection = astra, options = {}) => ({ selection, messages: [{ role: 'user', content: 'Test.' }], tools: [], ...options })
const astraReply = (output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready.' }] }]) => ({ model: astra.model, status: 'completed', output, usage: { input_tokens: 5, output_tokens: 5 } })
const fableReply = (content = [{ type: 'text', text: 'Ready.' }], stop_reason = 'end_turn') => ({ model: fable.model, stop_reason, content, usage: { input_tokens: 5, output_tokens: 5 } })
const call = async (body, extra = {}) => {
  state.events = []
  const response = await handler(new Request('https://synthetic.invalid/cli-chat', { method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra }))
  return { status: response.status, body: await response.json(), events: [...state.events] }
}
const passed = []
const check = async (name, run) => { await run(); passed.push(name); console.log(`[OK] ${name}`) }
try {
  const bundle = await esbuild.build({ entryPoints: ['supabase/functions/cli-chat/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'frontier-offline', setup(build) {
      build.onResolve({ filter: /^https:\/\/esm\.sh\/.*supabase/ }, () => ({ path: 'client', namespace: 'frontier-mock' }))
      build.onResolve({ filter: /\/_shared\/(llm|plans)\.ts$/ }, args => ({ path: args.path.includes('plans') ? 'plans' : 'llm', namespace: 'frontier-mock' }))
      build.onLoad({ filter: /.*/, namespace: 'frontier-mock' }, args => ({ contents: snippets[args.path], loader: 'js' }))
    } }] })
  fs.writeFileSync(path.join(dir, 'frontier-endpoint-bundle.mjs.snapshot'), bundle.outputFiles[0].text)
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  assert.equal(typeof handler, 'function')
  await check('authentication, account absence and account blocking prevent provider work', async () => {
    assert.equal((await call(input(), { headers: { 'Content-Type': 'application/json' } })).status, 401)
    state.user = null; assert.equal((await call(input())).status, 401); state.user = { id: 'u1' }
    state.account = null; const missing = await call(input()); assert.equal(missing.status, 503); assert(!missing.events.includes('provider_keys'))
    state.account = { blocked: true, token_balance: 0, plan: 'free' }
    const blocked = await call(input()); assert.equal(blocked.status, 403); assert(!blocked.events.includes('provider_keys'))
    state.account = { blocked: false, token_balance: 0, plan: 'free' }
  })
  await check('BYO works without platform credits, uses exact native model and never debits platform', async () => {
    for (const selection of [astra, fable]) {
      state.replies.push(selection === astra ? astraReply() : fableReply())
      const result = await call(input(selection))
      assert.equal(result.status, 200); assert.equal(result.body.model, selection.model)
      assert.equal(result.body.usage.payer, 'tenant_provider'); assert(result.body.frontier.continuation.startsWith('enc:v2:'))
      assert(result.events.includes('account_id:a1')); assert(result.events.includes(`provider:${selection.provider}`))
      assert(!result.events.includes('monthlyTokens')); assert(!result.events.includes('record_token_usage'))
      const wire = state.requests.at(-1)
      assert.equal(wire.body.model, selection.model); assert(!Object.hasOwn(wire.body, 'temperature'))
    }
  })
  await check('unsupported model/modal/tool and missing or failed key lookup never silently change payer', async () => {
    const before = state.requests.length
    for (const value of [input({ ...astra, model: 'gpt-4o-mini' }), input(astra, { tools: [{ type: 'computer_use' }] }),
      input(astra, { messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } }] }] })]) {
      const result = await call(value); assert.equal(result.status, 400); assert(!result.events.includes('provider_keys'))
    }
    state.key = null; assert.equal((await call(input())).body.code, 'NEED_KEY')
    state.key = 'synthetic'; state.vaultError = { code: 'OFFLINE' }; assert.equal((await call(input())).body.code, 'KEY_UNAVAILABLE'); state.vaultError = null
    assert.equal(state.requests.length, before)
  })
  await check('actual endpoint preserves native tool history and rejects other tenant or user continuation', async () => {
    const tool = { type: 'function', function: { name: 'calc', parameters: { type: 'object', properties: {} } } }
    for (const selection of [astra, fable]) {
      const native = selection === astra
        ? [{ type: 'reasoning', id: 'rs_a', encrypted_content: 'opaque-reasoning', summary: [] }, { type: 'function_call', call_id: 'call_a', name: 'calc', arguments: '{}' }]
        : [{ type: 'thinking', signature: 'opaque-signature', thinking: '' }, { type: 'tool_use', id: 'call_a', name: 'calc', input: {} }]
      state.replies.push(selection === astra ? astraReply(native) : fableReply(native, 'tool_use'))
      const first = await call(input(selection, { tools: [tool] })); assert.equal(first.status, 200)
      const next = input(selection, { tools: [tool], continuation: first.body.frontier.continuation, messages: [{ role: 'tool', tool_call_id: 'call_a', content: '42' }] })
      state.accountId = 'a2'; const tenant = await call(next); assert.equal(tenant.body.code, 'INVALID_CONTINUATION'); assert(!tenant.events.includes('provider_keys')); state.accountId = 'a1'
      state.user = { id: 'u2' }; const user = await call(next); assert.equal(user.body.code, 'INVALID_CONTINUATION'); assert(!user.events.includes('provider_keys')); state.user = { id: 'u1' }
      const badResult = await call({ ...next, messages: [{ role: 'tool', tool_call_id: 'invented', content: '42' }] }); assert.equal(badResult.body.code, 'INVALID_TOOL_RESULTS')
      state.replies.push(selection === astra ? astraReply() : fableReply()); assert.equal((await call(next)).status, 200)
      const wire = state.requests.at(-1).body
      if (selection === astra) assert.deepEqual(wire.input.slice(1, 3), native)
      else assert.deepEqual(wire.messages[1], { role: 'assistant', content: native })
    }
  })
  await check('legacy default chat retains platform billing and its existing model path', async () => {
    state.account.token_balance = 1000
    state.replies.push({ model: 'openai/gpt-4o-mini', choices: [{ message: { content: 'Legacy answer.' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })
    const result = await call({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }], tools: [] })
    assert.equal(result.status, 200); assert.equal(result.body.message.content, 'Legacy answer.')
    assert(result.events.includes('monthlyTokens')); assert(result.events.includes('record_token_usage'))
    assert.equal(state.requests.at(-1).url, 'https://openrouter.ai/api/v1/chat/completions')
  })
  await check('declared and chunked request overflow fail without model or vault calls', async () => {
    const declared = await call(input(), { headers: { Authorization: 'Bearer synthetic', 'Content-Length': '6000001' } })
    assert.equal(declared.status, 413); assert(!declared.events.includes('provider_keys'))
    const chunked = await call(input(), { body: 'x'.repeat(6_000_001) })
    assert.equal(chunked.status, 413); assert(!chunked.events.includes('provider_keys'))
  })
  await check('cancelled stalled auth, profile and account reads cannot hang or start provider work', async () => {
    const before = state.requests.length
    for (const stall of ['auth', 'users', 'accounts']) {
      state.stall = stall
      const controller = new AbortController()
      const pending = call(input(), { signal: controller.signal })
      setTimeout(() => controller.abort(), 5)
      const result = await pending
      assert.equal(result.status, 503); assert(!result.events.includes('provider_keys'))
    }
    state.stall = null
    assert.equal(state.requests.length, before)
  })
  fs.writeFileSync(path.join(dir, 'frontier-endpoint-result.json'), JSON.stringify({ passed: passed.length, checks: passed, actualDenoHandler: true,
    networkCalls: 0, fakeProviderCalls: state.requests.length, platformDebits: 'legacy mock only; no BYO debit' }, null, 2) + '\n')
} finally { globalThis.Deno = previousDeno; globalThis.fetch = previousFetch; delete globalThis.__frontierEndpoint }
