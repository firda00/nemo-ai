// Executes the actual Deno endpoint with synthetic auth/database/provider modules.
// No network, secrets, live model, Supabase, or billing operations.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'

const dir = path.resolve('agent-hub/artifacts/cashflow-period-stage')
fs.mkdirSync(dir, { recursive: true })
const state = { account: { blocked: false, token_balance: 1000 }, events: [], narrative: { impact_assessments: [], inefficiencies: [], recommendations: [] }, user: { id: 'u1' } }
globalThis.__financeEndpoint = state
const previousDeno = globalThis.Deno, previousFetch = globalThis.fetch
globalThis.fetch = () => { throw new Error('Unexpected network') }
let handler
globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_ANON_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic' })[key] }, serve: fn => { handler = fn } }
const snippets = {
  client: `const state=globalThis.__financeEndpoint; export function createClient(){return {
    auth:{getUser:async()=>({data:{user:state.user}})},
    from(table){state.events.push(table);const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:{account_id:'11111111-1111-4111-8111-111111111111'}}),single:async()=>({data:state.account})};return query},
    rpc:async(name)=>{state.events.push(name);return{error:null}}
  }}`,
  keys: `export async function resolveOpenRouterKey(){globalThis.__financeEndpoint.events.push('provider-key');return 'synthetic'}`,
  llm: `export const stripJsonFence=v=>v; export const estimateCostUsd=()=>0;
    export async function callOpenRouter(input){const state=globalThis.__financeEndpoint;state.events.push('model');state.prompt=input.messages.map(m=>m.content).join('\\n');return{content:JSON.stringify(state.narrative),model:'synthetic',usage:{promptTokens:1,completionTokens:1,totalTokens:2,costUsd:0,reasoningTokens:0,cachedTokens:0}}}`,
}
let passed = 0
const check = async (name, run) => { await run(); passed++; console.log(`[OK] ${name}`) }
const workspace = '11111111-1111-4111-8111-111111111111'
const source = content => ({ format: 'csv', source_id: 'statement', imported_at: '2026-09-05T00:00:00Z', content })
const input = () => ({ workspace_id: workspace, period: { from: '2026-08-01T00:00:00+05:00', to: '2026-09-01T00:00:00+05:00' }, base_currency: 'UZS', opening_balance_minor: 0, sources: [source('date;type;amount;status\n2026-08-01;income;100.01;posted\n2026-08-02;expense;10;pending\n2026-09-01;income;9999;posted')] })
const call = async (body, extra = {}) => { state.events=[]; const response=await handler(new Request('https://synthetic.invalid/finance', {method:'POST',headers:{Authorization:'Bearer synthetic', 'Content-Type':'application/json'},body:JSON.stringify(body), ...extra}));return {status:response.status,body:await response.json(),events:[...state.events]} }
try {
  const bundle = await esbuild.build({ entryPoints: ['supabase/functions/finance-analyze-cashflow/index.ts'], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent', plugins:[{name:'finance-offline',setup(build){
    build.onResolve({filter:/^https:\/\/esm\.sh\/.*supabase/},()=>({path:'client',namespace:'finance-mock'}))
    build.onResolve({filter:/\/_(?:shared)\/(?:keys|llm)\.ts$/},args=>({path:args.path.includes('keys')?'keys':'llm',namespace:'finance-mock'}))
    build.onLoad({filter:/.*/,namespace:'finance-mock'},args=>({contents:snippets[args.path],loader:'js'}))
  }}] })
  fs.writeFileSync(path.join(dir,'endpoint-bundle.mjs.snapshot'),bundle.outputFiles[0].text)
  await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))
  assert.equal(typeof handler,'function')
  await check('endpoint returns only period-selected posted rows and correct minor-unit totals',async()=>{
    const result=await call(input());assert.equal(result.status,200);assert.equal(result.body.analysis.summary.inflow_minor,10001);assert.equal(result.body.transactions.length,1);assert.equal(result.body.selection.outside_period_count,1);assert.equal(result.body.selection.pending_in_period_count,1);assert(!state.prompt.includes('9999'));assert.equal(result.events.filter(e=>e==='model').length,1);assert.equal(result.events.filter(e=>e==='record_token_usage').length,1)
  })
  await check('missing authorization and foreign workspace are refused without a model',async()=>{
    const anonymous=await call(input(),{headers:{'Content-Type':'application/json'}});assert.equal(anonymous.status,401);assert.deepEqual(anonymous.events,[])
    const foreign=await call({...input(),workspace_id:'22222222-2222-4222-8222-222222222222'});assert.equal(foreign.status,403);assert(!foreign.events.includes('provider-key'))
  })
  await check('invalid dates, incomplete sources, empty periods and overflow fail before provider/account work',async()=>{
    const bad=[input(),input(),input(),input()]
    bad[0].sources[0].content+='\n2026-02-30;income;10;posted'
    bad[1].sources.push({format:'pdf_json',source_id:'unread',imported_at:'2026-09-05T00:00:00Z',pages:[{page:1,text:'unread text'}]})
    bad[2].period={from:'2027-01-01T00:00:00Z',to:'2027-02-01T00:00:00Z'}
    bad[3].sources=[source('date;type;amountminor\n2026-08-01;income;9007199254740991\n2026-08-02;income;2')]
    for(const [i,body]of bad.entries()){const result=await call(body);assert.equal(result.status,400);assert.equal(result.body.code,['INGESTION_INCOMPLETE','INGESTION_INCOMPLETE','NO_TRANSACTIONS_IN_PERIOD','AMOUNT_OVERFLOW'][i]);assert.deepEqual(result.events,['users'])}
  })
  await check('a missing account fails closed before model/key and normalizes no false success',async()=>{
    state.account=null;const result=await call(input());assert.equal(result.status,503);assert.equal(result.body.code,'ACCOUNT_UNAVAILABLE');assert(!result.events.includes('provider-key'));state.account={blocked:false,token_balance:1000}
  })
  await check('out-of-period narrative evidence is rejected even from a valid source',async()=>{
    state.narrative={impact_assessments:[],inefficiencies:[],recommendations:[{title:'Invalid',explanation:'Outside period',confidence:1,evidence:[{source_id:'statement',source_kind:'csv',locator:{row:4}}],action:'investigate',estimated_saving_minor:null,owner_role:'User',priority:'low',requires_human_approval:true}]}
    const result=await call(input());assert.equal(result.status,502);assert.equal(result.body.code,'ANALYSIS_FAILED');assert.equal(result.events.filter(e=>e==='model').length,2);state.narrative={impact_assessments:[],inefficiencies:[],recommendations:[]}
  })
  fs.writeFileSync(path.join(dir,'endpoint-result.json'),JSON.stringify({passed,networkCalls:0,actualDenoHandler:true},null,2)+'\n')
} finally {globalThis.Deno=previousDeno;globalThis.fetch=previousFetch;delete globalThis.__financeEndpoint}
