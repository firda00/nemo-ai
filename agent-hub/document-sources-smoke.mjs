// Real browser workers and SmartTaskDesk, loopback Vite only. Backend/model are mocks.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, createServer, preview } from 'vite'
import react from '@vitejs/plugin-react'
import puppeteer from 'puppeteer'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { periodXlsx, sourceDocx, sourceXlsx } from '../tests/fixtures/document-source-fixtures.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'agent-hub/artifacts/attachment-stage/browser')
fs.mkdirSync(artifacts, { recursive: true })
const put = (name, bytes) => { const p = path.join(artifacts, name); fs.writeFileSync(p, bytes); return p }
const txt = put('source.txt', 'FIRST SOURCE: Revenue 120. Cost 50. All material must survive recovery.')
const txt2 = put('second.txt', 'SECOND SOURCE: O‘zbekcha matn. Another complete paragraph from a different attachment.')
const docx = put('source.docx', sourceDocx())
const xlsx = put('source.xlsx', sourceXlsx({ prefix: true, singleQuotes: true }))
const currencyXlsx = put('currency.xlsx', sourceXlsx({ currency: null }))
const datedXlsx = put('dated.xlsx', periodXlsx())
const periodCurrencyXlsx = put('dated-currency.xlsx', periodXlsx({ currency: null }))
const invalidDateXlsx = put('invalid-date.xlsx', periodXlsx({ invalidDate: true }))
const bad = put('bad.txt', new Uint8Array([0xff]))
const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
pdf.addPage().drawText('PAGE ONE: real text from the first PDF page.', { font })
pdf.addPage().drawText('PAGE TWO: real text from the last PDF page.', { font })
const pdfPath = put('source.pdf', await pdf.save({ useObjectStreams: false }))
const scanned = await PDFDocument.create()
const pixel = await scanned.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64'))
const scannedPage = scanned.addPage()
scannedPage.drawImage(pixel, { x: 10, y: 20, width: 500, height: 600 })
scannedPage.drawText('Page 1')
const scannedPath = put('scanned.pdf', await scanned.save({ useObjectStreams: false }))

const buildDir = path.join(artifacts, 'browser-build')
const config = { root, configFile: false, envFile: false, cacheDir: path.join(artifacts, 'vite-cache'),
  plugins: [react(), { name: 'document-source-mocks', enforce: 'pre', load(id) {
    // Real application styling, system fonts for fully offline UI verification.
    if (id.replace(/\\/g, '/') === path.join(root, 'src/index.css').replace(/\\/g, '/')) return fs.readFileSync(id, 'utf8').replace(/^@import url\([^\n]+\);\r?\n/m, '')
  }, resolveId(source, importer) {
    if (!importer || !source.startsWith('.')) return
    const target = path.resolve(path.dirname(importer.split('?')[0]), source).replace(/\\/g, '/')
    if (target === path.join(root, 'src/lib/supabase').replace(/\\/g, '/')) return path.join(root, 'agent-hub/document-harness/mock-supabase.ts')
    if (target === path.join(root, 'src/context/AuthContext').replace(/\\/g, '/')) return path.join(root, 'agent-hub/document-harness/mock-auth.ts')
  } }], build: { outDir: buildDir, emptyOutDir: true, rollupOptions: { input: path.join(root, 'agent-hub/document-harness/attachments.html') } }, logLevel: 'error' }
