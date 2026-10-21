// Проверки центра подключений (постоянные, в гейте качества).
// Каталог интеграций переехал: /app/integrations теперь редиректит в Settings → Directory
// (модальный каталог возможностей). Прогон поднимает приложение в ДЕМО-режиме и проверяет:
//   1. редирект /app/integrations → /app/settings?tab=integrations&directory=connectors,
//      и Directory действительно открыт;
//   2. поиск фильтрует провайдеров;
//   3. фокус Google Workspace НЕ показывает чужие формы ключей (только GoogleSetup);
//   4. у OpenAI есть форма прямого ключа (write-only поле);
//   5. недоступный провайдер (без рабочего исполнителя) НЕ предлагает поле ключа;
//   6. «Назад» возвращает к каталогу, «Закрыть» скрывает Directory;
//   7. панель Directory непрозрачна в светлой И тёмной темах (меряется альфа, не класс);
//   8. мобильная вёрстка: панель на всю ширину, боковая колонка скрыта, табы-чипы видны.
// Запуск: npm run test:integrations-ui   (ненулевой код возврата при любом падении)
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const baseUrl = 'http://127.0.0.1:4176'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'integrations-ui')
fs.mkdirSync(artifacts, { recursive: true })

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4176 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4176', '--strictPort']
const server = spawn(command, args, {
  cwd: root,
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, // force DEMO mode
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
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {}
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

const DIALOG = '[role="dialog"][aria-label="Nemo Directory"]'

// клик по карточке коннектора с точным названием
async function openConnector(page, title) {
  return page.evaluate((wanted) => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Nemo Directory"]')
    if (!dialog) return false
    const card = [...dialog.querySelectorAll('button')].find((b) => b.querySelector('.font-semibold')?.textContent?.trim() === wanted)
    if (!card) return false
    card.click()
    return true
  }, title)
}

async function goBack(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('[role="dialog"] header button[aria-label="Назад"]')
    if (!btn) return false
    btn.click()
    return true
  })
}

// состояние открытой детали: есть ли write-only поля ключей и текст панели
async function detailState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Nemo Directory"]')
    if (!dialog) return null
    return {
      heading: dialog.querySelector('header h3')?.textContent?.trim() ?? '',
      keyInputs: dialog.querySelectorAll('input[autocomplete="new-password"]').length,
      text: dialog.textContent ?? '',
    }
  })
}

async function panelAlpha(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Nemo Directory"]')
    const panel = dialog?.querySelector(':scope > div.relative')
    if (!panel) return null
    const bg = getComputedStyle(panel).backgroundColor
    const nums = (bg.match(/[\d.]+/g) ?? []).map(Number)
    return { bg, alpha: nums.length >= 4 ? nums[3] : 1 }
  })
}

