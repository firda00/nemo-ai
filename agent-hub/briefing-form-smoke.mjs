// Daily-briefing panel — MOUNTED FORM smoke against a mocked backend (permanent, in the gate).
// Complements briefing-ui-smoke.mjs (demo mount only): here the REAL component runs with the
// REAL bounded helpers and real i18n, with src/lib/supabase aliased by esbuild to a
// scenario-driven mock. Verifies the component-state wiring the unit tests cannot see:
//   1. a configured account renders the real form, the unverified badge and the truthful
//      "starts after verification" delivery line — never a premature "verified";
//   2. the verify flow: the button issues a claim, shows the deep link AND the manual payload;
//      a save clears the (now stale) link; once the server reports verified, the badge flips,
//      the link disappears and the delivery line names ONLY the saved kinds;
//   3. flag-aware copy: both kinds off → "not selected"; the kill-switch off → "disabled";
//   4. a double-clicked save dispatches exactly ONE settings-set write (busyRef, mounted);
//   5. save_outcome_unknown reconciles with the honest reload message;
//   6. owner_required renders nothing at all (server-driven role gate);
//   7. delivery history and recorded outcomes render from their RLS reads;
//   8. a hung channels query releases loading at the client deadline with the truthful note.
// Offline: no vite server, no network — a built bundle served from file:// (about:blank denies
// localStorage, which the real i18n provider reads). No paid calls.
// Run: npm run test:briefing-form   (exits non-zero on any failure)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'briefing-form')
fs.mkdirSync(artifacts, { recursive: true })
// the GENERATED bundle lives outside the repo so no lint pass ever scans bundled deps
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-briefing-form-'))
const bundlePath = path.join(buildDir, 'harness.js')
const mockPath = path.join(root, 'agent-hub', 'briefing-harness', 'mock-supabase.ts')
const supabaseReal = path.join(root, 'src', 'lib', 'supabase')

