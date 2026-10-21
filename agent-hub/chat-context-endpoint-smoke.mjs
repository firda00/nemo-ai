// Independent endpoint probe: actual bundled handler, explicitly fake Auth/DB/provider.
// No environment credentials and no network calls. Run from the repository root.
import assert from 'node:assert/strict'
import esbuild from 'esbuild'

const state = { accountId: '11111111-1111-4111-8111-111111111111', events: [], requests: [] }
const previous = { Deno: globalThis.Deno, fetch: globalThis.fetch }
globalThis.__chatContextProbe = state
let handler
globalThis.Deno = { env: { get: name => ({ SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_ANON_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' })[name] }, serve: value => { handler = value } }
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions')
  state.events.push('fake-provider')
  state.requests.push(JSON.parse(init.body))
  return Response.json({ model: 'openai/gpt-4o-mini', choices: [{ message: { content: 'Synthetic answer.' } }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })
}
const snippets = {
  client: `const s=globalThis.__chatContextProbe; export function createClient(){return {
    auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}}})},
    from(table){s.events.push(table);const q={select:()=>q,eq:()=>q,
      maybeSingle:async()=>({data:{account_id:s.accountId}}),
      single:async()=>({data:{blocked:false,token_balance:1000,plan:'free'},error:null})};return q},
    rpc:async(name)=>{s.events.push(name);return {error:null}}
  }}`,
  llm: `export const PRIMARY_MODEL='openai/gpt-4o-mini';export const CLIENT_RESPONSE_STYLE='Synthetic style.';export const estimateCostUsd=()=>0;`,
  plans: `export const planOf=()=>({tokens:10000,premium:false});export const monthlyTokens=async()=>{globalThis.__chatContextProbe.events.push('monthlyTokens');return 0}`,
}
const passed = []
const request = async extras => {
  state.events = []
  const response = await handler(new Request('https://synthetic.invalid/cli-chat', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'Synthetic history.' }], tools: [], ...extras }),
  }))
  return { status: response.status, body: await response.json() }
}
try {
  const bundle = await esbuild.build({ entryPoints: ['supabase/functions/cli-chat/index.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'explicit-offline-probe', setup(build) {
      build.onResolve({ filter: /^https:\/\/esm\.sh\/.*supabase/ }, () => ({ path: 'client', namespace: 'probe' }))
      build.onResolve({ filter: /\/_shared\/(llm|plans)\.ts$/ }, args => ({ path: args.path.includes('plans') ? 'plans' : 'llm', namespace: 'probe' }))
      build.onLoad({ filter: /.*/, namespace: 'probe' }, args => ({ contents: snippets[args.path], loader: 'js' }))
    } }] })
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  assert.equal(typeof handler, 'function')
  for (const expected of ['22222222-2222-4222-8222-222222222222', null, {}, '']) {
    const count = state.requests.length
    const result = await request({ contextAccountId: expected })
    assert.equal(result.status, 409)
    assert.equal(result.body.code, 'CHAT_CONTEXT_ACCOUNT_CHANGED')
    assert.equal(state.requests.length, count)
    assert(!state.events.some(event => ['monthlyTokens', 'provider_keys', 'fake-provider', 'record_token_usage'].includes(event)))
  }
  passed.push('mismatched and malformed account preconditions fail before provider/key/billing')
  for (const extras of [{ contextAccountId: state.accountId }, {}]) {
    const count = state.requests.length
    const result = await request(extras)
    assert.equal(result.status, 200)
    assert.equal(result.body.message.content, 'Synthetic answer.')
    assert.equal(state.requests.length, count + 1)
    assert(state.events.includes('monthlyTokens'))
    assert(state.events.includes('record_token_usage'))
    assert(!Object.hasOwn(state.requests.at(-1), 'contextAccountId'))
  }
  passed.push('matching account and legacy omission retain the existing mocked model/billing route')
  const old = state.accountId
  state.accountId = '33333333-3333-4333-8333-333333333333'
  const count = state.requests.length
  assert.equal((await request({ contextAccountId: old })).status, 409)
  assert.equal(state.requests.length, count)
  assert(!state.events.includes('monthlyTokens'))
  passed.push('account reassigned after client preflight is rejected using server profile')
  console.log(JSON.stringify({ passed: passed.length, checks: passed, actualHandler: true,
    substitutions: ['Supabase Auth and DB', 'plan lookup', 'cost estimate', 'provider transport'],
    networkCalls: 0, fakeProviderCalls: state.requests.length }, null, 2))
} finally {
  globalThis.Deno = previous.Deno; globalThis.fetch = previous.fetch; delete globalThis.__chatContextProbe
}