let browser
let page
try {
  await waitForServer()
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  const runtimeErrors = []
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/i.test(message.text())) runtimeErrors.push(`console: ${message.text()}`)
  })

  await page.goto(baseUrl + '/', { waitUntil: 'networkidle0', timeout: 30_000 })
  await page.evaluate(() => {
    localStorage.setItem('nemo.lang', 'ru')
    localStorage.setItem('nemo.user', JSON.stringify({
      id: 'int-smoke', email: 'int@nemo.local', name: 'Integrations Smoke', lang: 'ru', role: 'user',
      onboardingCompleted: true, createdAt: '2026-07-10', quotaUsed: 0, quotaLimit: 100,
    }))
  })

  // 1) редирект старого маршрута в Settings Directory
  await page.goto(baseUrl + '/app/integrations', { waitUntil: 'networkidle0', timeout: 30_000 })
  await delay(500)
  check('старый маршрут ведёт в Settings Directory', page.url().includes('/app/settings') && page.url().includes('directory=connectors'), page.url())
  check('Directory открыт', Boolean(await page.$(DIALOG)))
  const light = await panelAlpha(page)
  check('панель Directory непрозрачна (светлая тема)', light && light.alpha >= 0.98, JSON.stringify(light))

  // 2) поиск фильтрует провайдеров
  const searchSel = `${DIALOG} header input`
  await page.click(searchSel)
  await page.type(searchSel, 'Replicate', { delay: 10 })
  await delay(250)
  const filtered = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Nemo Directory"]')
    const cards = [...dialog.querySelectorAll('button')].map((b) => b.querySelector('.font-semibold')?.textContent?.trim()).filter(Boolean)
    return cards
  })
  check('поиск оставляет только найденного провайдера', filtered.length === 1 && filtered[0] === 'Replicate', JSON.stringify(filtered))
  // очистка контролируемого React-поля: только нативный сеттер + событие input надёжен в headless
  await page.evaluate(() => {
    const input = document.querySelector('[role="dialog"] header input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await delay(300)

  // 3) фокус Google Workspace не тащит чужие формы ключей
  check('карточка Google Workspace открывается', await openConnector(page, 'Google Workspace'))
  await delay(350)
  let detail = await detailState(page)
  check('фокус Google: заголовок детали', detail?.heading === 'Google Workspace', detail?.heading)
  check('фокус Google: нет чужих полей ключей', detail?.keyInputs === 0, `полей: ${detail?.keyInputs}`)
  check('«Назад» возвращает к каталогу', await goBack(page))
  await delay(300)

  // 4) прямая форма ключа OpenAI
  check('карточка OpenAI открывается', await openConnector(page, 'OpenAI'))
  await delay(350)
  detail = await detailState(page)
  check('OpenAI: есть write-only поле ключа', (detail?.keyInputs ?? 0) >= 1, `полей: ${detail?.keyInputs}`)
  check('OpenAI: описана прямая генерация', /GPT Image/i.test(detail?.text ?? ''))
  await goBack(page)
  await delay(300)

  // 5) недоступный провайдер не предлагает сохранить ключ
  check('карточка Anthropic открывается', await openConnector(page, 'Anthropic'))
  await delay(350)
  detail = await detailState(page)
  check('недоступный провайдер: поля ключа нет', detail?.keyInputs === 0, `полей: ${detail?.keyInputs}`)
  check('недоступный провайдер: есть честное объяснение', /Ключ нельзя сохранить/.test(detail?.text ?? '') && /Скоро/.test(detail?.text ?? ''))
  await goBack(page)
  await delay(300)

  // 6) закрытие Directory
  await page.evaluate(() => { document.querySelector('[role="dialog"] header button[aria-label="Закрыть"]')?.click() })
  await delay(400)
  check('«Закрыть» скрывает Directory', !(await page.$(DIALOG)))
  await page.screenshot({ path: path.join(artifacts, 'integrations-light.png'), fullPage: false })

  // 7) тёмная тема: панель тоже непрозрачна
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.goto(baseUrl + '/app/integrations', { waitUntil: 'networkidle0', timeout: 30_000 })
  await delay(500)
  const darkBody = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const darkApplied = (darkBody.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).every((v) => v < 80)
  check('тёмная тема применилась', darkApplied, `фон страницы ${darkBody}`)
  const dark = await panelAlpha(page)
  check('панель Directory непрозрачна (тёмная тема)', dark && dark.alpha >= 0.98, JSON.stringify(dark))
  await page.screenshot({ path: path.join(artifacts, 'integrations-dark.png'), fullPage: false })

  // 8) мобильная вёрстка
  await page.setViewport({ width: 390, height: 844 })
  await page.goto(baseUrl + '/app/integrations', { waitUntil: 'networkidle0', timeout: 30_000 })
  await delay(500)
  const mobile = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Nemo Directory"]')
    const panel = dialog?.querySelector(':scope > div.relative')
    if (!panel) return null
    const aside = panel.querySelector('aside')
    const tabChips = [...panel.querySelectorAll('header div button')].map((b) => b.textContent?.trim()).filter(Boolean)
    return {
      width: Math.round(panel.getBoundingClientRect().width),
      asideHidden: !aside || getComputedStyle(aside).display === 'none',
      tabChips,
      scrollX: document.documentElement.scrollWidth <= window.innerWidth,
    }
  })
  check('мобайл: панель на всю ширину', Boolean(mobile) && mobile.width >= 380, JSON.stringify(mobile))
  check('мобайл: боковая колонка скрыта', Boolean(mobile?.asideHidden))
  check('мобайл: табы-чипы доступны', Boolean(mobile?.tabChips?.some((t) => /Навыки|Подключения|Плагины/.test(t))), JSON.stringify(mobile?.tabChips))
  check('мобайл: нет горизонтального скролла страницы', Boolean(mobile?.scrollX))
  await page.screenshot({ path: path.join(artifacts, 'integrations-mobile.png'), fullPage: false })

  check('без ошибок в консоли', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))
} catch (error) {
  failed += 1
  console.error('[FAIL] прогон не состоялся:', error.message)
} finally {
  if (browser) await browser.close()
  stopServer()
}

if (failed) {
  console.error(`Integrations UI: ${failed} проверок упало.`)
  process.exit(1)
}
console.log('Все проверки центра подключений пройдены.')