const dev = process.argv.includes('--dev')
let server
if (dev) { server = await createServer({ ...config, server: { host: '127.0.0.1', port: 0 } }); await server.listen() }
else { await build(config); server = await preview({ root, configFile: false, envFile: false, build: { outDir: buildDir }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' }) }
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const errors = []
const network = []
let browser
let page
let failed = 0
const check = (label, good) => { if (!good) failed++; console.log(`[${good ? 'OK' : 'FAIL'}] ${label}`) }
const waitText = (text) => page.waitForFunction((v) => document.body.innerText.includes(v), { timeout: 35000 }, text)
const calls = () => page.evaluate(() => globalThis.__docCalls)
const start = async (scenario = {}, user = `u-${crypto.randomUUID()}`) => {
  await page.evaluate(({ scenario, user }) => { globalThis.__setDocUser({ id: user }); globalThis.__mountDesk(scenario) }, { scenario, user })
  await page.waitForSelector('textarea')
  await new Promise((r) => setTimeout(r, 70))
}
const send = async (files, prompt) => {
  const input = await page.$('input[type=file]')
  await input.uploadFile(...files)
  await page.type('textarea', prompt)
  await page.keyboard.press('Enter')
}
const job = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith(`nemo.documentJobs.job.${globalThis.__docAuth.user.id}.`)).map((k) => JSON.parse(JSON.parse(localStorage.getItem(k)).v))[0])
const chooseJuly = async () => {
  for (const [label, date] of [['Начало периода', '2026-07-01'], ['Конец периода', '2026-07-31']]) await page.$eval(`input[aria-label="${label}"]`, (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, date)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Рассчитать за период').click())
}
try {
  // Block off-loopback egress without Fetch interception: Puppeteer's request interception
  // can strand repeated module workers in Vite development mode.
  browser = await puppeteer.launch({ headless: true, args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] })
  page = await browser.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('requestfailed', (r) => network.push({ failed: r.url(), error: r.failure() }))
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) network.push({ status: r.status(), url: r.url() }) })
  page.on('workercreated', (w) => network.push({ worker: w.url() }))
  page.on('console', (m) => { if (m.type() === 'error' && !m.location().url?.endsWith('/favicon.ico')) errors.push(m.text()) })
  await page.goto(`${origin}/agent-hub/document-harness/attachments.html`, { waitUntil: 'networkidle0' })
  await page.waitForFunction('globalThis.__harnessReady === true')
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'ru'))

  await start({ generate: 'fail' })
  await send([txt, docx, xlsx, pdfPath], 'Создай PDF из приложенных файлов')
  await waitText('Файл собран и зарегистрирован')
  let c = await calls()
  let input = c.find((v) => v.action === 'enqueue')?.input
  let saved = await job()
  const content = JSON.stringify(input)
  check('four real files → actual workers → one PDF enqueue, zero model calls', saved?.source?.sources.length === 4 && c.filter((v) => v.action === 'enqueue').length === 1 && !c.some((v) => v.name === 'cli-chat'))
  check('DOCX header/table, XLSX second sheet, and last PDF page survive into renderer input', content.includes('Важный колонтитул') && content.includes('сохранённая ячейка') && content.includes('Товар Второй') && content.includes('PAGE TWO'))
  check('durable record stores source bytes hashes and locators', saved.source.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)) && saved.version === 3)

  await start({ generate: 'fail', enqueue: 'lost_response' }, 'lost-user')
  await send([txt, txt2], 'Сделай Word из этих файлов')
  await waitText('Сервис файлов временно недоступен')
  const before = (await calls()).find((v) => v.action === 'enqueue')
  await page.reload({ waitUntil: 'networkidle0' })
  await start({ generate: 'fail' }, 'lost-user')
  await waitText('Файл собран и зарегистрирован')
  c = await calls()
  const after = c.find((v) => v.action === 'enqueue')
  check('real page reload retries exact input/requestId with saved sources and no model', before.request_id === after?.request_id && JSON.stringify(before.input) === JSON.stringify(after.input) && !c.some((v) => v.name === 'cli-chat'))

  await start({ generate: 'fail' })
  await send([xlsx, txt2], 'Сделай PDF отчёт по марже')
  await waitText('Файл собран и зарегистрирован')
  c = await calls(); input = c.find((v) => v.action === 'enqueue')?.input
  check('explicit PDF + margin beats preview; mixed sources included, deterministic 270 USD', input?.kind === 'typst_document' && JSON.stringify(input).includes('270.00 USD') && JSON.stringify(input).includes('SECOND SOURCE') && !c.some((v) => v.name === 'cli-chat'))

  await start({ generate: 'fail' }, 'currency-user')
  await send([currencyXlsx], 'Сделай PDF по марже')
  await waitText('Укажите валюту данных')
  check('missing currency pauses before enqueue with sources already durable', !(await calls()).length && (await job())?.state === 'preparing')
  await page.reload({ waitUntil: 'networkidle0' })
  await start({ generate: 'fail' }, 'currency-user')
  await waitText('Укажите валюту данных')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'USD').click())
  await waitText('Файл собран и зарегистрирован')
  check('currency clarification survives reload and uses saved workbook', JSON.stringify((await calls()).find((v) => v.action === 'enqueue').input).includes('270.00 USD'))

  await start({ generate: 'fail', enqueue: 'lost_response' }, 'period-user')
  await send([datedXlsx], 'Сделай PDF по марже за июль 2026')
  await waitText('Укажите начало и конец периода')
  check('period request requires explicit dates before any calls', !(await calls()).length && (await job()).state === 'preparing')
  await chooseJuly()
  await waitText('Сервис файлов временно недоступен')
  const periodBefore = (await calls()).find((v) => v.action === 'enqueue')
  saved = await job()
  check('July calculation persists dates before enqueue and selects both boundaries with returns', saved.sourceOptions.period.from === '2026-07-01' && saved.sourceOptions.period.to === '2026-07-31' && JSON.stringify(periodBefore.input).includes('290.00 USD') && !JSON.stringify(periodBefore.input).includes('Фильтр дат не применялся'))
  await page.reload({ waitUntil: 'networkidle0' })
  await start({ generate: 'fail' }, 'period-user')
  await waitText('Файл собран и зарегистрирован')
  const periodAfter = (await calls()).find((v) => v.action === 'enqueue')
  check('lost period enqueue reload replays exact input/requestId without model or original file', JSON.stringify(periodAfter.input) === JSON.stringify(periodBefore.input) && periodBefore.request_id === periodAfter.request_id && !(await calls()).some((v) => v.name === 'cli-chat'))

  await start({ generate: 'fail' }, 'period-currency-user')
  await send([periodCurrencyXlsx], 'Сделай PDF по марже за месяц')
  await waitText('Укажите начало и конец периода')
  await chooseJuly()
  await waitText('Укажите валюту данных')
  await page.reload({ waitUntil: 'networkidle0' })
  await start({ generate: 'fail' }, 'period-currency-user')
  await waitText('Укажите валюту данных')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'USD').click())
  await waitText('Файл собран и зарегистрирован')
  check('currency answer after reload retains period and source without model', (await job()).sourceOptions.period.to === '2026-07-31' && JSON.stringify((await calls()).find((v) => v.action === 'enqueue').input).includes('290.00 USD') && !(await calls()).some((v) => v.name === 'cli-chat'))

  await start({ generate: 'fail' }, 'invalid-date-user')
  await send([invalidDateXlsx], 'Сделай PDF по марже за месяц')
  await waitText('Укажите начало и конец периода')
  await chooseJuly()
  await waitText('Отбор остановлен')
  check('invalid calendar date shows exact sheet/cell and refuses partial report', !(await calls()).length && (await page.evaluate(() => document.body.innerText)).includes('Возвраты · F5'))
  await page.reload({ waitUntil: 'networkidle0' })
  await start({ generate: 'fail' }, 'invalid-date-user')
  await waitText('Отбор остановлен')
  check('date clarification restores period controls after reload', await page.$eval('input[aria-label="Начало периода"]', (i) => i.value === '2026-07-01'))
  await page.screenshot({ path: path.join(artifacts, 'period-clarification.png'), fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  check('period controls fit mobile viewport with real app styles', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('input[type=date]')].every((i) => i.getBoundingClientRect().right <= innerWidth)))
  await page.screenshot({ path: path.join(artifacts, 'period-mobile.png'), fullPage: true })
  await page.setViewport({ width: 800, height: 600 })

  await start({ generate: 'fail' })
  await send([datedXlsx], 'Сделай PDF по марже за месяц')
  await waitText('Укажите начало и конец периода')
  await page.evaluate(() => {
    globalThis.__originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('nemo.documentJobs.job.')) throw new Error('quota'); return globalThis.__originalSetItem.call(this, key, value) }
  })
  await chooseJuly()
  await waitText('Не удалось сохранить запрос для восстановления')
  check('period persistence failure blocks enqueue and keeps original draft', !(await calls()).length && !(await job()).sourceOptions.period)
  await page.evaluate(() => { Storage.prototype.setItem = globalThis.__originalSetItem })

  await start({ generate: 'fail' })
  await send([txt, txt2, docx, bad], 'Сделай PDF из файлов')
  await waitText('bad.txt: Не удалось полностью прочитать')
  check('failure of final attachment: zero model, zero enqueue, no partial snapshot', !(await calls()).length && !(await job()))

  await start({ generate: 'fail' })
  await send([scannedPath], 'Сделай PDF из вложения')
  await waitText('Файл содержит данные')
  check('scan with text footer refuses instead of silently keeping only the footer', !(await calls()).length)

  await start({ generate: 'fail' })
  await page.evaluate(() => {
    globalThis.__originalSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('nemo.documentJobs.job.')) throw new Error('quota'); return globalThis.__originalSetItem.call(this, key, value) }
  })
  await send([txt], 'Сделай краткую выжимку PDF')
  await waitText('Не удалось сохранить запрос для восстановления')
  check('durable write failure prevents BOTH model selection and enqueue', !(await calls()).length)
  await page.evaluate(() => { Storage.prototype.setItem = globalThis.__originalSetItem })

  await start({ generateResponse: { quotes: [{ sourceId: 'S1', locator: 'text:1', quote: 'Revenue 120. Cost 50.' }] } })
  await send([txt], 'Сделай краткую выжимку PDF')
  await waitText('Файл собран и зарегистрирован')
  check('verified excerpt becomes an explicitly labelled quote artifact', JSON.stringify((await calls()).find((v) => v.action === 'enqueue')?.input).includes('Смысловая полнота выжимки не проверена'))
  await start({ generateResponse: { quotes: [{ sourceId: 'S1', locator: 'text:1', quote: 'Revenue 99999.' }] } })
  await send([txt], 'Сделай краткую выжимку PDF')
  await waitText('не прошли проверку по источникам')
  check('invented numerical quote is rejected before enqueue', !(await calls()).some((v) => v.action === 'enqueue'))

  await start({ generate: 'fail' }, 'abort-owner')
  await page.evaluate(() => {
    globalThis.__originalRead = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = function () { const file = this; return new Promise((resolve) => { globalThis.__releaseRead = () => globalThis.__originalRead.call(file).then(resolve) }) }
  })
  await send([txt], 'Создай PDF из файла')
  await page.waitForFunction('typeof globalThis.__releaseRead === "function"')
  await page.evaluate(() => { globalThis.__setDocUser(null); globalThis.__setDocUser({ id: 'abort-owner' }); globalThis.__releaseRead(); File.prototype.arrayBuffer = globalThis.__originalRead })
  await new Promise((r) => setTimeout(r, 150))
  check('logout/login same user during real file read fences hash/parse/persistence/enqueue', !(await calls()).length && !(await job()))

  check('no runtime errors in real worker and mounted UI paths', !errors.length)
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ failed, errors }, null, 2))
  await page.screenshot({ path: path.join(artifacts, 'final-ui.png'), fullPage: true })
  if (failed) throw new Error(`${failed} document source browser checks failed`)
} catch (error) {
  if (page) {
    const diagnostic = { errors, network, body: await page.evaluate(() => document.body.innerText), calls: await calls() }
    fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify(diagnostic, null, 2))
    console.error(JSON.stringify(diagnostic))
  }
  throw error
} finally { await browser?.close(); if (dev) await server.close(); else await new Promise((resolve) => server.httpServer.close(resolve)) }
