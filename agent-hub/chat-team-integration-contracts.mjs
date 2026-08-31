import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const factory = read('src/lib/chatEntityFactory.ts')
const desk = read('src/components/platform/SmartTaskDesk.tsx')
const room = read('src/pages/app/TeamDetailPage.tsx')
const integrations = read('src/components/settings/IntegrationCenter.tsx')
const provider = read('supabase/functions/connect-provider/index.ts')
const settings = read('src/pages/app/SettingsPage.tsx')

assert.match(factory, /classifyChatEntityIntent/)
assert.match(factory, /saveDynamicTeam/)
assert.match(factory, /kind === 'agent'/)
assert.match(factory, /nemo-team-blueprint:/)
assert.match(desk, /createEntityFromChat/)
assert.match(desk, /TeamArtifact/)
assert.match(desk, /TeamRunArtifact/)
assert.match(desk, /<AutonomousRunner/)
assert.match(desk, /\/app\/teams\//)
assert.match(room, /nemo-team-blueprint:/)

for (const id of ['telegram', 'google_workspace', 'uzum', 'moysklad', 'amocrm', 'custom_webhook']) {
  assert.match(integrations, new RegExp(`['\"]${id}['\"]`), `missing ${id} integration UI`)
  assert.match(provider, new RegExp(`${id}:`), `missing ${id} server provider`)
}
assert.match(provider, /sealSecret\(key, providerSecretContext/)
assert.match(provider, /select\('provider'\)/)
assert.doesNotMatch(provider, /select\(['"]api_key['"]\)/)
assert.match(provider, /api\.telegram\.org\/bot\$\{encodeURIComponent\(key\)\}\/getMe/)
assert.match(settings, /<BillingPage embedded/)

console.log('[OK] Chat team creation, scoped execution, encrypted integrations, and billing contracts')
