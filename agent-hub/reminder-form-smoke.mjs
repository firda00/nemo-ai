// Reminder panel — MOUNTED FORM smoke against a per-user mocked backend (permanent, in the
// gate). The REAL ReminderPanel runs with the real bounded helpers, real i18n and the real
// session-scope ownership, while the smoke flips the signed-in identity live:
//   1. a verified account renders its schedules, the ALWAYS-visible clamp note, and history
//      with TRANSLATED terminal reasons (no raw slugs);
//   2. a create saves, reloads, and the confirmation SURVIVES the reload;
//   3. the atomic server cap refusal is phrased visibly;
//   4. an unverified account gets the verification banner with a real anchor link;
//   5. an account switch hides the previous user's schedules immediately;
//   6. a load still pending at the switch never repopulates the new identity's panel;
//   7. a SAVE still pending at the switch neither locks nor unlocks the new identity's
//      controls — the new user saves independently while the old request settles late;
//   8. logout + login as the same user is a NEW scope: fresh load, draft cleared.
// Offline: no vite server, no network — a built bundle served from file://. No paid calls.
// Run: npm run test:reminder-form   (exits non-zero on any failure)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'reminder-form')
fs.mkdirSync(artifacts, { recursive: true })
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-reminder-form-'))
const bundlePath = path.join(buildDir, 'harness.js')
const mockSupabasePath = path.join(root, 'agent-hub', 'reminder-harness', 'mock-supabase.ts')
const mockAuthPath = path.join(root, 'agent-hub', 'margin-harness', 'mock-auth.ts') // shared reactive auth mock
const supabaseReal = path.join(root, 'src', 'lib', 'supabase')
const authReal = path.join(root, 'src', 'context', 'AuthContext')

await esbuild.build({
  entryPoints: [path.join(root, 'agent-hub', 'reminder-harness', 'entry.tsx')],
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
const setUser = (user) => page.evaluate((value) => globalThis.__setMarginUser(value), user)
const waitForText = (needle) => page.waitForFunction(
  (text) => (document.body.innerText ?? '').includes(text), { timeout: 10_000 }, needle,
)
const addDisabled = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /Добавить|Сохранить/.test(b.textContent ?? ''))
  return btn ? btn.disabled : null
})
const typeTitle = async (value) => {
  await page.evaluate(() => { const input = document.querySelector('input[maxlength="200"]'); if (input) input.value = '' })
  await page.type('input[maxlength="200"]', value)
}
const clickAdd = () => page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /Добавить|Сохранить/.test(b.textContent ?? ''))
  btn?.click()
})

