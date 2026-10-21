// Document chat card — MOUNTED smoke against mocked live transports (permanent). The REAL
// DocumentChatCard runs with the real session-scope helper, the real documentJobs client and
// the REAL generation step (cli-chat mocked with the structured JSON contract). Scenarios per
// Codex review:
//   1. happy path: generation → enqueue → poll (processing→completed) → download link fetched
//      ON CLICK with the TTL-300 contract;
//   2. repeat vs fresh: remount with the SAME submissionId reuses the SAME request_id (server
//      dedups), a NEW submissionId gets a fresh request_id — retry ≠ new request;
//   3. poll timeout → «ещё готовится» (not an error), resume polls the SAME job with the SAME
//      request identity (no new enqueue);
//   4. scope loss DURING generation: identity switches while cli-chat hangs — the card blanks
//      (header title too) and NO enqueue is ever issued under the new identity;
//   5. terminal failed → error code shown; «Сгенерировать заново» regenerates with a NEW
//      request_id (explicit regenerate is the only path to one);
//   6. needs_data: the structured refusal path asks for the source and NOTHING is enqueued
//      (a model-contract behavior — NOT verified data grounding);
//   7. generation failure → typed message, no enqueue.
// HONEST SCOPE: the reload case proves CARD-level restoration (persisted job metadata → poll
// the existing job); the DESK's seeding of restored turns is separate and not mounted here.
// External network is blocked at the browser level; anchor clicks are recorded, not followed.
// Offline: no vite, no live model calls. Run: npm run test:document-card
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'document-card')
fs.mkdirSync(artifacts, { recursive: true })
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-document-card-'))
const bundlePath = path.join(buildDir, 'harness.js')
const mockSupabasePath = path.join(root, 'agent-hub', 'document-harness', 'mock-supabase.ts')
const mockAuthPath = path.join(root, 'agent-hub', 'document-harness', 'mock-auth.ts')
const supabaseReal = path.join(root, 'src', 'lib', 'supabase')
const authReal = path.join(root, 'src', 'context', 'AuthContext')

await esbuild.build({
  entryPoints: [path.join(root, 'agent-hub', 'document-harness', 'entry.tsx')],
  bundle: true,
  outfile: bundlePath,
  format: 'iife',
  charset: 'utf8',
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
const calls = () => page.evaluate(() => globalThis.__docCalls)
const setUser = (user) => page.evaluate((value) => globalThis.__setDocUser(value), user)
const mount = (scenario, props) => page.evaluate(
  (s, p) => globalThis.__mountDocument(s, p), scenario, props ?? {})
const waitForText = (needle) => page.waitForFunction(
  (text) => (document.body.innerText ?? '').includes(text), { timeout: 15_000 }, needle,
)
const clickButton = (label) => page.evaluate((needle) => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(needle))
  if (!btn) throw new Error(`button not found: ${needle}`)
  btn.click()
}, label)
const enqueues = async () => (await calls()).filter((c) => c.action === 'enqueue')

