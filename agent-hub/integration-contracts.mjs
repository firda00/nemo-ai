import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '')
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

const data = read('src/data/integrations.ts')
const page = read('src/pages/app/IntegrationsPage.tsx')
const store = read('src/store/useIntegrationStore.ts')
const toolsPage = read('src/pages/app/IntegrationsToolsPage.tsx')
const provider = read('supabase/functions/connect-provider/index.ts')
const backendStatus = read('supabase/functions/backend-status/index.ts')

check('integration store has no demo-connected seed', !/:\s*'connected'/.test(store.match(/const seed[\s\S]*?\n\}/)?.[0] ?? 'connected'))
check('main catalog removed the fake widget snippet', !/cdn\.nemo\.ai|ag_demo/.test(page) && /data-channel/.test(page))
check('main catalog has no timer-simulated OAuth', !/setTimeout\(\(\) => finishConnect/.test(page))
check('main catalog hydrates provider, Google and channel state from backend', /connect-provider/.test(page) && /google-oauth/.test(page) && /from\('channels'\)/.test(page))
check('disconnect mutates the real backend', /action: 'disconnect'/.test(page) && /from\('channels'\)\.delete/.test(page))
check('widget is connected to a selected real agent', /def\.id === 'widget'/.test(page) && /channel_id/.test(page) && /needsAgent[\s\S]*widget/.test(page))
check('Meta channels are not advertised live without production signature secret', /id: 'whatsapp'[^\n]+status: 'soon'/.test(data) && /id: 'instagram'[^\n]+status: 'soon'/.test(data))

const setupOnly = ['vapi', 'did', 'synthesia', 'stability', 'uzum', 'kaspi']
for (const id of setupOnly) check(`${id} is visibly unavailable until it has an executor`, new RegExp(`id: '${id}'[^\n]+implemented: false`).test(toolsPage))
check('setup-only providers cannot be connected', /implemented === false\) return/.test(toolsPage))
check('provider dictionary rejects prototype-property ids', /Object\.prototype\.hasOwnProperty\.call\(PROVIDERS, id\)/.test(provider))
check('provider keys are reported as secure write-only storage', /providerKeysSecure: true/.test(backendStatus))
check('saved provider key is labelled as saved, not provider-verified', /ключ сохранён/.test(read('src/i18n/extra.ts')) && /run the real test below/.test(read('src/i18n/extra.ts')))

const implementedConsumers = {
  github: "github_create_issue",
  stripe: "stripe_create_customer",
  hubspot: "hubspot_create_contact",
  amocrm: "amocrm_create_lead",
  bitrix24: "bitrix24_create_lead",
  notion: "notion_create_page",
  slack: "slack_send_message",
  hyperbrowser: "browser_task",
  elevenlabs: "provider === 'elevenlabs'",
  heygen: "eq('provider', 'heygen')",
  replicate: "provider: 'replicate'",
  wildberries: "wb_products",
  ozon: "ozon_products",
  airtable: "airtable_create_record",
  bland: "eq('provider', 'bland')",
}
const runtimeText = [
  read('supabase/functions/_shared/tools.ts'),
  read('supabase/functions/generate-voice/index.ts'),
  read('supabase/functions/generate-avatar/index.ts'),
  read('supabase/functions/generate-video/index.ts'),
  read('supabase/functions/make-call/index.ts'),
].join('\n')
for (const [id, needle] of Object.entries(implementedConsumers)) check(`${id} has a real runtime consumer`, runtimeText.includes(needle))

if (failed) {
  console.error(`${failed} integration contract(s) failed.`)
  process.exit(1)
}
console.log('Integration truthfulness contracts passed.')
