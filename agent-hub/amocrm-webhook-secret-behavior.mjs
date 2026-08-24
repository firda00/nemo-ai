import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  generateWebhookSecret,
  normalizeAmoSubdomain,
  normalizeGatewayOrigin,
  sha256Hex,
  webhookUrl,
} from '../supabase/functions/_shared/amocrmWebhookSecret.ts'

let checks = 0
const check = (fn) => { fn(); checks += 1 }
const checkAsync = async (fn) => { await fn(); checks += 1 }

check(() => assert.equal(normalizeAmoSubdomain('https://Demo-Company.amocrm.ru/'), 'demo-company'))
check(() => assert.throws(() => normalizeAmoSubdomain('victim.example.com'), /invalid_amocrm_subdomain/))

const deterministic = Uint8Array.from({ length: 32 }, (_, index) => index)
const secret = generateWebhookSecret(deterministic)
check(() => assert.equal(secret.length, 43))
check(() => assert.match(secret, /^[A-Za-z0-9_-]{43}$/))
check(() => assert.equal(secret.includes('='), false))
check(() => assert.throws(() => generateWebhookSecret(new Uint8Array(31)), /requires_32_bytes/))

await checkAsync(async () => {
  assert.equal(await sha256Hex(secret), 'ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0')
})

check(() => assert.equal(normalizeGatewayOrigin('https://gateway.nemoai.uz/'), 'https://gateway.nemoai.uz'))
check(() => assert.throws(() => normalizeGatewayOrigin('http://gateway.nemoai.uz'), /invalid_gateway_origin/))
check(() => assert.throws(() => normalizeGatewayOrigin('https://gateway.nemoai.uz/path'), /invalid_gateway_origin/))
check(() => assert.equal(
  webhookUrl('https://gateway.nemoai.uz', secret),
  `https://gateway.nemoai.uz/v1/crm/amocrm/webhook/${secret}`,
))

const root = path.resolve(import.meta.dirname, '..')
const edge = fs.readFileSync(path.join(root, 'supabase/functions/amocrm-webhook-secret/index.ts'), 'utf8')
check(() => assert.match(edge, /profile\.role !== 'owner' && profile\.is_admin !== true/))
check(() => assert.match(edge, /'Cache-Control': 'no-store, max-age=0'/))
check(() => assert.equal((edge.match(/webhook_url:/g) ?? []).length, 1, 'URL is returned only by rotate'))
check(() => assert.equal(/console\.(?:log|error|warn)/.test(edge), false, 'secret lifecycle must not log'))

console.log(`[OK] amoCRM webhook secret behavior: ${checks}/${checks}`)
