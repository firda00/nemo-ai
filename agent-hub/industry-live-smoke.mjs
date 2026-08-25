import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))), '..')
const secrets = Object.fromEntries(fs.readFileSync(path.join(root, '.secrets.local'), 'utf8').split(/\r?\n/).map((line) => {
  const at = line.indexOf('=')
  return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['', '']
}).filter(([key]) => key))

const ref = secrets.SUPABASE_PROJECT_REF
const secretKey = secrets.SUPABASE_SECRET_KEY
const publishableKey = secrets.SUPABASE_PUBLISHABLE_KEY
if (!ref || !secretKey || !publishableKey) throw new Error('Supabase smoke credentials are not configured.')

const baseUrl = (process.env.NEMO_LIVE_URL || 'https://nemo-ai-swart.vercel.app').replace(/\/$/, '')
const supabaseUrl = `https://${ref}.supabase.co`
const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
const client = createClient(supabaseUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `nemo-industry-smoke-${Date.now()}@example.com`
// Ephemeral per-run credential for the synthetic account; never persisted or logged.
const smokeCredential = `${randomUUID()}Aa1!`
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'industry-live-smoke')
fs.mkdirSync(artifacts, { recursive: true })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let userId = ''
let accountId = ''
let browser
let page

async function waitForAccount() {
  for (let index = 0; index < 24; index += 1) {
    const { data } = await admin.from('users').select('account_id').eq('id', userId).maybeSingle()
    if (data?.account_id) return data.account_id
    await delay(250)
  }
  throw new Error('temporary account trigger did not finish')
}

async function openTemplates() {
  await page.goto(`${baseUrl}/app/templates`, { waitUntil: 'networkidle2', timeout: 30_000 })
  await page.waitForFunction(() => document.body.innerText.includes('Hotel & Tourism Guest Team'), { timeout: 20_000 })
}

async function createFromCard(title) {
  const clicked = await page.evaluate((wanted) => {
    const heading = [...document.querySelectorAll('h2')].find((node) => node.textContent?.trim() === wanted)
    const card = heading?.closest('.card')
    const button = card?.querySelector('button')
    if (!(button instanceof HTMLButtonElement)) return false
    button.click()
    return true
  }, title)
  if (!clicked) throw new Error(`template card not clickable: ${title}`)
  await page.waitForFunction(() => location.pathname.startsWith('/app/teams/'), { timeout: 30_000 })
  await page.waitForFunction(
    (expectedTitle) => [...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === expectedTitle),
    { timeout: 30_000 },
    title,
  )
  return new URL(page.url()).pathname.split('/').filter(Boolean).pop()
}

