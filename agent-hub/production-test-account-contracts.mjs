import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20260803160000_production_test_account.sql')
const provision = read('agent-hub/provision-production-test-account.ps1')
const smoke = read('agent-hub/production-test-account-smoke.ps1')
const egressGuard = read('supabase/functions/_shared/productionE2E.ts')
const deploy = read('deploy.ps1')
const deploymentManifest = JSON.parse(read('supabase/functions/deployment-manifest.json'))

assert.match(migration, /is_production_e2e boolean not null default false/)
assert.match(migration, /create unique index[\s\S]*where is_production_e2e/, 'only one production test tenant may exist')
assert.match(migration, /revoke update\(is_production_e2e\)[\s\S]*from anon, authenticated/)
assert.match(migration, /external credentials are disabled for the production test account/)
assert.match(migration, /marketing is disabled for the production test account/)
for (const table of ['provider_keys', 'google_accounts', 'google_oauth_apps', 'social_accounts', 'custom_tools', 'scheduled_posts', 'follow_ups', 'watched_sources', 'channels']) {
  assert.ok(migration.includes(`'${table}'`), `${table} must be guarded for the test tenant`)
}
assert.match(provision, /RNGCryptoServiceProvider/, 'test password must use a cryptographic RNG')
assert.match(provision, /NEMO_E2E_PASSWORD/)
assert.doesNotMatch(provision, /Write-Host.*\$(?:email|password|session|token)/i, 'credentials must never be printed')
assert.match(provision, /marketing_email = \$false; marketing_telegram = \$false/)
assert.match(provision, /action_policy = 'read_only'/)
assert.match(smoke, /Refusing to test an unmarked account/)
assert.match(smoke, /action_policy = 'read_only'/)
assert.match(smoke, /Method Delete[\s\S]*Method Delete/, 'synthetic team rows must be cleaned after smoke')
assert.doesNotMatch(smoke, /Write-Host.*\$(?:email|password|session|token)/i)
assert.match(egressGuard, /return Boolean\(error \|\| !data \|\| data\.is_production_e2e === true\)/, 'egress classification must fail closed')
assert.match(smoke, /PRODUCTION_E2E_EXTERNAL_BLOCKED/)
for (const fn of ['connect-provider', 'connect-telegram', 'connect-channel', 'connect-social', 'google-oauth', 'create-checkout', 'make-call', 'browser-task', 'connect-model', 'custom-tools', 'agent-tool', 'crm-push', 'operator-send', 'autopost', 'follow-up', 'setup-telegram', 'setup-meta', 'google-tools', 'create-planerka-sheet', 'watch-sources', 'ops-workflow', 'generate-image', 'content-visual', 'generate-video', 'generate-avatar', 'generate-voice', 'render-video', 'transcribe-file']) {
  const source = read(`supabase/functions/${fn}/index.ts`)
  assert.match(source, /blocksExternalActions/, `${fn} must apply the production test egress kill switch`)
}
for (const shared of ['tools', 'agent', 'automationEngine']) {
  assert.match(read(`supabase/functions/_shared/${shared}.ts`), /blocksExternalActions/, `${shared} must apply the production test egress kill switch`)
}
const agentRuntime = read('supabase/functions/_shared/agent.ts')
assert.match(agentRuntime, /notifyEscalation[\s\S]*blocksExternalActions[\s\S]*tgSend/, 'escalation delivery must apply the kill switch')
for (const fn of ['telegram-webhook', 'whatsapp-webhook', 'instagram-webhook', 'agent-worker', 'daily-digest', 'morning-brief', 'weekly-report', 'support-sla', 'task-reminders', 'ops-autopilot', 'send-broadcast']) {
  assert.match(read(`supabase/functions/${fn}/index.ts`), /blocksExternalActions/, `${fn} must reject production test account delivery`)
}
const qtest = read('supabase/functions/qtest/index.ts')
assert.match(qtest, /QTEST_ENABLED.*!== 'true'/, 'the staging load rig must be disabled by default')
assert.match(qtest, /x-qtest-secret/, 'an enabled load rig must require a dedicated secret')
assert.match(smoke, /connect-model[\s\S]*custom-tools[\s\S]*agent-tool[\s\S]*crm-push[\s\S]*autopost[\s\S]*follow-up/, 'live smoke must cover indirect and scheduled egress paths')
for (const fn of ['knowledge-index', 'media-poll', 'browser-bridge']) {
  assert.ok(deploymentManifest.public.includes(fn), `${fn} must bypass gateway JWT verification`)
  assert.ok(!deploymentManifest.authenticated.includes(fn), `${fn} must not be deployed as JWT-only`)
}
assert.match(deploy, /\$edgeManifest\.public/)
assert.match(deploy, /11 = \([\s\S]*count\(distinct cls\.relname\)[\s\S]*trg\.tgenabled <> 'D'/, 'deployment must verify every enabled production E2E database trigger')

console.log('Production test account contracts passed.')
