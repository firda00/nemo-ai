// Agent Trace UI assertions (permanent, wired into the quality gate).
// Boots the app in DEMO mode and verifies the operator-facing trace rendering
// contract on /app/dialogues against the seeded dialogue d1, which carries a
// runtime-shape system_trace message (version 1, replyMessageId -> m4):
//   1. the TraceCard renders (UZ default label), with exactly one tile per step;
//   2. the card is ATTACHED to its reply — in DOM between reply m4 and message m5,
//      not at the trace row's own position or duplicated;
//   3. step content comes from the parsed trace (agents, consult task, localized
//      kind labels), not fabricated defaults;
//   4. raw trace JSON never leaks into the conversation as a chat bubble;
//   5. the dialogue list preview shows the last CHAT message, never trace JSON;
//   6. a dialogue without a trace renders no TraceCard.
// Run: npm run test:trace-ui   (exits non-zero on any failure)
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const baseUrl = 'http://127.0.0.1:4175'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'trace-ui')
fs.mkdirSync(artifacts, { recursive: true })

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4175', '--strictPort']
const server = spawn(command, args, {
  cwd: root,
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, // force DEMO mode
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let serverLog = ''
server.stdout.on('data', (chunk) => { serverLog += chunk.toString() })
server.stderr.on('data', (chunk) => { serverLog += chunk.toString() })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    if (server.exitCode !== null) throw new Error(`Vite exited early.\n${serverLog.slice(-2000)}`)
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {}
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${baseUrl}.\n${serverLog.slice(-2000)}`)
}

function stopServer() {
  if (server.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
  else server.kill('SIGTERM')
}

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

let browser
let page
try {
  await waitForServer()
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  const runtimeErrors = []
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/i.test(message.text())) runtimeErrors.push(`console: ${message.text()}`)
  })

  await page.goto(baseUrl + '/', { waitUntil: 'networkidle0', timeout: 30_000 })
  await page.evaluate(() => {
    localStorage.setItem('nemo.lang', 'uz') // assertions target the UZ labels; without this the i18n default is EN
    localStorage.setItem('nemo.user', JSON.stringify({
      id: 'trace-smoke', email: 'trace@nemo.local', name: 'Trace Smoke', lang: 'uz', role: 'user', onboardingCompleted: true, createdAt: '2026-07-10', quotaUsed: 0, quotaLimit: 100,
    }))
  })
  await page.goto(baseUrl + '/app/dialogues', { waitUntil: 'networkidle0', timeout: 30_000 })

  // d1 is auto-selected in demo mode; inspect the rendered conversation
  const r = await page.evaluate(() => {
    const label = [...document.querySelectorAll('p')].find((p) => (p.textContent ?? '').trim().startsWith('Agentlar izi'))
    const card = label?.closest('div.rounded-2xl') ?? null
    const conv = label?.closest('.space-y-3') ?? null
    const convText = conv?.innerText ?? ''
    const firstListItem = document.querySelector('aside ul li button')
    return {
      cardFound: Boolean(card),
      cardCount: [...document.querySelectorAll('p')].filter((p) => (p.textContent ?? '').trim().startsWith('Agentlar izi')).length,
      stepTiles: card ? card.querySelectorAll('div.rounded-xl').length : 0,
      cardText: card?.innerText ?? '',
      convText,
      idxReply: convText.indexOf('Dasturlash kursi oyiga'),
      idxTrace: convText.indexOf('Agentlar izi'),
      idxNext: convText.indexOf('Ha, yuboring'),
      previewText: firstListItem?.innerText ?? '',
    }
  })

  check('TraceCard renders for the seeded trace dialogue', r.cardFound)
  check('exactly one TraceCard (no duplicate/orphan copy)', r.cardCount === 1, `found ${r.cardCount}`)
  check('one tile per trace step (3)', r.stepTiles === 3, `found ${r.stepTiles}`)
  check(
    'card is attached between its reply (m4) and the next message (m5)',
    r.idxReply !== -1 && r.idxTrace !== -1 && r.idxNext !== -1 && r.idxReply < r.idxTrace && r.idxTrace < r.idxNext,
    `order reply=${r.idxReply} trace=${r.idxTrace} next=${r.idxNext}`
  )
  check('steps show the real trace agents', r.cardText.includes('Sotuv agenti') && r.cardText.includes('Kurs mutaxassisi'))
  check('consult step shows its task text', r.cardText.includes('Dasturlash kursi narxi va chegirmalarini aniqlash'))
  check(
    'lead/synthesize steps use localized kind labels',
    r.cardText.includes('Yetakchi vazifani mutaxassislarga bo‘lib berdi') && r.cardText.includes('Mutaxassislar javobini yakuniy javobga birlashtirdi')
  )
  check(
    'raw trace JSON never renders in the conversation',
    !r.convText.includes('replyMessageId') && !r.convText.includes('"version"') && !r.convText.includes('system_trace')
  )
  check(
    'list preview shows the last chat message, not trace JSON',
    r.previewText.includes('Ha, yuboring') && !r.previewText.includes('replyMessageId') && !r.previewText.includes('"version"')
  )

  // a dialogue without a trace must not render a TraceCard
  const noTrace = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('aside ul li button')].find((b) => (b.innerText ?? '').includes('Malika'))
    if (!btn) return null
    btn.click()
    return true
  })
  check('trace-free dialogue selectable (d2 present in list)', noTrace === true)
  if (noTrace) {
    await delay(300)
    const cards = await page.evaluate(() => [...document.querySelectorAll('p')].filter((p) => (p.textContent ?? '').trim().startsWith('Agentlar izi')).length)
    check('no TraceCard on a dialogue without a trace', cards === 0, `found ${cards}`)
  }

  if (runtimeErrors.length) {
    failed += 1
    console.error(`[FAIL] browser runtime errors:\n${[...new Set(runtimeErrors)].join('\n')}`)
  }
  if (failed) throw new Error(`${failed} trace UI assertion(s) failed.`)
  console.log('All Agent Trace UI assertions passed.')
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
  fs.writeFileSync(path.join(artifacts, 'server.log'), serverLog)
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  stopServer()
}
