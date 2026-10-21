// SmartTaskDesk — MOUNTED document-restore smoke (permanent). The REAL desk runs with the
// real router/store/i18n/documentJobs client against the scenario mock transports:
//   1. restoration is IDENTITY-SCOPED: with jobs seeded for two users, mounting as user-1
//      restores ONLY user-1's turns (restored copy + cards polling to completed), user-2's
//      title never appears; remounting as user-2 shows only theirs;
//   2. restored turns POLL existing jobs: zero cli-chat generations, zero enqueues — polls
//      only (generate:'fail' in the scenario would surface any regeneration as an error);
//   3. restoration seeds ONLY an empty chat: after a live submission the remount does not
//      duplicate turns over the conversation (covered by the fresh remount per identity);
//   4. a LIVE submission typed into the real composer routes to the document branch
//      (documentReady turn + card) and runs the full generation → enqueue → completed path.
// HONEST SCOPE: transports are mocks (no live model/backend); this proves the DESK's
// restoration and routing wiring, complementing the card-level smoke.
// Offline: no vite, external network blocked at the browser level. Run: npm run test:document-desk
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'document-desk')
fs.mkdirSync(artifacts, { recursive: true })
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-document-desk-'))
const bundlePath = path.join(buildDir, 'harness.js')
const mockSupabasePath = path.join(root, 'agent-hub', 'document-harness', 'mock-supabase.ts')
const mockAuthPath = path.join(root, 'agent-hub', 'document-harness', 'mock-auth.ts')
const supabaseReal = path.join(root, 'src', 'lib', 'supabase')
const authReal = path.join(root, 'src', 'context', 'AuthContext')

