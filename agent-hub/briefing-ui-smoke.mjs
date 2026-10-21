// Daily-briefing panel — DEMO MOUNT smoke ONLY (permanent, wired into the quality gate).
// SCOPE: this proves mounting, routing and central-i18n rendering in the app shell. It does NOT
// exercise the form (demo mode renders no controls) — form load/save/reconcile behavior against a
// mocked backend lives in agent-hub/briefing-form-smoke.mjs.
// Boots the app in DEMO mode (same bootstrapping as trace-ui-smoke) and verifies the panel as
// the user actually meets it on /app/settings (profile tab):
//   1. the panel mounts exactly once, with its UZ title (default language);
//   2. the copy tells the truth about scope: delivery is NOT active yet (UZ), and the demo state
//      renders the explicit demo note instead of a dead form;
//   3. no settings form controls render in demo mode (the panel must not pretend to work);
//   4. switching to RU re-renders the mounted panel through central i18n (title + the
//      "delivery not enabled yet" sentence), proving the strings come from the dictionary;
//   5. the page produces no runtime/console errors while doing all of the above.
// Behavior flows (load/save/reconcile/timeouts) are covered by tests/daily_briefing_endpoint.test.ts
// against the injected helpers; this smoke pins the MOUNTED integration the unit tests cannot see.
// Run: npm run test:briefing-ui   (exits non-zero on any failure)
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const baseUrl = 'http://127.0.0.1:4179'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'briefing-ui')
fs.mkdirSync(artifacts, { recursive: true })

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4179 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4179', '--strictPort']
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
    } catch { /* not up yet */ }
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

  let lastGotoErr
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(baseUrl + '/', { waitUntil: 'networkidle0', timeout: 30_000 })
      lastGotoErr = null
      break
    } catch (err) {
      lastGotoErr = err
      await delay(500)
    }
  }
  if (lastGotoErr) throw lastGotoErr
  await page.evaluate(() => {
    localStorage.setItem('nemo.lang', 'uz')
    localStorage.setItem('nemo.user', JSON.stringify({
      id: 'briefing-smoke', email: 'briefing@nemo.local', name: 'Briefing Smoke', lang: 'uz', role: 'user', onboardingCompleted: true, createdAt: '2026-09-01', quotaUsed: 0, quotaLimit: 100,
    }))
  })
  await page.goto(baseUrl + '/app/settings', { waitUntil: 'networkidle0', timeout: 30_000 })

  const uz = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('h2')].filter((h) => (h.textContent ?? '').trim() === 'Kundalik brifing')
    const section = titles[0]?.closest('section') ?? null
    const text = section?.innerText ?? ''
    return {
      titleCount: titles.length,
      text,
      hasCheckbox: Boolean(section?.querySelector('input[type="checkbox"]')),
      hasSelect: Boolean(section?.querySelector('select')),
    }
  })
  check('panel mounts exactly once on /app/settings', uz.titleCount === 1, `found ${uz.titleCount}`)
  check('UZ description renders from central i18n', uz.text.includes('kun yakunlari'))
  check('demo mode shows the explicit demo note', uz.text.includes('Demo rejimida brifing sozlamalari mavjud emas.'))
  check('demo mode renders NO settings controls (the panel must not pretend to work)', !uz.hasCheckbox && !uz.hasSelect)

  await page.evaluate(() => localStorage.setItem('nemo.lang', 'ru'))
  await page.goto(baseUrl + '/app/settings', { waitUntil: 'networkidle0', timeout: 30_000 })
  const ru = await page.evaluate(() => {
    const title = [...document.querySelectorAll('h2')].find((h) => (h.textContent ?? '').trim() === 'Ежедневный брифинг')
    return { found: Boolean(title), text: title?.closest('section')?.innerText ?? '' }
  })
  check('RU re-render comes from central i18n (title)', ru.found)
  check('RU description renders from central i18n', ru.text.includes('итоги дня'))

  check('no runtime/console errors while mounting the panel', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] briefing-ui-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'settings-briefing.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
  stopServer()
}

if (failed > 0) { console.error(`briefing-ui-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Briefing panel DEMO-MOUNT smoke passed (form behavior: briefing-form-smoke.mjs).')