try {
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`)
  })
  const htmlPath = path.join(buildDir, 'harness.html')
  fs.writeFileSync(htmlPath, '<!doctype html><html><body><div id="root"></div><script src="harness.js"></script></body></html>')
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 15_000 })
  await page.waitForFunction('globalThis.__harnessReady === true', { timeout: 10_000 })
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'ru'))

  const SCENARIOS = {
    'user-1': {
      list: {
        schedules: [{ id: 'sch-a', title: 'Аренда офиса', day_of_month: 20, send_minute: 540, enabled: true, schedule_revision: 1 }],
        occurrences: [{ schedule_id: 'sch-a', month_key: '2026-08', due_date: '2026-08-20', status: 'skipped', error: 'pre_consent' }],
        recipient: { verified: true, channel_bound: true },
      },
    },
    'user-2': { list: { schedules: [], occurrences: [], recipient: { verified: false, channel_bound: true } } },
    'user-3': { list: 'DEFER' },
    'user-4': {
      list: { schedules: [{ id: 'sch-b', title: 'Налоговый отчёт', day_of_month: 10, send_minute: 600, enabled: false, schedule_revision: 1 }], occurrences: [], recipient: { verified: true, channel_bound: true } },
      saveMode: 'DEFER',
    },
    'user-5': { list: { schedules: [], occurrences: [], recipient: { verified: true, channel_bound: true } } },
  }

  // 1) verified account: schedules, the always-visible clamp note, translated history reasons
  await setUser({ id: 'user-1' })
  await page.evaluate((scenarios) => globalThis.__mountReminder(scenarios), SCENARIOS)
  await waitForText('Аренда офиса')
  let text = await bodyText()
  check('the schedule renders with its cadence and status', text.includes('каждое 20-е число') && text.includes('09:00') && text.includes('Включено'))
  check('the clamp policy is ALWAYS on screen', text.includes('ПОСЛЕДНИЙ день месяца'))
  check('history shows the translated reason, never the raw slug', text.includes('дата раньше текущего согласия') && !text.includes('pre_consent'))

  // 2) create → reload → the confirmation survives
  await typeTitle('Сдать отчёт')
  await clickAdd()
  await waitForText('Сохранено.')
  text = await bodyText()
  check('the created schedule is in the reloaded list AND the confirmation survived it', text.includes('Сдать отчёт') && text.includes('Сохранено.'))

  // 3) the atomic server cap refusal is phrased
  await page.evaluate(() => { globalThis.__reminder['user-1'].saveMode = { reason: 'schedule_limit' } })
  await typeTitle('Ещё одно')
  await clickAdd()
  await waitForText('Достигнут лимит напоминаний')
  check('the server cap refusal is visible and phrased', true)

  // 4) unverified account: banner + a real anchor to the verification flow
  await setUser({ id: 'user-2' })
  await waitForText('нужен проверенный получатель')
  const anchor = await page.evaluate(() => document.querySelector('a[href="#briefing-panel"]') !== null)
  check('the verification banner links to the briefing verify flow', anchor)
  text = await bodyText()
  check('the previous user’s schedules are hidden after the switch', !text.includes('Аренда офиса') && !text.includes('Сдать отчёт'))

  // 5/6) a load still pending at the switch never repopulates the next identity
  await setUser({ id: 'user-3' }) // list deferred — panel shows loading
  await delay(100)
  await setUser({ id: 'user-4' })
  await waitForText('Налоговый отчёт')
  await page.evaluate(() => {
    // the OLD identity's load settles late, with rows that must never appear
    globalThis.__reminderDefer['user-3']?.shift()?.({
      data: { ok: true, schedules: [{ id: 'sch-x', title: 'СтарыеДанные', day_of_month: 1, send_minute: 0, enabled: false, schedule_revision: 1 }], occurrences: [], recipient: { verified: true, channel_bound: true } },
      error: null,
    })
  })
  await delay(150)
  text = await bodyText()
  check('a late load from the previous identity changes nothing', text.includes('Налоговый отчёт') && !text.includes('СтарыеДанные'))

  // 7) a pending SAVE does not travel across identities
  await typeTitle('Висящий черновик')
  await clickAdd() // user-4 save is deferred — busy for user-4
  await delay(100)
  check('the saving identity is busy', await addDisabled() === true)
  await setUser({ id: 'user-5' })
  await waitForText('Напоминаний пока нет')
  check('the new identity’s controls are NOT locked by the old pending save', await addDisabled() === false)
  await typeTitle('Свежее напоминание')
  await clickAdd()
  await waitForText('Сохранено.')
  check('the new identity saves independently', (await bodyText()).includes('Свежее напоминание'))
  await page.evaluate(() => {
    globalThis.__reminderDefer['user-4']?.shift()?.({ data: { ok: true, schedule: {} }, error: null })
  })
  await delay(150)
  text = await bodyText()
  check('the old save settling late changes nothing for the current identity',
    text.includes('Свежее напоминание') && !text.includes('Висящий черновик') && await addDisabled() === false)

  // 8) logout + login as the SAME user is a new scope: fresh load, clean draft
  const callsBefore = await page.evaluate(() => globalThis.__reminderCalls.filter((c) => c.uid === 'user-5' && c.action === 'list').length)
  await typeTitle('Черновик до выхода')
  await setUser(null)
  await delay(80)
  await setUser({ id: 'user-5' })
  await waitForText('Свежее напоминание') // the reloaded list carries user-5's own earlier save
  const callsAfter = await page.evaluate(() => globalThis.__reminderCalls.filter((c) => c.uid === 'user-5' && c.action === 'list').length)
  const draft = await page.evaluate(() => document.querySelector('input[maxlength="200"]')?.value ?? null)
  check('re-login reloads fresh and the previous draft is gone', callsAfter > callsBefore && draft === '')

  // 9) monthly report kind: currency appears, the created schedule carries the badge
  const SOURCES_12 = Array.from({ length: 12 }, (_v, index) => ({
    file_sha256: String(index).padStart(64, '0'),
    file_name: index === 11 ? 'старый-архив.xlsx' : `файл-${index}.xlsx`,
    uploaded_at: `2026-08-${String(28 - index).padStart(2, '0')}T10:00:00Z`,
    period_month: null,
  }))
  const OLD_SHA = String(11).padStart(64, '0')
  await setUser({ id: 'user-8' })
  await page.evaluate((scenarios) => globalThis.__mountReminder(scenarios), {
    ...SCENARIOS,
    'user-8': { list: { schedules: [], occurrences: [], recipient: { verified: true, channel_bound: true } }, sources: SOURCES_12 },
  })
  await waitForText('Напоминаний пока нет')
  await page.select('select', 'product_report') // the first select is the kind
  await waitForText('Валюта')
  text = await bodyText()
  check('choosing the report kind reveals currency, inclusive cutoff and date refusal',
    text.includes('Валюта') && text.includes('с начала месяца по запланированную дату включительно') &&
    text.includes('При отсутствующих или неоднозначных датах отправка остановится'))
  await page.screenshot({ path: path.join(artifacts, 'monthly-report-period.png'), fullPage: true })
  await typeTitle('Отчёт по продукту')
  await clickAdd()
  await waitForText('Сохранено.')
  text = await bodyText()
  check('the created report schedule carries the kind badge and its currency', text.includes('📊') && text.includes('UZS'))

  // 10) pagination: an OLDER file is reachable via load-more and can get its period declared
  check('the first source page renders with a load-more control',
    text.includes('файл-0.xlsx') && !text.includes('старый-архив.xlsx') && text.includes('Показать ещё'))
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Показать ещё')
    btn?.click()
  })
  await waitForText('старый-архив.xlsx')
  check('the older file appears from the deeper page', true)
  // the user is DRAFTING a report schedule while assigning the source period — the refresh
  // caused by set-period must not eat the draft
  await page.select('select', 'product_report')
  await waitForText('Валюта')
  await typeTitle('Черновик отчёта')
  await page.evaluate((oldSha) => {
    const item = [...document.querySelectorAll('li')].find((li) => (li.textContent ?? '').includes('старый-архив'))
    if (!item) throw new Error('older source row not found')
    const input = item.querySelector('input[type="month"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '2026-08')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const assign = [...item.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Назначить период'))
    assign?.click()
    void oldSha
  }, OLD_SHA)
  await waitForText('Сохранено.')
  const setCall = await page.evaluate(() => globalThis.__reminderCalls.filter((c) => c.action === 'set-period').at(-1))
  check('the period declaration targeted the OLDER file via the sha', setCall?.sha === OLD_SHA)
  const draftAfterPeriod = await page.evaluate(() => ({
    title: document.querySelector('input[maxlength="200"]')?.value ?? null,
    kind: document.querySelector('select')?.value ?? null,
  }))
  check('the schedule DRAFT survives the source-period refresh',
    draftAfterPeriod.title === 'Черновик отчёта' && draftAfterPeriod.kind === 'product_report' && (await bodyText()).includes('Валюта'))
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Показать ещё')
    btn?.click()
  })
  await waitForText('старый-архив.xlsx')
  check('after the reload the older file shows its declared period', (await bodyText()).includes('2026-08'))

  // 11) an unavailable source list is VISIBLE with a retry — never silently hidden
  await setUser({ id: 'user-9' })
  await page.evaluate((scenarios) => globalThis.__mountReminder(scenarios), {
    'user-9': {
      list: { schedules: [{ id: 'sch-r', title: 'Отчёт', day_of_month: 5, send_minute: 540, enabled: false, schedule_revision: 1, kind: 'product_report', report_currency: 'USD' }], occurrences: [], recipient: { verified: true, channel_bound: true } },
      sources: 'NULL',
    },
  })
  await waitForText('Не удалось загрузить список файлов')
  check('the sources outage renders with a retry, not an empty picker', true)
  await page.evaluate(() => { globalThis.__reminder['user-9'].sources = [{ file_sha256: 'e'.repeat(64), file_name: 'вернулся.xlsx', uploaded_at: '2026-08-01T10:00:00Z', period_month: null }] })
  await page.evaluate(() => {
    const failed = [...document.querySelectorAll('p')].find((p) => (p.textContent ?? '').includes('Не удалось загрузить список файлов'))
    const retry = failed ? [...failed.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Повторить')) : null
    retry?.click()
  })
  await waitForText('вернулся.xlsx')
  check('the sources retry reloads the picker', true)

  // 12) the clamp promise and terminal reasons render in UZ and EN too, not only RU
  await setUser({ id: 'user-1' })
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'uz'))
  await page.evaluate((scenarios) => globalThis.__mountReminder(scenarios), SCENARIOS)
  await waitForText('Аренда офиса')
  text = await bodyText()
  check('UZ: clamp note and translated reason render', text.includes('OXIRGI kunida') && text.includes('sana joriy rozilikdan oldin'))
  await page.select('select', 'product_report')
  await waitForText('Valyuta')
  text = await bodyText()
  check('UZ: monthly report explains cutoff and missing-date refusal', text.includes('oyning boshidan rejalashtirilgan sanagacha') && text.includes('Sana yo‘q yoki noaniq bo‘lsa, yuborish to‘xtaydi'))
  await page.evaluate(() => localStorage.setItem('nemo.lang', 'en'))
  await page.evaluate((scenarios) => globalThis.__mountReminder(scenarios), SCENARIOS)
  await waitForText('Аренда офиса')
  text = await bodyText()
  check('EN: clamp note and translated reason render', text.includes('LAST day of the month') && text.includes('date precedes current consent'))
  await page.select('select', 'product_report')
  await waitForText('Currency')
  text = await bodyText()
  check('EN: monthly report explains cutoff and missing-date refusal', text.includes('first day through the scheduled date') && text.includes('Missing or ambiguous dates stop delivery'))

  check('no runtime errors across the flow', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error(`[FAIL] reminder-form-smoke crashed: ${error instanceof Error ? error.message : String(error)}`)
  try { console.error(`runtime errors: ${runtimeErrors.slice(0, 5).join(' | ') || '(none)'}`) } catch { /* diagnostics */ }
} finally {
  try { if (page) await page.screenshot({ path: path.join(artifacts, 'reminder-form.png'), fullPage: true }) } catch { /* best effort */ }
  try { if (browser) await browser.close() } catch { /* best effort */ }
}

if (failed > 0) { console.error(`reminder-form-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('Reminder-panel MOUNTED form smoke passed (per-user backend, live identity switches).')
