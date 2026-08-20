// Проверки страницы интеграций (постоянные, в гейте качества).
// Поднимает приложение в ДЕМО-режиме и проверяет на /app/integrations то, что было сломано:
//   1. полоса фильтров ОДНА — раньше под ней шёл второй ряд таких же чипов (регионы), и вместе
//      они читались как задвоенный список категорий;
//   2. полоса не переносится, а прокручивается — иначе 15 чипов дают 4-5 строк кнопок над каталогом;
//   3. регионы никуда не делись, а свёрнуты в селект: чинить вид ценой возможности нельзя;
//   4. фильтр «Мои интеграции» есть и показывает счётчик подключённых;
//   5. ПАНЕЛЬ ДИАЛОГА НЕПРОЗРАЧНА. Шесть модалок были свёрстаны классом .card с фоном в 4.5%
//      непрозрачности — сквозь диалог просвечивала страница. Проверяется вычисленный альфа-канал,
//      а не имя класса: класс можно переименовать, выцветший фон — нет.
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
  await page.goto(baseUrl + '/app/integrations', { waitUntil: 'networkidle0', timeout: 30_000 })
  await delay(400)

  const bar = await page.evaluate(() => {
    // Полоса фильтров — липкий контейнер над каталогом.
    const sticky = [...document.querySelectorAll('div')].find((el) => el.className.includes?.('sticky') && el.querySelector('input'))
    if (!sticky) return null
    // Ряд считается «рядом чипов», если в нём больше трёх кнопок-таблеток подряд.
    const rows = [...sticky.querySelectorAll(':scope > div')].map((row) => {
      const pills = [...row.querySelectorAll('button')].filter((b) => getComputedStyle(b).borderRadius.startsWith('999'))
      const strip = [...row.querySelectorAll(':scope > div')].concat([row]).find((el) => el.querySelectorAll('button').length > 3)
      const target = strip ?? row
      const cs = getComputedStyle(target)
      return { pills: pills.length, wrap: cs.flexWrap, overflowX: cs.overflowX, height: target.getBoundingClientRect().height }
    })
    return {
      rows,
      selects: sticky.querySelectorAll('select').length,
      inputs: sticky.querySelectorAll('input').length,
      text: sticky.innerText,
    }
  })

  check('панель фильтров найдена', Boolean(bar))
  if (bar) {
    const chipRows = bar.rows.filter((r) => r.pills > 3)
    check('ряд чипов ровно один', chipRows.length === 1, `рядов с чипами: ${chipRows.length}`)
    const strip = chipRows[0]
    if (strip) {
      check('полоса чипов не переносится', strip.wrap === 'nowrap', `flex-wrap=${strip.wrap}`)
      check('полоса чипов прокручивается', ['auto', 'scroll'].includes(strip.overflowX), `overflow-x=${strip.overflowX}`)
      // Один ряд чипов ~34px. Всё, что заметно выше, — это перенос в несколько строк.
      check('полоса занимает одну строку', strip.height < 56, `высота ${Math.round(strip.height)}px`)
    }
    check('регионы свёрнуты в селект, а не удалены', bar.selects === 1, `селектов: ${bar.selects}`)
    check('поле поиска на месте', bar.inputs === 1, `полей ввода: ${bar.inputs}`)
    check('фильтр «Мои интеграции» есть', /Мои интеграции/.test(bar.text), bar.text.slice(0, 120))
  }

  // Открываем модалку подключения и меряем НЕПРОЗРАЧНОСТЬ её панели.
  const modal = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('button')].find((b) => /Подключить|Ulash|Connect/i.test(b.innerText))
    if (!btn) return { opened: false }
    btn.click()
    await wait(400)
    const overlay = [...document.querySelectorAll('div')].find((el) => el.className.includes?.('fixed inset-0'))
    if (!overlay) return { opened: false }
    const panel = [...overlay.querySelectorAll('div')].find((el) => el.className.includes?.('modal-panel') || el.className.includes?.('relative w-full max-w-'))
    if (!panel) return { opened: true, panel: false }
    // Разбираем альфу числами, а не отрезанием по запятой: "rgba(255, 255, 255, 0.043)" даёт
    // последним куском " 0.043)", и Number от него — NaN. Проверка тогда падала бы и на исправной
    // непрозрачной панели, записанной как rgba(30, 41, 59, 1).
    const bg = getComputedStyle(panel).backgroundColor
    const nums = (bg.match(/[\d.]+/g) ?? []).map(Number)
    const alpha = nums.length >= 4 ? nums[3] : 1
    return { opened: true, panel: true, bg, alpha }
  })

  check('модалка подключения открывается', modal.opened && modal.panel !== false, JSON.stringify(modal))
  if (modal.panel) {
    check('панель модалки непрозрачна', modal.alpha >= 0.98, `фон ${modal.bg} (альфа ${modal.alpha})`)
  }
  await page.screenshot({ path: path.join(artifacts, 'integrations-light.png'), fullPage: false })

  /*
   * ОБЕ ТЕМЫ, А НЕ ТА, ЧТО ДОСТАЛАСЬ ПРОГОНУ.
   *
   * Тема здесь берётся от системы (html[data-theme='system']), а headless-браузер по умолчанию
   * светлый. Первый прогон этой проверки поэтому мерил белую тему — а выцветший фон модалки был
   * заявлен на тёмной, основной для продукта. Значение непрозрачности берётся токеном panel, и
   * ошибиться можно ровно в одной из тем: хардкод #1E293B прошёл бы тёмную и провалил светлую.
   */
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.reload({ waitUntil: 'networkidle0', timeout: 30_000 })
  await delay(400)
  const dark = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const pageBg = getComputedStyle(document.body).backgroundColor
    const btn = [...document.querySelectorAll('button')].find((b) => /Подключить|Ulash|Connect/i.test(b.innerText))
    if (!btn) return { pageBg, panel: false }
    btn.click()
    await wait(400)
    const overlay = [...document.querySelectorAll('div')].find((el) => el.className.includes?.('fixed inset-0'))
    const panel = overlay && [...overlay.querySelectorAll('div')].find((el) => el.className.includes?.('modal-panel'))
    if (!panel) return { pageBg, panel: false }
    const bg = getComputedStyle(panel).backgroundColor
    const nums = (bg.match(/[\d.]+/g) ?? []).map(Number)
    return { pageBg, panel: true, bg, alpha: nums.length >= 4 ? nums[3] : 1 }
  })
  // Тёмная тема действительно применилась: фон страницы — тёмно-синий, а не светлый.
  const darkApplied = (dark.pageBg.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).every((v) => v < 80)
  check('тёмная тема применилась', darkApplied, `фон страницы ${dark.pageBg}`)
  check('панель модалки непрозрачна и в тёмной теме', dark.panel && dark.alpha >= 0.98, `фон ${dark.bg} (альфа ${dark.alpha})`)
  await page.screenshot({ path: path.join(artifacts, 'integrations-dark.png'), fullPage: false })
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
console.log('Все проверки страницы интеграций пройдены.')
