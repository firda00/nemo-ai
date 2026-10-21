// Explicit MODEL SUBSTITUTION; real local GoTrue, PostgREST, durable SQL tools and browser.
// Never a paid-model or full LLM E2E acceptance. Starts/stops only its own local Vite app.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer'
import { startTrialApp } from '../trial-booking-local/app.mjs'
import { localStatus, directory, root, apiUrl } from '../trial-booking-local/setup.mjs'

const app = 'http://127.0.0.1:55439'
const artifacts = path.join(root, 'agent-hub/artifacts/trial-booking-model-loop')
fs.mkdirSync(artifacts, { recursive: true })
const dataDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-model-acceptance-')), '.data')
const evidence = { kind: 'substituted-model-real-local-auth-tools-browser', modelSubstituted: true, realAuth: true, realPostgrest: true, paidModelCalls: 0, tests: [] }
let server, browser, modelCalls = 0
const local = localStatus()
const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'local-login.json'), 'utf8'))
const ok = (content, toolCalls = []) => ({ ok: true, content, toolCalls, model: 'openai/gpt-4o-mini', reportedModel: 'openai/gpt-4o-mini', upstreamProvider: 'OpenAI', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0 } })
const tool = (name, args = {}) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const model = async messages => {
  modelCalls++
  const lastUser = messages.findLastIndex(item => item.role === 'user')
  const text = messages[lastUser]?.content ?? ''
  const recentTools = messages.slice(lastUser).filter(item => item.role === 'tool')
  if (text.includes('UNKNOWN_RESPONSE')) throw new Error('SIMULATED_PROVIDER_RESPONSE_LOST')
  if (text.includes('MISSING_METADATA')) return { ...ok('unverified response'), reportedModel: undefined, upstreamProvider: undefined }
  if (text.includes('FALLBACK_MODEL')) return { ...ok('substituted fallback'), reportedModel: 'unrequested-model' }
  if (text.includes('INJECT_ACCOUNT')) return ok(null, [tool('request_trial_booking', { session_id: text.match(/[0-9a-f-]{36}/)[0], attendee_label: 'Synthetic learner', account_id: randomUUID() })])
  if (text.includes('SELF_APPROVE')) return ok(null, [tool('approve_trial_booking', {})])
  if (text.includes('READ_SAVED')) return recentTools.length ? ok('Saved booking result was read using the authorized tool.') : ok(null, [tool('read_trial_result')])
  const slotId = text.match(/selected lesson ([0-9a-f-]{36})/)?.[1]
  if (!slotId) return ok('Please select a lesson before requesting approval.')
  if (!recentTools.length) return ok(null, [tool('read_trial_schedule')])
  if (recentTools.length === 1) return ok(null, [tool('request_trial_booking', { session_id: slotId, attendee_label: 'Synthetic learner' })])
  return ok('Request saved, awaiting HUMAN owner approval. No booking has been executed.')
}
const auth = {}
async function rest(url, method = 'GET', body, token = local.SERVICE_ROLE_KEY) {
  const response = await fetch(`${apiUrl}${url}`, { method, redirect: 'error', headers: { apikey: local.ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`LOCAL_HTTP_${response.status}`)
  return response.json()
}
async function chat(who, chatId, text, messageId = randomUUID(), extra = {}) {
  const response = await fetch(`${app}/__trial_chat?chatId=${chatId}`, { method: text === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `Bearer ${auth[who].token}`, 'Content-Type': 'application/json' }, body: text === undefined ? undefined : JSON.stringify({ chatId, messageId, text, ...extra }), signal: AbortSignal.timeout(30000) })
  return { status: response.status, body: await response.json() }
}
async function test(name, fn) {
  try { await fn(); evidence.tests.push({ name, status: 'passed' }) }
  catch (error) { evidence.tests.push({ name, status: 'failed', error: String(error.message).slice(0, 200) }) }
}
try {
  for (const role of ['operatorA', 'ownerA', 'ownerB']) {
    const credential = credentials.users.find(user => user.role === role)
    const login = await rest('/auth/v1/token?grant_type=password', 'POST', { email: credential.email, password: credential.password }, local.ANON_KEY)
    const profile = (await rest(`/rest/v1/users?select=account_id&id=eq.${login.user.id}`, 'GET', undefined, login.access_token))[0]
    auth[role] = { token: login.access_token, id: login.user.id, accountId: profile.account_id, credential }
  }
  const course = randomUUID(), session = randomUUID()
  await rest('/rest/v1/trial_courses', 'POST', { id: course, account_id: auth.operatorA.accountId, name: 'Synthetic model-loop acceptance' })
  await rest('/rest/v1/trial_sessions', 'POST', { id: session, account_id: auth.operatorA.accountId, course_id: course, starts_at: new Date(Date.now() + 10 * 86400000).toISOString(), timezone: 'Asia/Tashkent', capacity: 10 })
  server = await startTrialApp({ modelChat: true, modelCall: model, dataDir })
  browser = await puppeteer.launch({ headless: true })
  const pages = {}
  for (const who of ['operatorA', 'ownerA']) {
    const context = await browser.createBrowserContext(), page = await context.newPage(); pages[who] = page
    await page.setViewport({ width: 1440, height: 1000 })
    await page.setRequestInterception(true)
    page.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['55431', '55439'].includes(url.port))) return void request.abort(); if (url.pathname.includes('/functions/v1/')) return void request.abort(); void request.continue() })
    await page.evaluateOnNewDocument(() => localStorage.setItem('nemo.lang', 'en'))
    await page.goto(`${app}/auth`, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('input[type=email]')
    await page.type('input[type=email]', auth[who].credential.email); await page.type('input[type=password]', auth[who].credential.password)
    await page.click('button[type=submit]'); await page.waitForFunction(() => !location.pathname.startsWith('/auth'))
    await page.goto(`${app}/app`, { waitUntil: 'domcontentloaded' })
  }
  const selector = 'section[aria-label="Book a trial lesson"]'
  const send = async (page, text) => { const area = 'section[aria-labelledby="smart-task-desk-title"] textarea'; await page.waitForSelector(area); await page.type(area, text); const done = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/__trial_chat', { timeout: 30000 }); await page.click('section[aria-labelledby="smart-task-desk-title"] button[type=submit]'); const response = await done; assert.equal(response.status(), 200); await page.waitForSelector(selector, { timeout: 30000 }); return JSON.parse(response.request().postData()) }
  const idle = page => page.waitForFunction(selector => [...document.querySelector(selector)?.querySelectorAll('button') ?? []].some(button => button.textContent === 'Refresh schedule and state' && !button.disabled), { timeout: 30000 }, selector)
  const click = (page, label) => page.evaluate(({ selector, label }) => { const button = [...document.querySelector(selector).querySelectorAll('button')].find(b => b.textContent.trim() === label); if (!button || button.disabled) throw new Error('BUTTON_UNAVAILABLE'); button.click() }, { selector, label })
  let conversation, operationId, bookingId, originalMessage
  await test('ordinary chat text invokes model-selected real schedule/request tools; request stays pending', async () => {
    originalMessage = await send(pages.operatorA, `Book a trial lesson; selected lesson ${session}; attendee Synthetic learner.`); await idle(pages.operatorA)
    conversation = await pages.operatorA.evaluate(id => JSON.parse(localStorage.getItem(`nemo:trial-chat:v1:${id}`)), auth.operatorA.id)
    const view = (await chat('operatorA', conversation.chatId)).body
    assert.equal(view.mode, 'explicit-model-substitution'); assert.equal(view.operation.status, 'waiting_for_approval'); assert.ok(!view.operation.booking_id)
    operationId = view.operation.operation_id
    assert.deepEqual(view.receipts.flatMap(receipt => receipt.tools?.map(t => t.name) ?? []), ['read_trial_schedule', 'request_trial_booking'])
    assert.equal((await rest(`/rest/v1/bookings?trial_operation_id=eq.${operationId}&select=id`)).length, 0)
    assert.equal(await pages.operatorA.$eval(selector, element => element.textContent.includes('Request approval')), false)
  })
  if (!operationId) throw new Error('BROWSER_MODEL_REQUEST_PREREQUISITE_FAILED')
  await test('human owner card executes; operator separately reads durable confirmation', async () => {
    await send(pages.ownerA, 'Open trial lesson approval requests'); await idle(pages.ownerA)
    assert.equal(await pages.ownerA.$eval(selector, element => element.textContent.includes('Request approval')), false)
    await pages.ownerA.evaluate(({ selector, operationId }) => { const button = [...document.querySelector(selector).querySelectorAll('li button')].find(b => b.textContent.includes(operationId)); if (!button) throw new Error('OWNER_REQUEST_NOT_FOUND'); button.click() }, { selector, operationId }); await idle(pages.ownerA)
    await click(pages.ownerA, 'Approve and execute'); await idle(pages.ownerA)
    await click(pages.operatorA, 'Refresh schedule and state'); await idle(pages.operatorA)
    bookingId = await pages.operatorA.$eval(`${selector} strong`, element => element.textContent)
    assert.match(bookingId, /^[0-9a-f-]{36}$/)
    await send(pages.operatorA, 'READ_SAVED result of my trial lesson')
    const view = (await chat('operatorA', conversation.chatId)).body
    assert.equal(view.operation.booking_id, bookingId)
    assert.ok(view.receipts.some(receipt => receipt.tools?.some(tool => tool.name === 'read_trial_result')))
    assert.equal(await pages.operatorA.$eval(selector, element => element.textContent.includes('Start another booking')), false)
    await (await pages.operatorA.$(selector)).screenshot({ path: path.join(artifacts, 'confirmed.png') })
  })
  await test('page reload and server restart recover same journal/booking without another model call', async () => {
    const before = modelCalls
    await pages.operatorA.reload({ waitUntil: 'domcontentloaded' }); await pages.operatorA.waitForSelector(selector); await idle(pages.operatorA)
    assert.equal(await pages.operatorA.$eval(`${selector} strong`, element => element.textContent), bookingId)
    await server.close(); server = await startTrialApp({ modelChat: true, modelCall: model, dataDir })
    const view = (await chat('operatorA', conversation.chatId)).body
    assert.equal(view.operation.booking_id, bookingId); assert.equal(modelCalls, before)
    assert.equal((await rest(`/rest/v1/bookings?trial_operation_id=eq.${operationId}&select=id`)).length, 1)
  })
  await test('different users and chat identities cannot retrieve another conversation', async () => {
    for (const who of ['ownerA', 'ownerB']) { const view = (await chat(who, conversation.chatId)).body; assert.equal(view.operation, null); assert.equal(view.messages.length, 0) }
    assert.equal((await chat('operatorA', randomUUID())).body.operation, null)
  })
  await test('same message id retries without a model call; changed body denied; new id same text processes normally', async () => {
    const before = modelCalls
    const view = (await chat('operatorA', conversation.chatId, originalMessage.text, originalMessage.messageId)).body
    assert.equal(view.operation.operation_id, operationId); assert.equal(view.operation.booking_id, bookingId)
    assert.equal(modelCalls, before)
    const changed = await chat('operatorA', conversation.chatId, 'Changed body', originalMessage.messageId)
    assert.equal(changed.status, 409); assert.equal(changed.body.error, 'IMMUTABLE_MESSAGE'); assert.equal(modelCalls, before)
    for (let i = 0; i < 2; i++) {
      const prior = modelCalls, next = await chat('operatorA', conversation.chatId, 'READ_SAVED repeat status', randomUUID())
      assert.equal(next.status, 200); assert.ok(modelCalls > prior); assert.equal(next.body.operation.booking_id, bookingId)
    }
    assert.equal((await rest(`/rest/v1/bookings?trial_operation_id=eq.${operationId}&select=id`)).length, 1)
  })
  await test('HTTP tool/account injection is rejected before model', async () => { const before = modelCalls; assert.equal((await chat('operatorA', randomUUID(), 'hello', randomUUID(), { accountId: auth.ownerB.accountId, tool_calls: [] })).status, 400); assert.equal(modelCalls, before) })
  await test('model account injection and self-approval are rejected without a booking', async () => {
    for (const marker of ['INJECT_ACCOUNT', 'SELF_APPROVE']) { const id = randomUUID(); const result = await chat('operatorA', id, `${marker} ${session}`); assert.equal(result.status, 400); assert.ok(['TOOL_ARGUMENTS', 'TOOL_NOT_ALLOWED'].includes(result.body.error)); assert.equal((await chat('operatorA', id)).body.operation, null) }
  })
  await test('unknown model response is persisted and repeated message causes no additional calls', async () => {
    const id = randomUUID(), message = randomUUID(), before = modelCalls
    assert.equal((await chat('operatorA', id, 'UNKNOWN_RESPONSE', message)).status, 400)
    for (let i = 0; i < 2; i++) assert.equal((await chat('operatorA', id, 'UNKNOWN_RESPONSE', message)).body.error, 'UNKNOWN_MODEL_RESPONSE_NO_AUTOMATIC_RETRY')
    assert.equal(modelCalls, before + 1)
  })
  await test('missing actual provider metadata and fallback model are rejected without tool effects', async () => {
    for (const marker of ['MISSING_METADATA', 'FALLBACK_MODEL']) {
      const id = randomUUID(), response = await chat('operatorA', id, marker)
      assert.equal(response.status, 400); assert.equal(response.body.error, 'MODEL_RESPONSE_NOT_VERIFIED')
      assert.equal((await chat('operatorA', id)).body.operation, null)
    }
  })
  await test('unauthenticated middleware and Vite credential paths are denied', async () => {
    assert.equal((await fetch(`${app}/__trial_chat?chatId=${randomUUID()}`)).status, 401)
    for (const suffix of ['/agent-hub/trial-booking-local/local-login.json', `/@fs/${directory.replaceAll('\\', '/')}/local-login.json`]) {
      const response = await fetch(app + suffix); const body = await response.text()
      assert.ok(response.status >= 400); assert.ok(!body.includes(auth.operatorA.credential.password))
    }
  })
  await test('exhausted persisted reservation budget blocks model invocation', async () => {
    for (let index = 1; index <= 40; index++) {
      try { fs.writeFileSync(path.join(dataDir, 'budget', `request-${index}`), '', { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    const before = modelCalls, response = await chat('operatorA', randomUUID(), 'Read trial lesson schedule')
    assert.equal(response.status, 400); assert.equal(response.body.error, 'MODEL_PACKAGE_LIMIT'); assert.equal(modelCalls, before)
  })
  await test('paid-disabled path invokes no model/provider and creates no operation', async () => {
    await server.close(); server = await startTrialApp({ modelChat: true, dataDir: path.join(dataDir, 'paid-disabled') })
    const before = modelCalls, result = await chat('operatorA', randomUUID(), `Book trial lesson ${session}`)
    assert.equal(result.body.error, 'OWNER_APPROVAL_OR_KEY_REQUIRED'); assert.equal(result.body.operation, null); assert.equal(modelCalls, before)
  })
  evidence.status = evidence.tests.every(test => test.status === 'passed') ? 'passed' : 'failed'
} catch (error) { evidence.status = 'failed'; evidence.error = String(error.message).slice(0, 200) }
finally {
  await browser?.close(); await server?.close()
  evidence.substitutedModelCalls = modelCalls
  fs.writeFileSync(path.join(artifacts, 'acceptance-results.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2)); if (evidence.status !== 'passed') process.exitCode = 1
}