try {
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  // no external network can leave this harness — every non-file request is aborted
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    if (request.url().startsWith('file://')) void request.continue()
    else void request.abort()
  })
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
  const htmlPath = path.join(buildDir, 'harness.html')
  fs.writeFileSync(htmlPath, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="harness.js"></script></body></html>')
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 15_000 })
  await page.waitForFunction('globalThis.__harnessReady === true', { timeout: 10_000 })
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'ru'))

  // 1) happy path: generation → enqueue → processing → completed → on-click download
  const SUBMISSION_A = 'ab11c1de-1111-4111-8111-1111111fab11'
  await mount({ status: 'processing_then_completed' }, { submissionId: SUBMISSION_A })
  await waitForText('Файл собран и зарегистрирован')
  check('happy path reaches the registered-file state through generation and polling',
    (await bodyText()).includes('document.docx'))
  const happyCalls = await calls()
  check('exactly one generation and one enqueue', happyCalls.filter((c) => c.name === 'cli-chat').length === 1
    && happyCalls.filter((c) => c.action === 'enqueue').length === 1)
  check('polling repeated on the SAME job before completion',
    happyCalls.filter((c) => c.action === 'status').length >= 2)
  const requestIdA = (await enqueues())[0].request_id
  await clickButton('Скачать')
  await waitForText('Скачать') // кнопка вернулась после получения ссылки
  const downloadCall = (await calls()).find((c) => c.action === 'download')
  const clickedUrls = await page.evaluate(() => globalThis.__docClickedUrls)
  // the client refuses any reply whose expires_in ≠ 300 — reaching the click proves the TTL
  // contract held; the recorded anchor URL proves the SIGNED link (not a stored one) opened
  check('the download link is fetched ON CLICK and the signed URL is what gets opened',
    !!downloadCall && clickedUrls.length === 1 && clickedUrls[0] === 'https://signed.example/document.docx')

  // 2) REAL PAGE RELOAD restore: the SAME submission comes back through persisted job
  //    metadata and POLLS the existing job — zero generations, zero enqueues (the scenario's
  //    generate:'fail' would surface any regeneration attempt as an error state)
  await page.reload({ waitUntil: 'load', timeout: 15_000 })
  await page.waitForFunction('globalThis.__harnessReady === true', { timeout: 10_000 })
  await mount({ status: 'completed', generate: 'fail' }, { submissionId: SUBMISSION_A })
  await waitForText('Файл собран и зарегистрирован')
  const restored = await calls()
  check('after reload the SAME submission polls the EXISTING job: no generation, no enqueue',
    restored.filter((c) => c.name === 'cli-chat').length === 0
    && restored.filter((c) => c.action === 'enqueue').length === 0
    && restored.some((c) => c.action === 'status'))
  // а НОВАЯ отправка после перезагрузки — полный путь со СВЕЖИМ request_id
  await mount({ status: 'completed' }, {})
  await waitForText('Файл собран и зарегистрирован')
  const freshCalls = await calls()
  check('a NEW submission after reload runs the FULL path with a fresh request_id',
    freshCalls.filter((c) => c.name === 'cli-chat').length === 1
    && freshCalls.filter((c) => c.action === 'enqueue').length === 1
    && freshCalls.filter((c) => c.action === 'enqueue')[0].request_id !== requestIdA)

  // 3) poll timeout → still-processing (not an error); resume polls the SAME job, no new enqueue
  await mount({ status: 'processing_forever' }, { pollTimeoutMs: 400 })
  await waitForText('Файл ещё готовится')
  const beforeResume = await calls()
  check('timeout produced exactly one enqueue and NO error state',
    beforeResume.filter((c) => c.action === 'enqueue').length === 1
    && !(await bodyText()).includes('Не удалось'))
  await page.evaluate(() => { globalThis.__doc = { status: 'completed' } })
  await clickButton('Продолжить ожидание')
  await waitForText('Файл собран и зарегистрирован')
  const afterResume = await calls()
  check('resume polled the SAME job without a second enqueue',
    afterResume.filter((c) => c.action === 'enqueue').length === 1
    && afterResume.filter((c) => c.action === 'status').length > beforeResume.filter((c) => c.action === 'status').length)

  // 4) scope loss DURING generation: no enqueue ever, header title blanked
  await mount({ generate: 'hang' }, { title: 'Секретная тема' })
  await waitForText('Готовлю')
  check('the previous user’s topic is visible while THEIR card runs', (await bodyText()).includes('Секретная тема'))
  await setUser({ id: 'user-2', email: 'two@example.test' })
  await waitForText('Сессия изменилась')
  // RELEASE the deferred generation AFTER the switch — the late response must be fenced:
  // nothing stored, nothing enqueued under the new identity
  await page.evaluate(() => globalThis.__docReleaseGenerate?.())
  await delay(300)
  const afterSwitch = await calls()
  check('a LATE generation response after the identity switch never enqueues',
    afterSwitch.filter((c) => c.action === 'enqueue').length === 0)
  check('the stale card hides the previous user’s topic (header too)',
    !(await bodyText()).includes('Секретная тема'))
  await setUser({ id: 'user-1', email: 'one@example.test' })

  // 5) terminal failed → regenerate is the ONLY path to a new request_id
  const SUBMISSION_B = 'cd22e2fa-2222-4222-8222-2222222abc22'
  await mount({ status: 'failed' }, { submissionId: SUBMISSION_B })
  await waitForText('DOCUMENT_MANIFEST_INVALID')
  const failedEnqueue = (await enqueues())[0]
  await page.evaluate(() => { globalThis.__doc = { status: 'completed' } })
  await clickButton('Сгенерировать заново')
  await waitForText('Файл собран и зарегистрирован')
  const regen = await calls()
  check('regenerate ran a SECOND generation and enqueued with a NEW request_id',
    regen.filter((c) => c.name === 'cli-chat').length === 2
    && regen.filter((c) => c.action === 'enqueue').length === 2
    && regen.filter((c) => c.action === 'enqueue')[1].request_id !== failedEnqueue.request_id)

  // 6) needs_data: the structured refusal path asks for the source and enqueues nothing.
  //    HONEST SCOPE: this proves the CLIENT handles the model's refusal contract — it is a
  //    model-instruction contract, NOT verified data grounding.
  await mount({ generate: 'needs_data' })
  await waitForText('нужны фактические данные')
  check('needs_data (structured refusal) enqueues nothing', (await enqueues()).length === 0)

  // 7) generation failure → typed message, no enqueue
  await mount({ generate: 'fail' })
  await waitForText('Не удалось подготовить содержимое')
  check('generation failure is typed and enqueues nothing', (await enqueues()).length === 0)

  check('no runtime errors across the flow', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] document-card-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
  try { console.error(`runtime errors: ${runtimeErrors.slice(0, 5).join(' | ') || '(none)'}`) } catch { /* diagnostics */ }
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'document-card.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
}

if (failed > 0) { console.error(`document-card-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Document-card MOUNTED smoke passed (happy, repeat-vs-fresh, timeout-resume, scope-loss, regenerate, needs_data).')