try {
  const created = await admin.auth.admin.createUser({ email, password: [smokeCredential][0], email_confirm: true, user_metadata: { name: 'Industry Live Smoke' } })
  if (created.error || !created.data.user) throw new Error(`temporary user creation failed: ${created.error?.message ?? 'missing user'}`)
  userId = created.data.user.id
  accountId = await waitForAccount()

  const signed = await client.auth.signInWithPassword({ email, password: [smokeCredential][0] })
  if (signed.error || !signed.data.session) throw new Error(`temporary sign-in failed: ${signed.error?.message ?? 'missing session'}`)

  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  const runtimeErrors = []
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/i.test(message.text())) {
      const location = message.location()
      runtimeErrors.push(`console${location.url ? ` (${location.url})` : ''}: ${message.text()}`)
    }
  })

  await page.goto(`${baseUrl}/auth`, { waitUntil: 'networkidle2', timeout: 30_000 })
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'en'))
  await page.reload({ waitUntil: 'networkidle2' })
  await page.type('input[type="email"]', email)
  await page.type('input[type="password"]', smokeCredential)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => location.pathname.startsWith('/app'), { timeout: 30_000 })

  await openTemplates()
  const tourismId = await createFromCard('Hotel & Tourism Guest Team')
  const tourismText = await page.evaluate(() => document.body.innerText)
  const tourismSpecialists = ['Guest Intake Agent', 'Experience Consultant', 'Booking Coordinator', 'Guest Service Coordinator', 'Guest Operations Reporter']
  if (!tourismSpecialists.every((name) => tourismText.includes(name))) throw new Error('tourism team did not render all five saved specialists')
  if (!tourismText.includes('Capture') || !tourismText.includes('Route') || !tourismText.includes('Deliver')) throw new Error('tourism team did not use the general workflow coordinator')
  if (tourismText.includes('Планёрка как рабочая доска')) throw new Error('tourism team was incorrectly routed to Planerka')
  if (!tourismId) throw new Error('tourism team id is missing')

  await openTemplates()
  const clinicId = await createFromCard('Clinic Front Desk Team')
  const clinicText = await page.evaluate(() => document.body.innerText)
  if (!clinicText.includes('Safety beta · Nemo only')) throw new Error('clinic safety tier is not visible')
  if (!clinicText.includes('Live channel connection is blocked in this beta')) throw new Error('clinic live-channel block is not visible')
  const clinicTokenInputs = await page.$$eval('input', (inputs) => inputs.filter((input) => /123456789:AAH/i.test(input.getAttribute('placeholder') ?? '')).length)
  if (clinicTokenInputs !== 0) throw new Error('clinic Telegram token input is still available')

  const blocked = await fetch(`${supabaseUrl}/functions/v1/connect-channel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signed.data.session.access_token}`,
      apikey: publishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agent_id: clinicId, type: 'widget', credentials: {} }),
  })
  const blockedBody = await blocked.json().catch(() => ({}))
  if (blocked.status !== 403 || blockedBody.code !== 'REGULATED_CHANNEL_BLOCKED') {
    throw new Error(`regulated channel endpoint was not blocked (status ${blocked.status})`)
  }

  const directChannel = await client.from('channels').insert({ agent_id: clinicId, type: 'widget', credentials: {}, status: 'connected' })
  if (!directChannel.error || directChannel.error.code !== '42501') throw new Error('database trigger did not block a direct regulated channel insert')

  const downgrade = await client.from('agents').update({ risk_tier: 'standard' }).eq('id', clinicId)
  if (!downgrade.error || downgrade.error.code !== '42501') throw new Error('database trigger allowed regulated risk tier downgrade')

  const { data: promoteAgent, error: promoteAgentError } = await client.from('agents').insert({
    account_id: accountId,
    name: 'Risk quarantine smoke',
    type: 'workflow',
    prompt: { role: 'smoke', tasks: 'smoke', tone: 'neutral', rules: 'no external action' },
    risk_tier: 'standard',
  }).select('id').single()
  if (promoteAgentError || !promoteAgent) throw new Error(`quarantine agent setup failed: ${promoteAgentError?.message ?? 'missing row'}`)
  const { data: promoteChannel, error: promoteChannelError } = await client.from('channels').insert({
    agent_id: promoteAgent.id,
    type: 'telegram',
    credentials: { bot_token: 'live-smoke-token' },
    status: 'connected',
  }).select('id').single()
  if (promoteChannelError || !promoteChannel) throw new Error(`quarantine channel setup failed: ${promoteChannelError?.message ?? 'missing row'}`)
  const promoted = await client.from('agents').update({ template_key: 'clinic-front-desk' }).eq('id', promoteAgent.id)
  if (promoted.error) throw new Error(`regulated promotion failed: ${promoted.error.message}`)
  const { data: quarantined } = await admin.from('channels').select('status, credentials, quarantined_credentials').eq('id', promoteChannel.id).single()
  if (quarantined?.status !== 'safety_blocked' || Object.keys(quarantined?.credentials ?? {}).length !== 0 || quarantined?.quarantined_credentials?.bot_token !== 'live-smoke-token') {
    throw new Error('existing channel credentials were not quarantined safely')
  }
  const restoreCredentials = await client.from('channels').update({ credentials: { bot_token: 'restore-attempt' } }).eq('id', promoteChannel.id)
  if (!restoreCredentials.error || restoreCredentials.error.code !== '42501') throw new Error('regulated channel credentials could be restored directly')

  if (runtimeErrors.length) throw new Error(`browser runtime errors:\n${[...new Set(runtimeErrors)].join('\n')}`)
  console.log('Industry live smoke passed: tourism persistence/general routing plus clinic UI, API, RLS, immutable-risk and credential-quarantine blocks verified.')
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {})
  if (accountId) await admin.from('accounts').delete().eq('id', accountId)
}
