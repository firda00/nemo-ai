import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(path, 'utf8')
const migration = read('supabase/migrations/20260723183000_telegram_worker_reliability.sql')
const sttMigration = read('supabase/migrations/20260723193000_agent_stt_model.sql')
const webhook = read('supabase/functions/telegram-webhook/index.ts')
const worker = read('supabase/functions/agent-worker/index.ts')
const tg = read('supabase/functions/_shared/tgProcess.ts')
const taskbot = read('supabase/functions/_shared/taskbot.ts')
const agentStore = read('src/store/useAgentStore.ts')
const agentEditor = read('src/pages/app/AgentEditorPage.tsx')

assert.match(migration, /insert into public\.worker_lease[\s\S]*on conflict \(id\) do nothing/i)
assert.match(migration, /enqueue_telegram_job[\s\S]*pgmq\.send\('tg_jobs'/i)
assert.match(migration, /revoke all on function public\.enqueue_telegram_job/i)
assert.match(webhook, /\.rpc\('enqueue_telegram_job'/)
assert.match(webhook, /status: 503/)
assert.match(worker, /\.rpc\('acquire_worker_lease'/)
assert.match(tg, /msg\.chat\?\.type === 'group'/)
assert.match(tg, /transcribeAudio\([\s\S]*agent\?\.default_lang[\s\S]*agent\?\.stt_model/)
assert.match(taskbot, /msg\.chat\?\.type === 'private'/)
assert.match(sttMigration, /ovozify-whisper-small-uz/)
assert.match(sttMigration, /gemini-openrouter/)
assert.match(agentStore, /stt_model: a\.sttModel/)
assert.match(agentEditor, /Ovozify Whisper Small UZ/)

globalThis.Deno = { env: { get: () => '' } }
const { parseGradioSse } = await import('../supabase/functions/_shared/transcribe.ts')
assert.equal(parseGradioSse('event: complete\ndata: ["salom dunyo"]\n'), 'salom dunyo')
assert.equal(
  parseGradioSse('event: complete\ndata: ["[Audio duration: 31.2s - Processed in 2 chunks]\\n\\nassalomu alaykum"]\n'),
  'assalomu alaykum',
)

console.log('Telegram worker contracts passed: atomic queue, self-healing lease, chat routing and selectable Uzbek STT.')
