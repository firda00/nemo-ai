// Mounted real owner inboxes in React StrictMode; synthetic auth/SDK/REST only.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import puppeteer from 'puppeteer'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../tailwind.config.js'

const root = process.cwd(), out = path.join(root, 'agent-hub/artifacts/employee-deploy-stage/owner-ui')
fs.mkdirSync(out, { recursive: true })
const sourceFiles = ['src/pages/app/ApprovalsPage.tsx', 'src/pages/app/DialoguesPage.tsx', 'src/lib/dialogueSession.ts', 'src/lib/scopedFunctionCall.ts', 'src/i18n/ownerWorkflow.ts']
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes()
await build({ entryPoints: ['agent-hub/employee-harness/owner-entry.tsx'], outfile: path.join(out, 'harness.js.snapshot'), bundle: true, format: 'iife', jsx: 'automatic', charset: 'utf8', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{"VITE_SUPABASE_URL":"https://synthetic.invalid","VITE_SUPABASE_ANON_KEY":"synthetic-public"}' },
  plugins: [{ name: 'owner-ui-offline', setup(bundler) {
    bundler.onResolve({ filter: /(?:supabase|AuthContext|useAgentStore)$/ }, args => {
      const file = path.resolve(args.resolveDir, args.path)
      if (file === path.join(root, 'src/lib/supabase')) return { path: path.join(root, 'agent-hub/employee-harness/owner-mock.ts') }
      if (file === path.join(root, 'src/context/AuthContext')) return { path: path.join(root, 'agent-hub/employee-harness/mock-auth.ts') }
      if (file === path.join(root, 'src/store/useAgentStore')) return { path: path.join(root, 'agent-hub/employee-harness/mock-store.ts') }
    })
  } }],
})
const cssSource = path.join(root, 'src/index.css')
const styled = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(fs.readFileSync(cssSource, 'utf8').replace(/^@import[^\n]*\r?\n/gm, ''), { from: cssSource })
fs.writeFileSync(path.join(out, 'harness.css'), styled.css)
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="harness.css"></head><body><div id="root"></div><script src="harness.js.snapshot"></script></body></html>')
let browser, page
const checks = [], errors = []
const check = (label, okay) => { assert(okay, label); checks.push(label); console.log('[OK] ' + label) }
const text = () => page.evaluate(() => document.body.innerText)
const waitText = value => page.waitForFunction(value => document.body.innerText.includes(value), { timeout: 7000 }, value)
const calls = () => page.evaluate(() => globalThis.__ownerCalls)
const clickText = value => page.evaluate(value => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === value)?.click(), value)
const mode = (kind, value) => page.evaluate((kind, value) => { globalThis.__ownerMode[kind] = value }, kind, value)
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND'] })
  page = await browser.newPage(); await page.setViewport({ width: 1100, height: 850 })
  await page.setRequestInterception(true)
  page.on('request', request => void (request.url().startsWith('file://') ? request.continue() : request.abort()))
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(new URL('file:///' + path.join(out, 'index.html').replaceAll('\\', '/')).href)
  await page.waitForFunction(() => globalThis.__ownerReady)
  await page.evaluate(() => globalThis.__mountOwner('approvals')); await waitText('PRIVATE-REQUEST-A')
  check('approval list loads under StrictMode with a fixed user JWT', (await calls()).filter(call => call.kind === 'list').every(call => call.authorization === 'Bearer jwt-employee-user-a'))
  check('generic approval visibly explains decision-only semantics and exposes evidence', (await text()).includes('не выполняет действие автоматически') && (await text()).includes('Данные запроса'))
  const approveText = await page.$eval('article button', button => button.textContent.trim())
  await mode('decide', 'hold')
  await page.evaluate(() => { const button = document.querySelector('article button'); button.click(); button.click() })
  await page.waitForFunction(() => globalThis.__ownerPending.some(item => item.kind === 'decide'))
  check('duplicate approval clicks dispatch one decision and keep the card pending', (await calls()).filter(call => call.kind === 'decide').length === 1 && (await text()).includes('pending') && await page.$$eval('article button', buttons => buttons.every(button => button.disabled)))
  await page.evaluate(() => globalThis.__ownerPending.find(item => item.kind === 'decide').resolve({ data: { ok: true }, error: null }))
  await waitText('Решение сохранено. Внешнее действие ещё не выполнено.')
  check('successful approval changes status only after server confirmation', (await text()).includes('approved') && !(await text()).includes('pending'))

  await mode('list', 'hold'); await page.evaluate(() => globalThis.__mountOwner('approvals'))
  await page.waitForFunction(() => globalThis.__ownerPending.some(item => item.kind === 'list'))
  await page.evaluate(() => { globalThis.__ownerMode.list = 'success'; globalThis.__setEmployeeUser({ id: 'user-b' }) })
  await waitText('PRIVATE-REQUEST-B')
  await page.evaluate(() => globalThis.__ownerPending.filter(item => item.kind === 'list').forEach(item => item.resolve({ data: { ok: true, requests: [globalThis.__ownerApproval('A-LATE')] }, error: null })))
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)))
  check('late old-user approval list is aborted and cannot replace the new inbox', !(await text()).includes('A-LATE') && (await text()).includes('PRIVATE-REQUEST-B') && (await calls()).some(call => call.kind === 'list' && call.aborted))
  await mode('decide', 'hold'); await clickText(approveText)
  await page.waitForFunction(() => globalThis.__ownerCalls.filter(call => call.kind === 'decide').length === 2)
  await page.evaluate(() => globalThis.__setEmployeeUser(null))
  await waitText('Войдите, чтобы открыть рабочие запросы.')
  await page.evaluate(() => globalThis.__ownerPending.filter(item => item.kind === 'decide').forEach(item => item.resolve({ data: { ok: true }, error: null })))
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)))
  check('logout clears approval cards and ignores a late decision', !(await text()).includes('PRIVATE-REQUEST') && !(await text()).includes('Решение сохранено.'))

  await page.evaluate(() => { globalThis.__setEmployeeUser({ id: 'employee-user-a' }); globalThis.__ownerMode = { patch: 'error' }; globalThis.__ownerCalls = []; globalThis.__ownerPending = []; globalThis.__mountOwner('dialogues') })
  await waitText('PRIVATE-CUSTOMER-A')
  await page.evaluate(() => document.querySelector('aside li button').click()); await waitText('PRIVATE-MESSAGE-A')
  check('human handoff inbox loads tenant-bound rows and messages in StrictMode', (await calls()).filter(call => ['users', 'agents', 'dialogues', 'messages'].includes(call.kind)).every(call => call.authorization === 'Bearer jwt-employee-user-a'))
  await clickText('Взять диалог')
  // Resolve localized takeover label without assuming its text across dictionaries.
  if (!(await calls()).some(call => call.kind === 'patch')) await page.evaluate(() => [...document.querySelectorAll('header button')].find(button => button.querySelector('svg.lucide-hand'))?.click())
  await waitText('Не удалось подтвердить смену оператора.')
  check('failed takeover leaves state and composer unchanged', !(await page.$('textarea')) && (await text()).includes('Не удалось подтвердить смену оператора.'))
  await mode('patch', 'success'); await page.evaluate(() => [...document.querySelectorAll('header button')].find(button => button.querySelector('svg.lucide-hand'))?.click())
  await page.waitForSelector('textarea')
  check('confirmed takeover opens operator composer', Boolean(await page.$('textarea')))
  await page.type('textarea', 'PRIVATE-OPERATOR-DRAFT')
  await mode('send', 'hold')
  await page.evaluate(() => { const button = document.querySelector('textarea').parentElement.querySelector('button'); button.click(); button.click() })
  await page.waitForFunction(() => globalThis.__ownerCalls.some(call => call.kind === 'send'))
  check('operator double-send makes one pinned call and retains draft until acknowledgment', (await calls()).filter(call => call.kind === 'send').length === 1 && await page.$eval('textarea', input => input.value === 'PRIVATE-OPERATOR-DRAFT' && input.disabled))
  check('unconfirmed operator reply is not fabricated as a sent bubble', await page.$$eval('div.whitespace-pre-wrap', bubbles => !bubbles.some(bubble => bubble.textContent.includes('PRIVATE-OPERATOR-DRAFT'))))
  await page.evaluate(() => globalThis.__ownerPending.find(item => item.kind === 'send').resolve({ data: { ok: false }, error: { message: 'synthetic' } }))
  await waitText('Отправка не подтверждена.')
  check('uncertain send preserves draft and tells operator to inspect history before retry', await page.$eval('textarea', input => input.value === 'PRIVATE-OPERATOR-DRAFT') && (await text()).includes('Проверьте историю диалога перед повтором.'))
  await mode('patch', 'hold')
  await page.evaluate(() => [...document.querySelectorAll('header button')].find(button => button.textContent.trim() === 'Решено')?.click())
  await page.waitForFunction(() => globalThis.__ownerPending.some(item => item.kind === 'patch'))
  check('resolve stays visible and does not claim success before a confirmed update', (await text()).includes('PRIVATE-MESSAGE-A'))
  await page.evaluate(() => { globalThis.__ownerMode.patch = 'success'; globalThis.__ownerMode.messages = 'hold'; globalThis.__setEmployeeUser({ id: 'user-b' }) })
  await page.waitForFunction(() => globalThis.__ownerPending.some(item => item.kind === 'messages'))
  check('session change clears previous transcript and operator draft before new load completes', !(await text()).includes('PRIVATE-MESSAGE-A') && !(await page.$('textarea')))
  await page.evaluate(() => globalThis.__ownerPending.filter(item => item.kind === 'patch').forEach(item => item.resolve(new Response(JSON.stringify([{ id: '20000000-0000-4000-8000-000000000002', status: 'resolved', operator_takeover: false }])))))
  await page.evaluate(() => { globalThis.__ownerMode.messages = 'success'; globalThis.__setEmployeeUser({ id: 'user-c' }); globalThis.__ownerPending.filter(item => item.kind === 'messages').forEach(item => item.resolve(new Response(JSON.stringify([{ id: 'late-message', dialogue_id: '20000000-0000-4000-8000-000000000002', author: 'customer', content: 'PRIVATE-LATE-B', created_at: new Date().toISOString() }])))) })
  await waitText('PRIVATE-CUSTOMER-A')
  check('late previous-session update/messages cannot resurrect a selected dialogue or leak text', !(await text()).includes('PRIVATE-LATE-B') && !(await page.$('textarea')))
  check('no browser runtime errors', errors.length === 0)
  check('owner workflow source stable during mounted test', JSON.stringify(before) === JSON.stringify(hashes()))
  await page.setViewport({ width: 320, height: 850 }); await page.screenshot({ path: path.join(out, 'dialogues-320.png'), fullPage: true })
  await page.evaluate(() => globalThis.__mountOwner('approvals')); await waitText('PRIVATE-REQUEST-A')
  await page.screenshot({ path: path.join(out, 'approvals-320.png'), fullPage: true })
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: checks.length, checks, errors, sourceHashes: before, networkCalls: 0, actualPages: true, mockedTransports: true }, null, 2) + String.fromCharCode(10))
} catch (error) {
  fs.writeFileSync(path.join(out, 'failed-result.json'), JSON.stringify({ passed: checks.length, checks, errors, error: String(error), pageText: page ? await text() : '', calls: page ? await calls() : [] }, null, 2) + String.fromCharCode(10))
  throw error
} finally { await browser?.close() }
