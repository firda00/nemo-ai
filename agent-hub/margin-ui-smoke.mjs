// Product-margin panel — MOUNTED end-to-end smoke with the REAL worker and REAL downloads.
// Boots the app in DEMO mode (vite bundles the actual xlsxParse.worker), reaches the finance
// dashboard through the product's own path (SmartTaskDesk finance suggestion), uploads a real
// generated .xlsx, waits for the deterministic report, and downloads CSV + XLSX to disk:
//   1. the panel is reachable from the workspace (initial integration point);
//   2. the REAL worker parses the upload and the report renders with totals and top products;
//   3. the CSV download lands on disk with the PRODUCTS section and injection guard intact;
//   4. the XLSX download is a genuine zip (PK header) our parser and openpyxl both accept;
//   5. a currency-mismatch fixture is refused with the explicit message (no mislabeled report);
//   6. CHAT flow: an .xlsx attached in SmartTaskDesk WITHOUT margin words stays research;
//   7. the same file WITH margin intent renders the margin chat card, asks for the currency
//      (the file declares none), and a currency pick produces the report — no re-attach;
//   8. the chat card's CSV download lands on disk with the audit sections intact.
// The chat scenario exercises the DEMO transport (local worker); the server transport is
// unit-proven in tests/margin_report_endpoint.test.ts — honest scope, see the final message.
// Offline: demo mode, no backend, no paid calls. Run: npm run test:margin-ui
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { strToU8, zipSync } from 'fflate'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const baseUrl = 'http://127.0.0.1:4183'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'margin-ui')
fs.mkdirSync(artifacts, { recursive: true })
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-dl-'))
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-fixture-'))

