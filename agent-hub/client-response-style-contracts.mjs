import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const llm = read('supabase/functions/_shared/llm.ts')
const agent = read('supabase/functions/_shared/agent.ts')
const orchestrate = read('supabase/functions/orchestrate/index.ts')
const cli = read('supabase/functions/cli-chat/index.ts')
const desk = read('src/components/platform/SmartTaskDesk.tsx')

assert.match(llm, /export const CLIENT_RESPONSE_STYLE/)
for (const rule of [
  /Lead with the answer, completed result or clearest recommendation/,
  /For a simple question, answer in 1-4 short sentences/,
  /Never expose internal reasoning/,
  /Ask at most one concise question/,
]) assert.match(llm, rule)

assert.match(llm, /langRule,[\s\S]*CLIENT_RESPONSE_STYLE,[\s\S]*PERSONAL_GUARD/)
assert.match(llm, /langRule,[\s\S]*CLIENT_RESPONSE_STYLE,[\s\S]*SCOPE_GUARD/)
assert.match(agent, /const leadSystem = buildSystemPrompt/)
assert.match(orchestrate, /CLIENT_RESPONSE_STYLE/)
assert.doesNotMatch(orchestrate, /Format as clean professional Markdown: a title, a 2-3 sentence executive summary/)
assert.match(cli, /messages: \[\{ role: 'system', content: CLIENT_RESPONSE_STYLE \}, \.\.\.parsed\.data\.messages\]/)
assert.match(desk, /functions\.invoke\('cli-chat'/)
assert.match(desk, /direct: true/)
assert.match(desk, /answering &&/)
assert.match(desk, /<Markdown content=\{turn\.text\}/)

console.log('[OK] Customer responses are direct, adaptive, private, and consistent across chat, agents, teams, and CLI')
