// REAL local browser/Auth/PostgREST acceptance. No request/response mocks or model calls.
// Run only after the owner has started and seeded the isolated environment; never resets it.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer'
import { directory, apiUrl, localStatus } from './setup.mjs'
import { snapshot } from './source-version.mjs'

const app = 'http://127.0.0.1:55439'
const report = { kind: 'real-local-browser-auth-postgrest', mocks: false, modelCalls: 0, checks: [], rpcCounts: {}, blockedRemoteRequests: 0 }
const sourceBefore = snapshot().sourceSha256
const screenshots = path.join(directory, 'screenshots')
fs.mkdirSync(screenshots, { recursive: true })
report.sourceSha256 = sourceBefore
let browser
const cardSelector = 'section[aria-label="Book a trial lesson"]'
try {
  const config = localStatus()
  const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'local-login.json'), 'utf8'))
  if (credentials.environment !== 'synthetic-local-only' || credentials.url !== `${app}/auth`) throw new Error('FIXTURE_SCOPE_MISMATCH')
  browser = await puppeteer.launch({ headless: true })
  const pages = {}
  for (const role of ['operatorA', 'ownerA']) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    pages[role] = page
    await page.setViewport({ width: 1440, height: 1000 })
    await page.evaluateOnNewDocument(() => localStorage.setItem('nemo.lang', 'en'))
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = new URL(request.url())
      if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['55431', '55439'].includes(url.port))) {
        report.blockedRemoteRequests++; void request.abort(); return
      }
      if (url.pathname.includes('/functions/v1/')) { void request.abort(); return } // no LLM/Edge traffic
      if (request.method() === 'POST' && url.pathname.includes('/rpc/trial_booking_')) {
        const rpc = url.pathname.split('/').at(-1)
        report.rpcCounts[rpc] = (report.rpcCounts[rpc] ?? 0) + 1
      }
      void request.continue()
    })
    const credential = credentials.users.find(user => user.role === role)
    if (!credential) throw new Error('FIXTURE_LOGIN_MISSING')
    await page.goto(`${app}/auth`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type=email]', { timeout: 30000 })
    await page.type('input[type=email]', credential.email)
    await page.type('input[type=password]', credential.password)
    await page.click('button[type=submit]')
    await page.waitForFunction(() => !location.pathname.startsWith('/auth'), { timeout: 30000 })
    await page.goto(`${app}/app`, { waitUntil: 'domcontentloaded' })
  }
  const openCard = async page => {
    await page.waitForSelector('section[aria-labelledby="smart-task-desk-title"] textarea', { timeout: 30000 })
    await page.type('section[aria-labelledby="smart-task-desk-title"] textarea', 'Book a trial lesson')
    await page.click('section[aria-labelledby="smart-task-desk-title"] button[type=submit]')
    await page.waitForSelector(cardSelector, { timeout: 30000 })
    await idle(page)
  }
  const idle = page => page.waitForFunction(selector => {
    const card = document.querySelector(selector)
    return [...(card?.querySelectorAll('button') ?? [])].some(button => button.textContent === 'Refresh schedule and state' && !button.disabled)
  }, { timeout: 30000 }, cardSelector)
  const click = (page, label) => page.evaluate(({ selector, label }) => {
    const button = [...document.querySelector(selector).querySelectorAll('button')].find(button => button.textContent.trim() === label)
    if (!button || button.disabled) throw new Error('EXPECTED_BUTTON_UNAVAILABLE')
    button.click()
  }, { selector: cardSelector, label })
  const operator = pages.operatorA, owner = pages.ownerA
  await openCard(operator)
  const options = await operator.$$eval(`${cardSelector} select option`, rows => rows.filter(row => row.value).map(row => row.value))
  if (!options.length) throw new Error('NO_FREE_SYNTHETIC_SLOT')
  await operator.select(`${cardSelector} select`, options[0])
  const requested = operator.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/rpc/trial_booking_request'))
  await click(operator, 'Request approval')
  const requestResponse = await requested
  if (!requestResponse.ok()) throw new Error('REQUEST_FAILED')
  const operation = await requestResponse.json()
  await idle(operator)
  assert.equal(operation.status, 'waiting_for_approval')
  assert.ok(!operation.booking_id)
  report.checks.push('operator authenticated through login UI, read actual schedule and requested owner approval')
  await (await operator.$(cardSelector)).screenshot({ path: path.join(screenshots, 'browser-pending.png') })
  await openCard(owner)
  await owner.evaluate(({ selector, id }) => {
    const button = [...document.querySelector(selector).querySelectorAll('li button')].find(button => button.textContent.includes(id))
    if (!button) throw new Error('OWNER_CANNOT_SEE_REQUEST')
    button.click()
  }, { selector: cardSelector, id: operation.operation_id })
  await idle(owner)
  await click(owner, 'Approve and execute')
  await idle(owner)
  await owner.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Booking confirmed by reading'), { timeout: 30000 }, cardSelector)
  await click(operator, 'Refresh schedule and state'); await idle(operator)
  await operator.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Booking confirmed by reading'), { timeout: 30000 }, cardSelector)
  const bookingId = await operator.$eval(`${cardSelector} strong`, node => node.textContent)
  assert.match(bookingId, /^[0-9a-f-]{36}$/)
  report.checks.push('owner separately approved and executed; operator confirmed via fresh result read')
  await (await operator.$(cardSelector)).screenshot({ path: path.join(screenshots, 'browser-confirmed.png') })
  const writesBeforeReload = report.rpcCounts.trial_booking_request
  await operator.reload({ waitUntil: 'domcontentloaded' })
  await openCard(operator)
  await operator.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Booking confirmed by reading'), { timeout: 30000 }, cardSelector)
  assert.equal(await operator.$eval(`${cardSelector} strong`, node => node.textContent), bookingId)
  assert.equal(report.rpcCounts.trial_booking_request, writesBeforeReload)
  const response = await fetch(`${apiUrl}/rest/v1/bookings?trial_operation_id=eq.${operation.operation_id}&select=id`, { redirect: 'error', headers: { apikey: config.SERVICE_ROLE_KEY, Authorization: `Bearer ${config.SERVICE_ROLE_KEY}` } })
  if (!response.ok) throw new Error('LOCAL_BOOKING_VERIFICATION_FAILED')
  const rows = await response.json()
  assert.equal(rows.length, 1); assert.equal(rows[0].id, bookingId)
  report.checks.push('actual page reload reopens same saved operation; direct database REST read confirms exactly one booking')
  report.bookingCount = rows.length
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  // No provider bodies, browser contents, credentials or tokens in evidence.
  report.error = String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 180)
  process.exitCode = 1
} finally {
  await browser?.close()
  report.sourceSha256After = snapshot().sourceSha256
  if (report.sourceSha256After !== sourceBefore) { report.status = 'failed'; report.error = 'SOURCE_CHANGED_DURING_RUN'; process.exitCode = 1 }
  fs.writeFileSync(path.join(directory, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