await esbuild.build({
  entryPoints: [path.join(root, 'agent-hub', 'briefing-harness', 'entry.tsx')],
  bundle: true,
  outfile: bundlePath,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
  plugins: [{
    name: 'mock-supabase',
    setup(build) {
      build.onResolve({ filter: /supabase$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path)
        return resolved === supabaseReal ? { path: mockPath } : undefined
      })
    },
  }],
})

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let browser
let page
const runtimeErrors = []
try {
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
  // about:blank denies localStorage (the real i18n provider reads it) — serve from file://
  const htmlPath = path.join(buildDir, 'harness.html')
  fs.writeFileSync(htmlPath, '<!doctype html><html><body><div id="root"></div><script src="harness.js"></script></body></html>')
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 15_000 })
  await page.waitForFunction('globalThis.__harnessReady === true', { timeout: 10_000 })

  const CHANNEL = '11111111-2222-4333-8444-555555555555'
  const CONFIGURED = {
    morning_enabled: true, evening_enabled: false,
    notify_channel_id: CHANNEL, notify_chat_id: null,
    recipient_status: 'configured', recipient_verified: false,
  }
  const mount = (scenario) => page.evaluate((s) => { globalThis.__mount(s) }, scenario)
  const calls = (action) => page.evaluate((a) =>
    globalThis.__briefingCalls.filter((c) => c.kind === 'invoke' && c.action === a).length, action)
  const panelText = () => page.evaluate(() => document.getElementById('root')?.innerText ?? '')
  const clickButton = (label) => page.evaluate((text) => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text)
    if (!button) throw new Error(`button not found: ${text}`)
    button.click()
  }, label)
  const waitForm = () => page.waitForFunction(() => document.querySelector('input[type="checkbox"]'), { timeout: 5_000 })

  // 1) configured + morning-only: form, unverified badge, truthful delivery line
  await mount({ settings: CONFIGURED })
  await waitForm()
  let text = await panelText()
  check('configured account renders the real form with the bot list', text.includes('Sales bot'))
  check('badge is configured-NOT-verified, never a premature verified',
    text.includes('(tasdiqlanmagan)') && !text.includes('Qabul qiluvchi tasdiqlangan'))
  check('delivery line says it starts after verification', text.includes('tasdiqlangach boshlanadi'))

  // 2) verify flow: issue → stale link cleared by save → re-issue → verified flips everything
  await clickButton('Qabul qiluvchini tasdiqlash')
  await page.waitForFunction(() => (document.getElementById('root')?.innerText ?? '').includes('/start brf_'), { timeout: 5_000 })
  text = await panelText()
  check('verify issues a claim and shows deep link AND manual payload',
    await calls('verify-recipient') === 1 && text.includes('t.me/MockBriefingBot') && text.includes('/start brf_'))
  await clickButton('Saqlash')
  await delay(400)
  check('a save invalidates and CLEARS the outstanding link', !(await panelText()).includes('/start brf_'))
  await clickButton('Qabul qiluvchini tasdiqlash')
  await page.waitForFunction(() => (document.getElementById('root')?.innerText ?? '').includes('/start brf_'), { timeout: 5_000 })
  await page.evaluate(() => {
    globalThis.__briefing.settings = { ...globalThis.__briefing.settings, recipient_verified: true }
  })
  await clickButton('Holatni yangilash')
  await page.waitForFunction(() => (document.getElementById('root')?.innerText ?? '').includes('Qabul qiluvchi tasdiqlangan'), { timeout: 5_000 })
  text = await panelText()
  check('verified: badge flips and the consumed link disappears', !text.includes('/start brf_'))
  check('delivery line names ONLY the saved kind (morning)',
    text.includes('ertalab 08:30 (Toshkent)') && !text.includes('kechqurun 20:00 (Toshkent)'))

  // 3) flag-aware copy: both off → not selected; kill-switch off → disabled
  await mount({ settings: { ...CONFIGURED, morning_enabled: false, recipient_verified: true } })
  await waitForm()
  check('verified with BOTH kinds off says "not selected", not "active"', (await panelText()).includes('tanlanmagan'))
  await mount({ settings: { ...CONFIGURED, recipient_verified: true }, deliveryEnabled: false })
  await waitForm()
  check('the kill-switch renders as administratively disabled', (await panelText()).includes('o‘chirilgan'))

  // 4) double-click = exactly one write
  await mount({ settings: { ...CONFIGURED, morning_enabled: false, notify_channel_id: null, recipient_status: 'not_configured' }, saveMode: 'slow-ok' })
  await waitForm()
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Saqlash')
    save.click(); save.click() // second click lands before the first request resolves
  })
  await delay(700)
  check('a double-clicked save dispatches exactly ONE settings-set', await calls('settings-set') === 1, `got ${await calls('settings-set')}`)
  check('the saved confirmation renders', (await panelText()).includes('Saqlangan.'))

  // 5) save_outcome_unknown reconciles by reloading
  await mount({ settings: { ...CONFIGURED, morning_enabled: false, notify_channel_id: null, recipient_status: 'not_configured' }, saveMode: 'unknown' })
  await waitForm()
  await clickButton('Saqlash')
  await page.waitForFunction(() => (document.getElementById('root')?.innerText ?? '').includes('noma’lum'), { timeout: 5_000 })
  check('unknown-save reloads the server state (settings-get twice)', await calls('settings-get') >= 2, `got ${await calls('settings-get')}`)
  check('the message says the outcome is unknown and the state was reloaded', (await panelText()).includes('qayta yuklandi'))

  // 6) owner_required renders nothing (server-driven role gate)
  await mount({ forbidden: true })
  await delay(400)
  check('an operator (owner_required) sees no panel at all', !(await panelText()).includes('Kundalik brifing'))

  // 7) history + outcomes render from their reads
  await mount({
    settings: { ...CONFIGURED, recipient_verified: true },
    runs: [{ kind: 'morning', run_date: '2026-09-05', status: 'sent' }, { kind: 'evening', run_date: '2026-09-04', status: 'unknown' }],
    outcomes: [{ run_date: '2026-09-04', text: 'Сделали три задачи, перенесли одну.' }],
  })
  await waitForm()
  text = await panelText()
  check('delivery history renders with localized statuses', text.includes('yuborildi') && text.includes('noma’lum'))
  check('recorded outcomes render', text.includes('Сделали три задачи'))

  // 8) hung channels releases at the client deadline with the truthful note (~20s)
  await mount({ settings: CONFIGURED, channelsMode: 'hang' })
  await page.waitForFunction(
    () => (document.getElementById('root')?.innerText ?? '').includes('Bot ro‘yxatini yuklab bo‘lmadi'),
    { timeout: 25_000 },
  )
  check('a hung channels query releases loading with the failure note', true)
  const hungText = await panelText()
  check('the form still renders and the failed list is not presented as "no bots"', hungText.includes('Saqlash') && hungText.includes('yuklab bo‘lmadi'))

  check('no runtime/console errors across all scenarios', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] briefing-form-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
  try {
    const text = await page?.evaluate(() => document.getElementById('root')?.innerText ?? '(no root)')
    console.error(`root text: ${String(text).slice(0, 300)}`)
    console.error(`runtime errors: ${runtimeErrors.slice(0, 5).join(' | ') || '(none)'}`)
  } catch { /* diagnostics only */ }
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'briefing-form.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
}

if (failed > 0) { console.error(`briefing-form-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Briefing MOUNTED-FORM smoke passed (mocked backend, real component + helpers).')
