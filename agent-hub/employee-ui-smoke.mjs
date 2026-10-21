// Independent mounted UI review: real EmployeesPage, catalog/config constructor,
// i18n and React Router. Store/auth are explicit synthetic fixtures. Network blocked.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import tailwindConfig from '../tailwind.config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'agent-hub/artifacts/employee-deploy-stage/employee-ui')
fs.mkdirSync(out, { recursive: true })
const sources = ['src/pages/app/EmployeesPage.tsx', 'src/data/employeePresets.ts', 'src/i18n/employees.ts', 'src/App.tsx', 'src/pages/app/AgentsPage.tsx']
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]))
const sourceBefore = hashes()
await build({ entryPoints: [path.join(root, 'agent-hub/employee-harness/entry.tsx')], outfile: path.join(out, 'harness.js.snapshot'),
  bundle: true, format: 'iife', jsx: 'automatic', charset: 'utf8', logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  plugins: [{ name: 'employee-ui-offline', setup(bundler) {
    bundler.onResolve({ filter: /(?:supabase|AuthContext|useAgentStore)$/ }, args => {
      const file = path.resolve(args.resolveDir, args.path)
      if (file === path.join(root, 'src/lib/supabase')) return { path: 'offline-supabase', namespace: 'employee-fixture' }
      if (file === path.join(root, 'src/context/AuthContext')) return { path: path.join(root, 'agent-hub/employee-harness/mock-auth.ts') }
      if (file === path.join(root, 'src/store/useAgentStore')) return { path: path.join(root, 'agent-hub/employee-harness/mock-store.ts') }
    })
    bundler.onLoad({ filter: /.*/, namespace: 'employee-fixture' }, () => ({ contents: 'export const isSupabaseEnabled=true;', loader: 'js' }))
  } }],
})
const cssSource = path.join(root, 'src/index.css')
const styled = await postcss([tailwindcss(tailwindConfig), autoprefixer]).process(fs.readFileSync(cssSource, 'utf8').replace(/^@import[^\n]*\r?\n/gm, ''), { from: cssSource })
fs.writeFileSync(path.join(out, 'harness.css'), styled.css)
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="harness.css"></head><body><div id="root"></div><script src="harness.js.snapshot"></script></body></html>')
const checks = [], pageErrors = []
let browser, page
const check = (name, condition) => { assert(condition, name); checks.push(name); console.log('[OK] ' + name) }
const value = selector => page.$eval(selector, input => input.value)
const fill = async (selector, text) => { await page.$eval(selector, input => { input.focus(); input.select() }); await page.keyboard.press('Backspace'); await page.type(selector, text) }
const calls = () => page.evaluate(() => globalThis.__employeeCalls)
const submit = () => page.$eval('form', form => form.requestSubmit())
const nameInput = '[name=employeeName]', goalInput = '[name=employeeGoal]', contextInput = '[name=employeeContext]'
const mount = async (lang = 'ru', role = '') => {
  await page.evaluate((lang, role) => globalThis.__mountEmployees(lang, role), lang, role)
  await page.waitForFunction((lang, role) => {
    const preset = globalThis.__employeePresets.find(preset => preset.id === role) ?? globalThis.__employeePresets[0]
    return document.documentElement.lang === lang && document.querySelector('h2')?.textContent === preset.title[lang] && !!document.querySelector('[name=employeeName]')
  }, {}, lang, role)
}
const choose = title => page.evaluate(title => [...document.querySelectorAll('aside button')].find(button => button.innerText.startsWith(title))?.click(), title)
const waitError = () => page.waitForSelector('[role=alert]')
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND'] })
  page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => void (request.url().startsWith('file://') ? request.continue() : request.abort()))
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setViewport({ width: 1100, height: 900 })
  await page.goto(new URL('file:///' + path.join(out, 'index.html').replaceAll('\\', '/')).href)
  await page.waitForFunction(() => globalThis.__employeeReady)
  const presets = await page.evaluate(() => globalThis.__employeePresets)
  check('catalog contains ten professions plus a custom role', presets.length === 11 && presets.some(preset => preset.id === 'custom'))
  for (const lang of ['ru', 'uz', 'en']) {
    await mount(lang)
    const names = await page.$$eval('aside button[aria-pressed]', buttons => buttons.map(button => button.innerText.split('\n')[0]))
    check(`${lang} displays every localized profession and custom role`, JSON.stringify(names) === JSON.stringify(presets.map(preset => preset.title[lang])))
    check(`${lang} has localized labels without unresolved translation keys`, !(await page.$eval('main', main => main.innerText)).includes('employees.'))
  }
  await mount('ru', 'seo')
  check('role query selects the requested existing preset', await page.$eval('h2', element => element.textContent) === presets.find(preset => preset.id === 'seo').title.ru)
  await fill(contextInput, 'PRIVATE-COMPANY-CONTEXT\nPreserve full requirements')
  await choose(presets.find(preset => preset.id === 'finance').title.ru)
  check('switching a profession preserves company context', await value(contextInput) === 'PRIVATE-COMPANY-CONTEXT\nPreserve full requirements')
  await fill('input[type=search]', 'no-such-profession')
  check('empty search presents custom-role path', await page.$eval('aside', element => element.innerText.includes('Своя роль')))
  await page.evaluate(() => [...document.querySelectorAll('aside button')].find(button => button.innerText === 'Своя роль').click())
  await page.waitForFunction(() => document.querySelector('h2').textContent === 'Своя роль')
  check('custom role is selected and search reset preserves context', await value('input[type=search]') === '' && await value(contextInput) === 'PRIVATE-COMPANY-CONTEXT\nPreserve full requirements')
  await fill(nameInput, 'My custom colleague')
  await fill(goalInput, 'Find the evidence and produce a verifiable result.')
  const chosenModel = await page.$eval('select:not(:has(option[value="ru"]))', select => select.options[1].value)
  await page.select('select:not(:has(option[value="ru"]))', chosenModel)
  await page.select('select:has(option[value="ru"])', 'uz')
  await page.evaluate(() => { globalThis.__employeeSaveMode = 'hold'; document.querySelector('form').requestSubmit(); document.querySelector('form').requestSubmit() })
  await page.waitForFunction(() => globalThis.__employeeCalls.length === 1)
  check('synchronous double submit makes one store call and disables form', (await calls()).length === 1 && await page.$eval('fieldset', fieldset => fieldset.disabled))
  const first = (await calls())[0]
  check('actual config payload is a draft with approval policy, no channels and full context', first.status === 'draft' && first.actionPolicy === 'approval_required' && first.channels.length === 0 && first.templateKey === 'employee:custom' && first.niche === 'PRIVATE-COMPANY-CONTEXT\nPreserve full requirements' && first.prompt.tasks.includes('PRIVATE-COMPANY-CONTEXT') && first.model === chosenModel && first.language === 'uz' && /^[0-9a-f-]{36}$/.test(first.id))
  await page.evaluate(() => globalThis.__employeePending.shift()({ id: '', error: 'Synthetic unknown result' }))
  await waitError()
  check('save failure preserves every form field and selected role', await value(nameInput) === 'My custom colleague' && await value(goalInput) === 'Find the evidence and produce a verifiable result.' && await value(contextInput) === 'PRIVATE-COMPANY-CONTEXT\nPreserve full requirements' && await value('select:not(:has(option[value="ru"]))') === chosenModel && await value('select:has(option[value="ru"])') === 'uz' && await page.$eval('h2', heading => heading.textContent) === 'Своя роль')
  await page.evaluate(() => { globalThis.__employeeSaveMode = 'error' }); await submit(); await waitError()
  const second = (await calls())[1]
  check('unchanged retry reuses the exact UUID and payload', JSON.stringify(first) === JSON.stringify(second))
  await fill(goalInput, 'Changed completion criteria.'); await submit(); await waitError()
  const third = (await calls())[2]
  check('changed payload receives a new UUID and preserves context', third.id !== first.id && third.purpose === 'Changed completion criteria.' && third.niche === first.niche)

  await mount('ru', 'marketing'); await page.evaluate(() => { globalThis.__employeeCalls = []; globalThis.__employeeSaveMode = 'error' })
  await submit(); await waitError(); const unchangedBefore = (await calls())[0]
  await choose(presets.find(preset => preset.id === 'marketing').title.ru); await submit(); await waitError()
  check('reselecting an unchanged preset cannot create a second retry identity', (await calls())[1].id === unchangedBefore.id)

  await page.evaluate(() => { globalThis.__employeeSaveMode = 'success' }); await submit()
  await page.waitForSelector('[data-testid=saved-agent]')
  check('successful save navigates to the actual returned ID', await page.evaluate(() => globalThis.__employeeLocation) === '/app/agents/returned-persisted-id')
  await mount('ru'); await fill(nameInput, 'PRIVATE-OLD-EMPLOYEE'); await fill(contextInput, 'PRIVATE-OLD-CONTEXT')
  await page.evaluate(() => { globalThis.__employeeSaveMode = 'hold' }); await submit()
  await page.waitForFunction(() => globalThis.__employeePending.length === 1)
  await page.evaluate(() => globalThis.__setEmployeeUser(null))
  await page.waitForFunction(() => document.querySelector('[name=employeeName]').value !== 'PRIVATE-OLD-EMPLOYEE')
  check('sign-out resets employee name and private context immediately', await value(contextInput) === '')
  await page.evaluate(() => globalThis.__setEmployeeUser({ id: 'employee-user-b' }))
  await page.evaluate(() => globalThis.__employeePending.shift()({ id: 'private-old-created-id' }))
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)))
  check('late previous-user save cannot navigate or populate the new form', await page.evaluate(() => globalThis.__employeeLocation) === '/app/employees' && await value(contextInput) === '' && await value(nameInput) !== 'PRIVATE-OLD-EMPLOYEE')
  for (const lang of ['ru', 'uz', 'en']) {
    await mount(lang)
    await page.setViewport({ width: 320, height: 900 })
    check(`${lang} fits 320px without horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('main input, main textarea, main select')].every(element => element.getBoundingClientRect().right <= innerWidth)))
    await page.screenshot({ path: path.join(out, `employees-${lang}-320.png`), fullPage: true })
  }
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8').replace(/\r\n/g, '\n'), agents = fs.readFileSync(path.join(root, 'src/pages/app/AgentsPage.tsx'), 'utf8').replace(/\r\n/g, '\n')
  check('production router exposes EmployeesPage and agent catalog links to it', /path="employees" element=\{<EmployeesPage \/>\}/.test(app) && agents.includes('to="/app/employees"'))
  check('no browser runtime errors', pageErrors.length === 0)
  check('reviewed UI source unchanged during smoke', JSON.stringify(sourceBefore) === JSON.stringify(hashes()))
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: checks.length, checks, pageErrors, sourceHashes: sourceBefore, networkCalls: 0, storeBoundary: 'synthetic mock; actual store tested separately', actualAppRoute: 'source assertion; mounted subset uses real React Router' }, null, 2) + String.fromCharCode(10))
} catch (error) {
  const form = page ? await page.$$eval('input,textarea,select', inputs => inputs.map(input => ({ name: input.name, value: input.value }))) : []
  fs.writeFileSync(path.join(out, 'failed-result.json'), JSON.stringify({ passed: checks.length, checks, pageErrors, error: String(error), form, sourceHashes: sourceBefore }, null, 2) + String.fromCharCode(10))
  throw error
} finally { await browser?.close() }
