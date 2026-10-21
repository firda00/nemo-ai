// Margin chat card — MOUNTED auth-switch smoke against a mocked live transport (permanent).
// Complements margin-ui-smoke.mjs (demo transport, real worker): here the REAL MarginChatCard
// runs with the real cache/scope helpers while the smoke flips the signed-in identity UNDER a
// mounted card — the case no demo flow can reach without a reload:
//   1. a COMPLETED report (signed URLs on screen) is hidden the moment the identity changes:
//      the stale-session message renders, links and the refresh action disappear, and the old
//      user's file is NEVER auto-uploaded to the new account (exactly one transport call);
//   2. a PENDING run at the moment of the switch never delivers its late result — the card
//      stays on the stale-session message even after the transport resolves;
//   3. logout + login as the SAME user is a NEW session (generation scope): the old report does
//      not resurrect.
// Offline: no vite server, no network — a built bundle served from file://. No paid calls.
// Run: npm run test:margin-card   (exits non-zero on any failure)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'margin-card')
fs.mkdirSync(artifacts, { recursive: true })
// the GENERATED bundle lives outside the repo so no lint pass ever scans bundled deps
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-margin-card-'))
const bundlePath = path.join(buildDir, 'harness.js')
const mockSupabasePath = path.join(root, 'agent-hub', 'margin-harness', 'mock-supabase.ts')
const mockAuthPath = path.join(root, 'agent-hub', 'margin-harness', 'mock-auth.ts')
const supabaseReal = path.join(root, 'src', 'lib', 'supabase')
const authReal = path.join(root, 'src', 'context', 'AuthContext')

await esbuild.build({
  entryPoints: [path.join(root, 'agent-hub', 'margin-harness', 'entry.tsx')],
  bundle: true,
  outfile: bundlePath,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
  plugins: [{
    name: 'mock-modules',
    setup(build) {
      build.onResolve({ filter: /supabase$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path)
        return resolved === supabaseReal ? { path: mockSupabasePath } : undefined
      })
      build.onResolve({ filter: /AuthContext$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path)
        return resolved === authReal ? { path: mockAuthPath } : undefined
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
const bodyText = () => page.evaluate(() => document.body.innerText)
const callCount = () => page.evaluate(() => globalThis.__marginCalls.length)
const setUser = (user) => page.evaluate((value) => globalThis.__setMarginUser(value), user)
const mount = (scenario) => page.evaluate((value) => globalThis.__mountMargin(value), scenario)
const waitForText = (needle) => page.waitForFunction(
  (text) => (document.body.innerText ?? '').includes(text), { timeout: 10_000 }, needle,
)

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
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'ru'))

  // 1) completed report, then the identity changes under it
  await mount({ mode: 'done' })
  await waitForText('Итоги полные')
  let text = await bodyText()
  check('the live report renders with totals and the refresh action', text.includes('200.00') && text.includes('Обновить ссылки'))
  const linksBefore = await page.evaluate(() => document.querySelectorAll('a[href*="signed.example"]').length)
  check('signed download links are on screen before the switch', linksBefore === 3)
  check('exactly one transport call produced the report', await callCount() === 1)

  await setUser({ id: 'user-2' })
  await waitForText('Сессия изменилась')
  text = await bodyText()
  const linksAfter = await page.evaluate(() => document.querySelectorAll('a[href*="signed.example"]').length)
  check('the switch hides the report, its totals and every signed link', !text.includes('200.00') && linksAfter === 0)
  check('the refresh action is gone with the report', !text.includes('Обновить ссылки'))
  await delay(300)
  check('the old user’s file is never auto-uploaded to the new account', await callCount() === 1)

  // 2) a run still pending at the moment of the switch never delivers late
  await mount({ mode: 'slow-done', slowMs: 800 })
  await waitForText('Считаю отчёт…')
  await setUser({ id: 'user-3' })
  await waitForText('Сессия изменилась')
  await delay(1_200) // the transport resolves in the background — the card must not care
  text = await bodyText()
  check('a late completion never renders under the new identity', text.includes('Сессия изменилась') && !text.includes('Итоги полные'))
  check('the pending run made exactly one call and no retry', await callCount() === 1)

  // 3) logout + login as the SAME user is a new session — the old report stays gone
  await setUser({ id: 'user-4' })
  await mount({ mode: 'done' })
  await waitForText('Итоги полные')
  await setUser(null)
  await waitForText('Сессия изменилась')
  await setUser({ id: 'user-4' })
  await delay(200)
  text = await bodyText()
  check('re-login as the same user does not resurrect the previous session’s report',
    text.includes('Сессия изменилась') && !text.includes('Итоги полные'))
  check('re-login triggered no automatic re-upload', await callCount() === 1)

  // 4) a failed registry write is VISIBLE and the retry heals it through the sha follow-up
  await setUser({ id: 'user-6' })
  await mount({ mode: 'registry-fail' })
  await waitForText('не попал в список источников')
  check('the registry gap renders as a warning WITH the report still usable',
    (await bodyText()).includes('Итоги полные'))
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Повторить регистрацию'))
    if (!btn) throw new Error('registry retry button not found')
    btn.click()
  })
  await page.waitForFunction(() => !(document.body.innerText ?? '').includes('не попал в список источников'), { timeout: 10_000 })
  const repair = await page.evaluate(() => globalThis.__marginCalls.at(-1))
  check('the retry repairs via the sha follow-up (no re-upload) and the warning clears',
    repair.isShaFollowUp === true && (await bodyText()).includes('Итоги полные'))

  check('no runtime errors across the flow', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] margin-card-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
  try { console.error(`runtime errors: ${runtimeErrors.slice(0, 5).join(' | ') || '(none)'}`) } catch { /* diagnostics */ }
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'margin-card.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
}

if (failed > 0) { console.error(`margin-card-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Margin-card MOUNTED auth-switch smoke passed (completed, pending and same-user-relogin cases).')