await esbuild.build({
  entryPoints: [path.join(root, 'agent-hub', 'document-harness', 'desk-entry.tsx')],
  bundle: true,
  outfile: bundlePath,
  format: 'iife',
  charset: 'utf8',
  jsx: 'automatic',
  // esbuild has no vite env: give import.meta.env an empty object so VITE_* reads are undefined
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
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
const mountDesk = async (scenario) => {
  await page.evaluate((s) => globalThis.__mountDesk(s), scenario)
  // The new desk first resolves its scope asynchronously. Do not type into a
  // previous mount or the temporary checking state; keep the existing bound.
  await page.waitForSelector('textarea', { timeout: 10_000 })
}
const waitForText = (needle) => page.waitForFunction(
  (text) => (document.body.innerText ?? '').includes(text), { timeout: 15_000 }, needle,
)
const JOB = 'cd55c5de-5555-4555-8555-5555555def55'

try {
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
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
  fs.writeFileSync(htmlPath, '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root" style="height:100vh"></div><script src="harness.js"></script></body></html>')
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 15_000 })
  await page.waitForFunction('globalThis.__harnessReady === true', { timeout: 10_000 })
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'ru'))

  // seed durable job metadata for TWO users BEFORE any mount — the reload-equivalent state
  await page.evaluate((job) => {
    globalThis.__seedDocumentJob('user-1', { submissionId: 'ab11c1de-1111-4111-8111-1111111fab11', jobId: job, kind: 'docx_document', title: 'Отчёт первого пользователя', brief: 'Сделай Word: итоги' })
    globalThis.__seedDocumentJob('user-1', { submissionId: 'cd22e2fa-2222-4222-8222-2222222abc22', jobId: job, kind: 'pptx_presentation', title: 'Презентация первого', brief: 'Сделай PPTX: план' })
    globalThis.__seedDocumentJob('user-2', { submissionId: 'ef33a3bc-3333-4333-8333-3333333def33', jobId: job, kind: 'docx_document', title: 'Документ второго пользователя', brief: 'Сделай Word: чужое' })
  }, JOB)

  // 1) mount as user-1: ONLY their two turns restore; cards poll to completed
  await setUser({ id: 'user-1', email: 'one@example.test' })
  await mountDesk({ status: 'completed', generate: 'fail' })
  await waitForText('Восстановил недавний запрос файла')
  await waitForText('Файл собран и зарегистрирован')
  await delay(300)
  let text = await bodyText()
  check('user-1 restore shows BOTH their jobs', text.includes('Отчёт первого пользователя') && text.includes('Презентация первого'))
  check('identity scoping: user-2’s job never appears for user-1', !text.includes('Документ второго пользователя'))
  const restoredCalls = await calls()
  check('restored turns POLL existing jobs: zero generations, zero enqueues',
    restoredCalls.filter((c) => c.name === 'cli-chat').length === 0
    && restoredCalls.filter((c) => c.action === 'enqueue').length === 0
    && restoredCalls.filter((c) => c.action === 'status').length >= 2)

  // 2) identity changes while the SAME desk stays mounted: no old text or cards survive.
  await setUser({ id: 'user-2', email: 'two@example.test' })
  await waitForText('Документ второго пользователя')
  text = await bodyText()
  check('user-2 restore shows only their job', !text.includes('Отчёт первого пользователя') && !text.includes('Презентация первого'))
  const user2Calls = await calls()
  check('user-2 restoration also polls only', user2Calls.filter((c) => c.action === 'enqueue').length === 0)

  // 3) LIVE submission through the real composer routes to the document branch
  await setUser({ id: 'user-3', email: 'three@example.test' })
  await mountDesk({ status: 'completed' })
  await delay(200)
  await page.waitForSelector('textarea', { timeout: 10_000 })
  // формулировка без «команда/агент»: те слова законно уходят в диалог создания сущностей
  // the in-bundle classifier must route this phrase to docx — a regression here (e.g. the
  // charset mojibake this smoke once caught) reads as a routing failure, not a hang
  const PHRASE = 'Сделай Word: квартальные итоги отдела продаж'
  const inBundle = await page.evaluate((value) => globalThis.__classifyDocumentIntent(value)?.kind ?? null, PHRASE)
  check('the BUNDLED classifier routes the phrase to docx (encoding intact)', inBundle === 'docx_document')
  await page.type('textarea', PHRASE)
  await page.keyboard.press('Enter')
  await waitForText('Принял запрос — готовлю файл')
  await waitForText('Файл собран и зарегистрирован')
  const liveCalls = await calls()
  check('a live desk submission runs the FULL path: one generation, one enqueue',
    liveCalls.filter((c) => c.name === 'cli-chat').length === 1
    && liveCalls.filter((c) => c.action === 'enqueue').length === 1)
  check('the live submission card shows the request topic', (await bodyText()).includes('квартальные итоги'))

  await page.type('textarea', 'Личный черновик третьего пользователя')
  await page.evaluate(() => {
    const input = document.querySelector('input[type="file"]')
    const files = new DataTransfer()
    files.items.add(new File(['private source'], 'private-draft.txt', { type: 'text/plain' }))
    input.files = files.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await setUser({ id: 'user-2', email: 'two@example.test' })
  await waitForText('Документ второго пользователя')
  check('live account switch clears old prompt, attachment and draft without harness remount',
    !(await bodyText()).includes(PHRASE) && !(await bodyText()).includes('private-draft.txt')
    && await page.$eval('textarea', (el) => el.value) === '')

  // 4) The server accepts enqueue but its response is lost. A REAL reload discovers the
  // submitting record, sends the same typed input/ID, and never calls the model again.
  await setUser({ id: 'user-recovery', email: 'recovery@example.test' })
  await mountDesk({ enqueue: 'lost_response' })
  const LONG_PHRASE = 'Сделай Word: ' + 'Подробные исходные сведения. '.repeat(30) + 'ОБЯЗАТЕЛЬНЫЙ ХВОСТ'
  await page.type('textarea', LONG_PHRASE)
  await page.keyboard.press('Enter')
  await waitForText('Сервис файлов временно недоступен')
  const beforeReload = (await calls()).find((c) => c.action === 'enqueue')
  check('uncertain enqueue was accepted once by mock server', beforeReload?.deduplicated === false)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction('globalThis.__harnessReady === true')
  await setUser({ id: 'user-recovery', email: 'recovery@example.test' })
  await mountDesk({ generate: 'fail', status: 'failed' })
  await waitForText('Сборка файла завершилась ошибкой')
  const afterReload = await calls()
  const retry = afterReload.find((c) => c.action === 'enqueue')
  check('real reload retries the same request and exact input, with server deduplication',
    retry?.request_id === beforeReload.request_id && JSON.stringify(retry.input) === JSON.stringify(beforeReload.input)
    && retry.deduplicated === true && afterReload.filter((c) => c.name === 'cli-chat').length === 0)
  await page.evaluate(() => { globalThis.__doc = { status: 'completed' } })
  await page.evaluate(() => [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Сгенерировать заново')).click())
  await waitForText('Файл собран и зарегистрирован')
  const regenerated = await calls()
  const generation = regenerated.find((c) => c.name === 'cli-chat')
  check('failed/reload/explicit regenerate preserves the complete brief beyond 500 characters',
    generation?.body.messages[0].content.endsWith(LONG_PHRASE)
    && regenerated.filter((c) => c.action === 'enqueue').at(-1).request_id !== beforeReload.request_id)

  // 5) A pending session lookup resolves under a different identity: no old payload leaves.
  await setUser({ id: 'user-pending', email: 'pending@example.test' })
  await mountDesk({ session: 'hang' })
  await page.type('textarea', 'Сделай Word: секретный исходник пользователя')
  await page.keyboard.press('Enter')
  await page.waitForFunction('typeof globalThis.__docReleaseSession === "function"')
  await setUser({ id: 'user-new', email: 'new@example.test' })
  await page.evaluate(() => globalThis.__docReleaseSession())
  await delay(150)
  check('identity switch during getSession sends no generation or enqueue', (await calls()).length === 0)

  // 6) A direct answer resolving after a user change cannot enter the new desk instance.
  await page.evaluate(() => { globalThis.__doc = { generate: 'hang' }; delete globalThis.__docReleaseGenerate })
  await page.type('textarea', 'Объясни смысл слова привет')
  await page.keyboard.press('Enter')
  await page.waitForFunction('typeof globalThis.__docReleaseGenerate === "function"')
  await setUser({ id: 'user-final', email: 'final@example.test' })
  await page.evaluate(() => globalThis.__docReleaseGenerate())
  await delay(150)
  check('late direct answer and its old prompt are absent from the next account',
    !(await bodyText()).includes('Поздний текст') && !(await bodyText()).includes('Объясни смысл'))

  await page.type('textarea', 'Черновик до выхода')
  await page.evaluate(() => {
    globalThis.__setDocUser(null)
    globalThis.__setDocUser({ id: 'user-final', email: 'final@example.test' })
  })
  await delay(100)
  check('batched logout/login as the same user resets the draft through session generation', await page.$eval('textarea', (el) => el.value) === '')

  // PDF uses the same durable submission/recovery path and fresh download boundary.
  await setUser({ id: 'user-pdf', email: 'pdf@example.test' })
  await mountDesk({ kind: 'typst_document', enqueue: 'lost_response' })
  await page.type('textarea', 'Сделай PDF: Полный текст отчёта для проверки зарегистрированного PDF.')
  await page.keyboard.press('Enter')
  await waitForText('Сервис файлов временно недоступен')
  const pdfBefore = (await calls()).find((c) => c.action === 'enqueue')
  check('explicit PDF reaches typed enqueue with report sections',
    pdfBefore?.input.kind === 'typst_document' && pdfBefore.input.template === 'report'
    && pdfBefore.input.sections.length > 0 && pdfBefore.input.line_items.length === 0)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction('globalThis.__harnessReady === true')
  await setUser({ id: 'user-pdf', email: 'pdf@example.test' })
  await mountDesk({ kind: 'typst_document', generate: 'fail' })
  await waitForText('document.pdf')
  const pdfAfter = await calls()
  const pdfRetry = pdfAfter.find((c) => c.action === 'enqueue')
  check('PDF lost-response reload replays identical input/id without model generation',
    pdfRetry?.request_id === pdfBefore.request_id && pdfRetry.deduplicated === true
    && JSON.stringify(pdfRetry.input) === JSON.stringify(pdfBefore.input)
    && pdfAfter.filter((c) => c.name === 'cli-chat').length === 0)
  await page.evaluate(() => {
    globalThis.__pdfDownloads = []
    HTMLAnchorElement.prototype.click = function () { globalThis.__pdfDownloads.push(this.href) }
  })
  for (let index = 0; index < 2; index++) {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((el) => el.textContent.includes('Скачать')).click())
    await page.waitForFunction((count) => globalThis.__pdfDownloads.length === count, {}, index + 1)
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((el) => el.textContent.includes('Скачать') && !el.disabled))
  }
  check('each PDF download click fetches a fresh signed link',
    (await calls()).filter((c) => c.action === 'download').length === 2
    && await page.evaluate(() => globalThis.__pdfDownloads.every((url) => url === 'https://signed.example/document.pdf')))
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction('globalThis.__harnessReady === true')
  await setUser({ id: 'user-pdf', email: 'pdf@example.test' })
  await mountDesk({ kind: 'typst_document', generate: 'fail' })
  await waitForText('document.pdf')
  check('accepted PDF reload polls the existing job without enqueue or generation',
    (await calls()).some((c) => c.action === 'status')
    && !(await calls()).some((c) => c.action === 'enqueue' || c.name === 'cli-chat'))

  check('no runtime errors across the desk flow', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] document-desk-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
  try { console.error(`runtime errors: ${runtimeErrors.slice(0, 5).join(' | ') || '(none)'}`) } catch { /* diagnostics */ }
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'document-desk.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
}

if (failed > 0) { console.error(`document-desk-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Document-desk MOUNTED restore smoke passed (identity-scoped restoration polls existing jobs; live submission routes).')