const cell = (ref, value) => typeof value === 'number'
  ? `<c r="${ref}"><v>${value}</v></c>`
  : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`
const sheetOf = (rows) => `<worksheet><sheetData>${rows.map((cells, rowIdx) =>
  `<row r="${rowIdx + 1}">${cells.map((value, colIdx) => value === null ? '' : cell(`${'ABCDEFG'[colIdx]}${rowIdx + 1}`, value)).join('')}</row>`).join('')}</sheetData></worksheet>`
function makeFixture(fileName, rows) {
  const bytes = zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Продажи" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetOf(rows)),
  }, { level: 6 })
  const file = path.join(fixtureDir, fileName)
  fs.writeFileSync(file, bytes)
  return file
}
const goodFixture = makeFixture('sales.xlsx', [
  ['Товар', 'Кол-во', 'Выручка', 'Total cost'],
  ['Плов', 2, 200, 100],
  ['Самса', 5, 100, 80],
  ['Итого', null, 300, 180],
])
const usdFixture = makeFixture('usd.xlsx', [
  ['Товар', 'Выручка', 'Total cost', 'Валюта'],
  ['Плов', 200, 100, 'USD'],
])
// twin fixtures: same NAME and same SIZE, different numbers — the pair a string-keyed result
// cache cannot tell apart. Stored (level 0) so equal XML lengths give equal archive sizes; a
// declared currency column makes the FIRST run complete without a clarification round.
function makeStoredFixture(subdir, rows) {
  const dir = path.join(fixtureDir, subdir)
  fs.mkdirSync(dir, { recursive: true })
  const bytes = zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Продажи" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetOf(rows)),
  }, { level: 0 })
  const file = path.join(dir, 'report.xlsx')
  fs.writeFileSync(file, bytes)
  return file
}
const twinA = makeStoredFixture('twin-a', [['Товар', 'Выручка', 'Total cost', 'Валюта'], ['Плов', 300, 100, 'UZS']])
const twinB = makeStoredFixture('twin-b', [['Товар', 'Выручка', 'Total cost', 'Валюта'], ['Плов', 900, 500, 'UZS']])

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4183 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4183', '--strictPort']
const server = spawn(command, args, {
  cwd: root,
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, // DEMO mode
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
    try { if ((await fetch(baseUrl)).ok) return } catch { /* not yet */ }
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
async function waitForFile(suffix, timeoutMs = 15_000) {
  const startedAt = Date.now()
  for (;;) {
    const hit = fs.readdirSync(downloadDir).find((name) => name.endsWith(suffix) && !name.endsWith('.crdownload'))
    if (hit) return path.join(downloadDir, hit)
    if (Date.now() - startedAt > timeoutMs) return null
    await delay(250)
  }
}

let browser
let page
const runtimeErrors = []
const pendingRequests = new Map()
let navigationStage = 'not-started'
let blockedExternalRequests = 0
// Network-idle is not application readiness: optional external fonts may hang
// after React has rendered. Share the original navigation bound with the actual
// workspace readiness check, without retries or increasing its deadline.
async function navigate(route, workspace = false, requireFinanceSuggestion = false) {
  const deadline = performance.now() + 30_000
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now())
    if (ms <= 0) throw new Error(`Navigation/readiness deadline exceeded at ${navigationStage}`)
    return ms
  }
  navigationStage = `${route}:document`
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded', timeout: remaining() })
  if (workspace) {
    navigationStage = `${route}:workspace-controls`
    await page.waitForFunction(requireSuggestion => {
      const composer = document.querySelector('textarea')
      const fileInput = document.querySelector('input[type="file"][multiple]')
      const suggestion = [...document.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('неэффективные расходы'))
      return location.pathname === '/app' && composer && !composer.disabled && fileInput && (!requireSuggestion || (suggestion && !suggestion.disabled))
    }, { timeout: remaining() }, requireFinanceSuggestion)
  }
  navigationStage = `${route}:ready`
}
try {
  await waitForServer()
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    const local = url.origin === baseUrl
    if (['http:', 'https:'].includes(url.protocol) && !local) {
      blockedExternalRequests += 1
      void request.abort()
      return
    }
    // Store no headers, query strings, body or external paths in diagnostics.
    pendingRequests.set(request, { kind: request.resourceType(), target: local ? url.pathname : url.protocol, started: performance.now() })
    void request.continue()
  })
  page.on('requestfinished', request => pendingRequests.delete(request))
  page.on('requestfailed', request => pendingRequests.delete(request))
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir })

  await navigate('/')
  await page.evaluate(() => {
    localStorage.setItem('nemo.lang', 'ru')
    localStorage.setItem('nemo.user', JSON.stringify({
      id: 'margin-smoke', email: 'margin@nemo.local', name: 'Margin Smoke', lang: 'ru', role: 'user', onboardingCompleted: true, createdAt: '2026-09-01', quotaUsed: 0, quotaLimit: 100,
    }))
  })
  await navigate('/app', true, true)

  // 1) reach the finance dashboard through the product's own suggestion
  await page.evaluate(() => {
    const target = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('неэффективные расходы'))
    if (!target) throw new Error('finance suggestion not found')
    target.click()
  })
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Маржа по товарам (XLSX)'), { timeout: 15_000 })
  check('the margin panel is reachable from the workspace', true)

  // 2) upload a REAL .xlsx — the REAL vite-bundled worker parses it
  const input = await page.$('input[type="file"][accept=".xlsx"]')
  check('the .xlsx dropzone exists', Boolean(input))
  await input.uploadFile(goodFixture)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Итоги полные'), { timeout: 20_000 })
  const text = await page.evaluate(() => document.body.innerText)
  check('the deterministic report renders with currency-labeled totals', text.includes('300.00 UZS') && text.includes('120.00 UZS'))
  check('top products render from the aggregation', text.includes('Плов') && text.includes('Самса'))

  // 3) CSV download — a real file on disk with the audit sections intact
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'CSV')
    btn.click()
  })
  const csvFile = await waitForFile('-margin.csv')
  check('the CSV download lands on disk', Boolean(csvFile))
  if (csvFile) {
    const csv = fs.readFileSync(csvFile, 'utf8')
    check('the CSV carries PRODUCTS, MAPPING and the summary exclusion', csv.includes('PRODUCTS') && csv.includes('MAPPING') && csv.includes('summary_excluded'))
  }

  // 4) XLSX download — a genuine workbook (PK zip header)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'XLSX')
    btn.click()
  })
  const xlsxFile = await waitForFile('-margin.xlsx')
  check('the XLSX download lands on disk', Boolean(xlsxFile))
  if (xlsxFile) {
    const head = fs.readFileSync(xlsxFile)
    check('the XLSX is a genuine zip package', head[0] === 0x50 && head[1] === 0x4b)
  }

  // 5) currency mismatch is refused, never mislabeled
  const input2 = await page.$('input[type="file"][accept=".xlsx"]')
  await input2.uploadFile(usdFixture)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Валюта в файле не совпадает'), { timeout: 20_000 })
  check('a USD file under a UZS selection is refused with the explicit message', true)

  // ── chat flow (SmartTaskDesk → margin card, demo transport) ────────────────────────────────
  const chatFixture = makeFixture('chat-sales.xlsx', [
    ['Товар', 'Кол-во', 'Выручка', 'Total cost'],
    ['Плов', 2, 200, 100],
    ['Самса', 5, 100, 80],
    ['Итого', null, 300, 180],
  ])
  const sendInChat = async (fixture, message) => {
    await navigate('/app', true) // fresh chat, after actual composer readiness
    const chatInput = await page.$('input[type="file"][multiple]')
    if (!chatInput) throw new Error('chat file input not found')
    await chatInput.uploadFile(fixture)
    await page.waitForFunction(() => (document.body.innerText ?? '').includes('chat-sales.xlsx'), { timeout: 10_000 })
    await page.type('textarea', message)
    await page.keyboard.press('Enter')
  }

  // 6) the SAME spreadsheet WITHOUT margin words must stay on the research route
  await sendInChat(chatFixture, 'проанализируй этот файл и сделай выводы')
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Research Notebook готов'), { timeout: 15_000 })
  const researchText = await page.evaluate(() => document.body.innerText)
  check('an .xlsx without margin intent still routes to research', !researchText.includes('Принял файл XLSX'))

  // 7) margin intent + .xlsx → the margin card asks for the missing currency, then reports
  await sendInChat(chatFixture, 'посчитай маржу по товарам из файла')
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Принял файл XLSX'), { timeout: 15_000 })
  check('margin intent + .xlsx routes to the margin chat card', true)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('В файле не указана валюта'), { timeout: 20_000 })
  check('a file that declares no currency is ASKED about, never guessed', true)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'UZS')
    if (!btn) throw new Error('currency button not found')
    btn.click()
  })
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('Итоги полные'), { timeout: 20_000 })
  const chatText = await page.evaluate(() => document.body.innerText)
  check('the chat report renders with the picked currency and demo provenance',
    chatText.includes('120.00 UZS') && chatText.includes('локально'))

  // 8) the card's CSV is a real download (distinct name — no clash with the panel scenario)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'CSV')
    btn.click()
  })
  const chatCsv = await waitForFile('chat-sales-margin.csv')
  check('the chat card CSV download lands on disk', Boolean(chatCsv))
  if (chatCsv) {
    const csv = fs.readFileSync(chatCsv, 'utf8')
    check('the chat CSV carries the audit sections', csv.includes('PRODUCTS') && csv.includes('summary_excluded'))
  }

  // 9) remount + a same-name+size DIFFERENT file must compute fresh — never a stale report.
  // The route hop (no reload) remounts SmartTaskDesk and resets its turn ids: exactly the
  // precondition under which a string-keyed cache used to serve the previous file's result.
  check('the twin fixtures really share name and size (not a vacuous regression)',
    path.basename(twinA) === path.basename(twinB) && fs.statSync(twinA).size === fs.statSync(twinB).size)
  await page.setViewport({ width: 1440, height: 900 }) // the sidebar nav must be interactable
  await navigate('/app', true)
  const sendHere = async (fixture) => { // attach + send WITHOUT any navigation
    const chatInput = await page.$('input[type="file"][multiple]')
    if (!chatInput) throw new Error('chat file input not found')
    await chatInput.uploadFile(fixture)
    await page.waitForFunction(() => (document.body.innerText ?? '').includes('report.xlsx'), { timeout: 10_000 })
    await page.type('textarea', 'посчитай маржу по товарам')
    await page.keyboard.press('Enter')
  }
  await sendHere(twinA)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('200.00 UZS'), { timeout: 20_000 })
  await page.evaluate(() => {
    const link = document.querySelector('nav a[href="/app/settings"]')
    if (!link) throw new Error('settings nav link not found')
    link.click()
  })
  // React Router can update the URL before its lazy route commits. Wait for the old desk
  // to leave the DOM; clicking Back earlier cancels that transition and never remounts it.
  await page.waitForFunction(() => location.pathname === '/app/settings'
    && !document.querySelector('input[type="file"][multiple]')
    && !(document.body.innerText ?? '').includes('200.00 UZS'), { timeout: 10_000 })
  await page.evaluate(() => {
    const link = document.querySelector('nav a[href="/app"]')
    if (!link) throw new Error('chat nav link not found')
    link.click()
  })
  await page.waitForFunction(() => location.pathname === '/app' && Boolean(document.querySelector('input[type="file"][multiple]')), { timeout: 10_000 })
  await sendHere(twinB)
  await page.waitForFunction(() => (document.body.innerText ?? '').includes('400.00 UZS'), { timeout: 20_000 })
  const twinText = await page.evaluate(() => document.body.innerText)
  check('after the remount the twin file computes ITS OWN report, not the cached one',
    twinText.includes('400.00 UZS') && !twinText.includes('200.00 UZS'))

  check('no runtime errors across the flow', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] margin-ui-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
  try {
    const state = page ? await page.evaluate(() => ({ pathname: location.pathname, readyState: document.readyState,
      rootTextLength: document.getElementById('root')?.textContent?.length ?? 0, composer: Boolean(document.querySelector('textarea')) })) : null
    console.error('navigation diagnostics:', JSON.stringify({ navigationStage, state, blockedExternalRequests,
      pending: [...pendingRequests.values()].map(({ kind, target, started }) => ({ kind, target, elapsedMs: Math.round(performance.now() - started) })) }))
  } catch { /* preserve original failure if the browser is unavailable */ }
  try { console.error(`runtime errors: ${runtimeErrors.slice(0, 5).join(' | ') || '(none)'}`) } catch { /* diagnostics */ }
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'margin-ui.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
  stopServer()
}

if (failed > 0) { console.error(`margin-ui-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Product-margin MOUNTED smoke passed (real worker, real downloads, chat flow on the demo transport; the server transport is unit-proven separately).')
