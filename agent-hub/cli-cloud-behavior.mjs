import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createNemoCloudStream, fetchNemoBalance } from './cli/cloud.ts'
import { parseCliChatInput, reservedCliTokens } from '../supabase/functions/_shared/cliChat.ts'

let checks = 0
const check = (condition, message) => { checks++; assert.ok(condition, message) }

const messages = [{ role: 'user', content: 'Собери отчёт' }]
const tools = [{ type: 'function', function: { name: 'make_report', parameters: { type: 'object' } } }]
let request = null
const stream = createNemoCloudStream({
  accessToken: 'SESSION_TOKEN',
  model: 'openai/gpt-4o-mini',
  gatewayUrl: 'https://nemo.test/',
  fetchImpl: async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({
      ok: true,
      message: {
        content: 'Готово',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'make_report', arguments: '{"x":1}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  },
})
const chunks = []
for await (const chunk of stream(messages, tools, new AbortController().signal)) chunks.push(chunk)
assert.equal(request.url, 'https://nemo.test/api/cli/chat'); checks++
assert.equal(request.init.headers.Authorization, 'Bearer SESSION_TOKEN'); checks++
assert.equal(JSON.stringify(request).includes('OPENROUTER'), false); checks++
assert.deepEqual(request.body, { model: 'openai/gpt-4o-mini', messages, tools }); checks++
check(chunks.some((chunk) => chunk.kind === 'text' && chunk.delta === 'Готово'), 'облачный текст потерян')
check(chunks.some((chunk) => chunk.kind === 'tool_delta' && chunk.name === 'make_report'), 'tool call потерян')

for (const [status, expected] of [[401, /nemo login/], [402, /Лимит Nemo/], [429, /Слишком много/]]) {
  const denied = createNemoCloudStream({
    accessToken: 'TOKEN', model: 'openai/gpt-4o-mini',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status }),
  })
  await assert.rejects(async () => { for await (const _ of denied(messages, [], new AbortController().signal)) void _ }, expected)
  checks++
}

const balance = await fetchNemoBalance({
  accessToken: 'TOKEN',
  fetchImpl: async () => new Response(JSON.stringify({ ok: true, plan: 'pro', credits: 42, used_tokens: 1234, token_limit: 5000 }), { status: 200 }),
})
assert.equal(balance.ok, true); checks++
check(balance.ok && /pro/.test(balance.text) && /42/.test(balance.text), 'баланс Nemo не отображает тариф и кредиты')

assert.equal(parseCliChatInput(null).ok, false); checks++
assert.equal(parseCliChatInput({ model: 'bad model', messages, tools: [] }).ok, false); checks++
const valid = parseCliChatInput({ model: 'openai/gpt-4o-mini', messages, tools })
assert.equal(valid.ok, true); checks++
check(valid.ok && reservedCliTokens(valid.data) >= 3_000, 'резерв токенов не учитывает completion budget')

const root = path.resolve(import.meta.dirname, '..')
const entry = fs.readFileSync(path.join(root, 'agent-hub', 'nemo.mjs'), 'utf8')
check(!/if \(!process\.env\.OPENROUTER_API_KEY\)/.test(entry), 'CLI всё ещё блокируется без OPENROUTER_API_KEY')
check(/createNemoCloudStream/.test(entry), 'CLI не подключает облачный proxy')
check(/localModel[\s\S]*createOpenRouterStream/.test(entry), 'локальная Ollama потеряна')

const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'cli-chat', 'index.ts'), 'utf8')
check(/auth\.getUser\(\)/.test(edge), 'proxy не проверяет Supabase JWT')
check(/\.eq\('id', user\.id\)/.test(edge) && /\.eq\('id', accountId\)/.test(edge), 'proxy не ограничивает user/account lookup текущим tenant')
check(/monthlyTokens\(admin, accountId\)/.test(edge), 'proxy не проверяет месячный лимит')
check(/record_token_usage/.test(edge), 'proxy не списывает фактическое потребление централизованно')
check(!/firdavsbahtiyorov505/i.test(edge), 'в proxy захардкожена почта владельца')

console.log(`[OK] CLI cloud proxy: ${checks} assertions`)
