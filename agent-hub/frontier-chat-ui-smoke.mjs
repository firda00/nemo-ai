// Independently authored browser probe of the REAL desk, scoped client and continuation UI.
// All SDK and HTTP transport is mocked/blocked; no provider credentials are loaded.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { build } from 'esbuild'
import puppeteer from 'puppeteer'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../tailwind.config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'agent-hub/artifacts/auth-latency-stage/frontier-ui')
fs.mkdirSync(out, { recursive: true })
const sources = ['src/components/platform/SmartTaskDesk.tsx', 'src/lib/frontierChatClient.ts', 'src/lib/scopedFunctionCall.ts']
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
const sourceBefore = hashes()
await build({
  entryPoints: [path.join(root, 'agent-hub/frontier-chat-harness/entry.tsx')],
  outfile: path.join(out, 'harness.js.snapshot'), bundle: true, format: 'iife', charset: 'utf8', jsx: 'automatic', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [{ name: 'offline-desk', setup(bundler) {
    bundler.onResolve({ filter: /(?:supabase|AuthContext)$/ }, args => {
      const resolved = path.resolve(args.resolveDir, args.path)
      if (resolved === path.join(root, 'src/lib/supabase')) return { path: path.join(root, 'agent-hub/frontier-chat-harness/mock-supabase.ts') }
      if (resolved === path.join(root, 'src/context/AuthContext')) return { path: path.join(root, 'agent-hub/frontier-chat-harness/mock-auth.ts') }
    })
  } }],
})
const css = path.join(out, 'harness.css')
// Compile the original stylesheet before esbuild reformats arbitrary @apply values.
const sourceCss = path.join(root, 'src/index.css')
const styled = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(fs.readFileSync(sourceCss, 'utf8').replace(/^@import[^\n]*\r?\n/gm, ''), { from: sourceCss })
fs.writeFileSync(css, styled.css)
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="harness.css"></head><body><div id="root"></div><script src="harness.js.snapshot"></script></body></html>')
let browser, page
const checks = [], errors = []
const check = (name, condition) => { assert(condition, name); checks.push(name); console.log('[OK] ' + name) }
const modelSelect = 'select[aria-label="Модель для ответов"]'
const effortSelect = 'select[aria-label="Глубина рассуждения"]'
const waitText = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 10000 }, text)
const calls = () => page.evaluate(() => globalThis.__frontierCalls)
const bodyText = () => page.evaluate(() => document.body.innerText)
const clickText = text => page.evaluate(text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text)?.click(), text)
const send = async text => { await page.type('textarea', text); await page.keyboard.press('Enter') }
const freshIdentity = async id => {
  await page.evaluate(id => { globalThis.__setFrontierUser({ id, email: `${id}@example.invalid` }); globalThis.__frontierMode = 'ok' }, id)
  await page.waitForFunction(selector => document.querySelector(selector)?.value === 'fast', {}, modelSelect)
  await page.select(modelSelect, 'gpt-6-astra')
}
const attachImages = async descriptors => {
  await page.evaluate(async descriptors => {
    const transfer = new DataTransfer()
    for (const item of descriptors) {
      let body = new Blob([new Uint8Array(item.size ?? 1)], { type: item.type ?? 'image/png' })
      if (item.valid) {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
        body = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      }
      transfer.items.add(new File([body], item.name, { type: item.type ?? 'image/png' }))
    }
    const input = document.querySelector('input[type=file]')
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }))
  }, descriptors)
  await waitText(descriptors.at(-1).name)
}
const submitAndWait = async text => {
  const id = (await calls()).length + 1
  await send(text); await waitText(`MOCK-REPLY-${id}`)
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, modelSelect)
  return (await calls()).at(-1)
}
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND'] })
  page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => void (request.url().startsWith('file://') ? request.continue() : request.abort()))
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewport({ width: 1100, height: 900 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.goto(new URL('file:///' + path.join(out, 'index.html').replaceAll('\\', '/')).href)
  await page.waitForFunction(() => globalThis.__frontierReady)
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('nemo.lang', 'ru'); globalThis.__mountFrontierDesk() })
  await page.waitForSelector(modelSelect)
  check('model selector offers fast, Astra and Fable', await page.$eval(modelSelect, select => JSON.stringify([...select.options].map(o => o.value)) === JSON.stringify(['fast', 'gpt-6-astra', 'claude-fable-5-1'])))
  await page.select(modelSelect, 'gpt-6-astra')
  check('frontier effort defaults to low', await page.$eval(effortSelect, select => select.value === 'low'))
  const first = await submitAndWait('Что такое cash flow?')
  check('simple explanation uses exact Astra selection and one new message', first.body.selection.provider === 'openai' && first.body.selection.model === 'gpt-6-astra' && first.body.selection.effort === 'low' && first.body.messages.length === 1 && first.body.messages[0].content === 'Что такое cash flow?' && !('continuation' in first.body) && first.body.tools.length === 0)
  check('simple explanation never opens a finance artifact', !(await page.$('a[href="/app/finance"]')))
  const second = await submitAndWait('Объясни ещё короче')
  check('next request sends one new user message plus opaque continuation', second.body.messages.length === 1 && second.body.messages[0].content === 'Объясни ещё короче' && second.body.continuation === `MOCK_CONTINUATION_${first.id}`)
  await page.select(modelSelect, 'fast')
  const afterAstra = await submitAndWait('Отдельный короткий вопрос')
  check('Astra to fast excludes the most recent Astra assistant at the boundary', afterAstra.body.messages.length === 1 && afterAstra.body.messages[0].role === 'user' && afterAstra.body.messages[0].content === 'Отдельный короткий вопрос')
  await page.select(modelSelect, 'claude-fable-5-1')
  const switched = await submitAndWait('Что такое HTTP POST?')
  check('Fable selection resets continuation and does not resend Astra history', switched.body.selection.provider === 'anthropic' && switched.body.selection.model === 'claude-fable-5-1' && switched.body.messages.length === 1 && !('continuation' in switched.body))
  await page.select(effortSelect, 'high')
  const effort = await submitAndWait('Объясни разницу между доходом и прибылью')
  check('effort change starts a fresh exact model context', effort.body.selection.effort === 'high' && !('continuation' in effort.body))
  await clickText('Новый контекст')
  const reset = await submitAndWait('Привет ещё раз')
  check('explicit new context clears the previous continuation', !('continuation' in reset.body))
  await page.evaluate(() => { globalThis.__frontierMode = 'missing' })
  const beforeMissing = (await calls()).length
  await send('Расскажи короткую шутку'); await waitText('Подключите ключ выбранного провайдера')
  check('missing key is visible and never silently falls back', (await calls()).length === beforeMissing + 1 && (await calls()).at(-1).body.selection.model === 'claude-fable-5-1')
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, modelSelect)
  await page.evaluate(() => { globalThis.__frontierMode = 'invalid-continuation' })
  await send('Продолжи пояснение'); await waitText('Следующий запрос начнёт новый диалог')
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, modelSelect)
  await page.evaluate(() => { globalThis.__frontierMode = 'ok' })
  const recovered = await submitAndWait('Начни сначала')
  check('rejected continuation is cleared for the next request', !('continuation' in recovered.body))
  await page.evaluate(() => { globalThis.__frontierMode = 'context-limit' })
  const contextLimitCall = (await calls()).length + 1
  await send('Продолжи после заполнения контекста')
  await page.waitForFunction(count => globalThis.__frontierCalls.length === count, {}, contextLimitCall)
  await page.waitForFunction(selector => !document.querySelector(selector).disabled, {}, modelSelect)
  await page.evaluate(() => { globalThis.__frontierMode = 'ok' })
  const afterContextLimit = await submitAndWait('Начни новый короткий разговор')
  check('CONTEXT_LIMIT clears the previous continuation so the next request can recover', (await calls()).find(call => call.id === contextLimitCall).body.continuation === `MOCK_CONTINUATION_${recovered.id}` && !('continuation' in afterContextLimit.body))

  await page.evaluate(() => { globalThis.__frontierMode = 'hold' })
  await send('Синтетический медленный запрос')
  await page.waitForFunction(() => Object.keys(globalThis.__frontierPending).length === 1)
  const heldId = (await calls()).at(-1).id
  check('in-flight requests disable model and effort changes', await page.$eval(modelSelect, select => select.disabled) && await page.$eval(effortSelect, select => select.disabled))
  await clickText('Остановить ожидание'); await waitText('Ожидание остановлено')
  check('Stop aborts the underlying scoped request', (await calls()).find(call => call.id === heldId).aborted)
  await page.evaluate(() => { globalThis.__frontierMode = 'hold' })
  await send('Новый запрос после остановки')
  await page.waitForFunction(() => globalThis.__frontierCalls.at(-1).body.messages[0].content === 'Новый запрос после остановки')
  const activeId = (await calls()).at(-1).id
  await page.evaluate(id => globalThis.__frontierPending[id]('FORBIDDEN-LATE-OLD-RESPONSE'), heldId)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)))
  check('late old completion is ignored and cannot clear the newer busy state', !(await bodyText()).includes('FORBIDDEN-LATE-OLD-RESPONSE') && await page.$eval(modelSelect, select => select.disabled))
  await page.evaluate(id => globalThis.__frontierPending[id]('CURRENT-RESPONSE-OK'), activeId); await waitText('CURRENT-RESPONSE-OK')

  await page.select(modelSelect, 'fast')
  await page.evaluate(() => { globalThis.__frontierMode = 'ok' })
  const fast = await submitAndWait('Новый быстрый вопрос')
  check('switching to fast does not import previous frontier history', !fast.body.selection && fast.body.messages.length === 1 && fast.body.model === 'openai/gpt-4o-mini')
  await page.select(modelSelect, 'gpt-6-astra')
  await page.evaluate(() => { globalThis.__frontierMode = 'hold' })
  await send('PRIVATE-OLD-USER-QUERY')
  await page.waitForFunction(() => globalThis.__frontierCalls.at(-1).body.messages[0].content === 'PRIVATE-OLD-USER-QUERY')
  const identityHeld = (await calls()).at(-1).id
  await page.evaluate(() => globalThis.__setFrontierUser(null))
  await page.waitForFunction(() => !document.body.innerText.includes('PRIVATE-OLD-USER-QUERY'))
  check('sign-out immediately aborts the held request and clears the conversation', (await calls()).find(call => call.id === identityHeld).aborted)
  await page.evaluate(() => globalThis.__setFrontierUser({ id: 'user-2', email: 'synthetic-two@example.invalid' }))
  await page.waitForFunction(selector => document.querySelector(selector)?.value === 'fast', {}, modelSelect)
  await page.evaluate(id => globalThis.__frontierPending[id]('PRIVATE-OLD-USER-ANSWER'), identityHeld)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)))
  check('late signed-out result cannot enter the next user conversation', !(await bodyText()).includes('PRIVATE-OLD-USER-ANSWER') && !(await bodyText()).includes('MOCK-REPLY-1'))
  await page.select(modelSelect, 'gpt-6-astra')
  await page.evaluate(() => { globalThis.__frontierMode = 'ok' })
  const freshUser = await submitAndWait('Привет от нового пользователя')
  check('new user begins without previous user continuation', !('continuation' in freshUser.body))

  await freshIdentity('image-preflight-three')
  await attachImages([{ name: 'first.png' }, { name: 'second.png' }, { name: 'third.png' }])
  const beforeThreeImages = (await calls()).length
  await send('Объясни эти изображения'); await waitText('Не удалось подготовить изображения')
  check('three images fail before transport and all originals plus draft remain', (await calls()).length === beforeThreeImages && await page.$eval('textarea', input => input.value === 'Объясни эти изображения') && (await bodyText()).includes('first.png') && (await bodyText()).includes('second.png') && (await bodyText()).includes('third.png'))
  await freshIdentity('image-preflight-large')
  await attachImages([{ name: 'too-large.png', size: 20 * 1024 * 1024 + 1 }])
  const beforeLargeImage = (await calls()).length
  await send('Объясни изображение'); await waitText('Не удалось подготовить изображения')
  check('over-20-MiB image fails before transport without clearing the input', (await calls()).length === beforeLargeImage && await page.$eval('textarea', input => input.value === 'Объясни изображение') && (await bodyText()).includes('too-large.png'))

  await freshIdentity('image-decode-failure')
  await attachImages([{ name: 'held-decode.png' }])
  await page.evaluate(() => {
    globalThis.__originalCreateImageBitmap = globalThis.createImageBitmap
    globalThis.createImageBitmap = () => new Promise((_resolve, reject) => { globalThis.__rejectImageDecode = reject })
  })
  const beforeDecode = (await calls()).length
  await send('Описание изображения')
  await page.waitForFunction(() => !!globalThis.__rejectImageDecode)
  check('draft and image remain visible while decoding is pending', await page.$eval('textarea', input => input.value === 'Описание изображения') && (await bodyText()).includes('held-decode.png'))
  await page.type('textarea', ' — уточнение')
  await page.evaluate(() => { globalThis.__rejectImageDecode(new Error('synthetic decode failure')); globalThis.createImageBitmap = globalThis.__originalCreateImageBitmap })
  await waitText('Не удалось подготовить изображения')
  check('late decode failure preserves the edited draft and does not call a model', (await calls()).length === beforeDecode && await page.$eval('textarea', input => input.value === 'Описание изображения — уточнение') && (await bodyText()).includes('held-decode.png'))

  await freshIdentity('image-encoded-limit')
  await attachImages([{ name: 'small-original.png', valid: true }])
  await page.evaluate(() => {
    globalThis.__originalCanvasToBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = callback => { globalThis.__oversizedOutputProduced = true; callback(new Blob([new Uint8Array(350_000)], { type: 'image/jpeg' })) }
  })
  const beforeEncoded = (await calls()).length
  await send('Распознай изображение'); await waitText('Не удалось подготовить изображения')
  check('over-400k encoded image fails before transport and preserves the original', await page.evaluate(() => !!globalThis.__oversizedOutputProduced) && (await calls()).length === beforeEncoded && await page.$eval('textarea', input => input.value === 'Распознай изображение') && (await bodyText()).includes('small-original.png'))
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = globalThis.__originalCanvasToBlob })

  await freshIdentity('image-success-pair')
  await attachImages([{ name: 'valid-first.png', valid: true }, { name: 'valid-second.png', valid: true }])
  const imageAnswer = await submitAndWait('Опиши эти изображения')
  check('both valid images reach the chosen model without filtering or slicing', imageAnswer.body.messages.length === 1 && imageAnswer.body.messages[0].content.length === 3 && imageAnswer.body.messages[0].content.slice(1).every(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,')))
  check('successful image preparation clears submitted draft and attachment chips', await page.$eval('textarea', input => input.value === '') && await page.$eval('form', form => !form.innerText.includes('valid-first.png') && !form.innerText.includes('valid-second.png')))

  await freshIdentity('document-priority-user')
  await attachImages([{ name: 'document-first.png' }, { name: 'document-second.png' }, { name: 'document-third.png' }])
  const beforeDocument = (await calls()).length
  await send('Сделай Word: описание интерфейса'); await waitText('Принял запрос — готовлю файл')
  check('explicit document creation retains precedence over direct image preflight', await page.$eval('textarea', input => input.value === '') && (await calls()).slice(beforeDocument).every(call => !call.body.selection))

  await freshIdentity('artifact-route-user')
  const beforeArtifact = (await calls()).length
  await send('Проанализируй расходы по выписке')
  await page.waitForSelector('a[href="/app/finance"]')
  check('explicit finance command retains the configured artifact route', (await calls()).length === beforeArtifact)
  await page.setViewport({ width: 390, height: 844 })
  check('selector has an accessible label on mobile', await page.$eval(modelSelect, select => Boolean(select.closest('label'))))
  check('model and effort selectors fit the mobile viewport', await page.evaluate(selectors => selectors.every(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth }), [modelSelect, effortSelect]))
  await page.$eval(modelSelect, select => select.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await page.screenshot({ path: path.join(out, 'frontier-mobile.png'), fullPage: false })
  check('no browser runtime errors', errors.length === 0)
  const sourceAfter = hashes()
  check('reviewed source files stayed unchanged during the probe', JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter))
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: checks.length, checks, errors, sourceBefore, sourceAfter, externalNetworkBlocked: true, backend: 'mocked' }, null, 2))
} catch (error) {
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, passed: checks.length, checks, errors, sourceBefore, sourceAfter: hashes() }, null, 2))
  throw error
} finally {
  if (browser) await browser.close()
}
