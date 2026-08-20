import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const baseUrl = 'http://127.0.0.1:4174'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'site-smoke')
fs.mkdirSync(artifacts, { recursive: true })

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4174', '--strictPort']
const server = spawn(command, args, {
  cwd: root,
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
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

/**
 * Уборка не выносит вердикт.
 *
 * puppeteer держит профиль во временной папке и удаляет её при закрытии. На Windows Chrome ещё
 * держит lockfile в этот момент: удаление падает с EBUSY, отказ всплывает как необработанный, и
 * процесс умирает с кодом 1 — ПОСЛЕ того, как все проверки прошли. Гейт печатал «[FAIL] Website
 * smoke test», и отличить сломанный сайт от неудачного rmdir было нельзя.
 *
 * Гасится ровно этот случай и только он: ошибка файловой системы во временном профиле. Любая
 * другая необработанная ошибка по-прежнему валит прогон, как и должна.
 */
const PROFILE_CLEANUP = /puppeteer_dev_chrome_profile|EBUSY|ENOTEMPTY|EPERM/
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? `${reason.message} ${reason.stack ?? ''}` : String(reason)
  if (PROFILE_CLEANUP.test(text)) {
    console.warn(`[warn] профиль браузера не удалился, на результат не влияет: ${text.split('\n')[0]}`)
    return
  }
  console.error(reason)
  process.exit(1)
})

let browser
let page
try {
  await waitForServer()
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  const runtimeErrors = []
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/i.test(message.text())) runtimeErrors.push(`console: ${message.text()}`)
  })

  // Юридические страницы в списке НАМЕРЕННО: на них ссылается футер и чекбокс согласия при
  // регистрации. Мёртвая ссылка в согласии — это согласие с документом, который человек не смог
  // открыть, и обнаруживается это в худший момент: при разборе жалобы.
  const publicRoutes = ['/', '/pricing', '/demo', '/pitch', '/auth', '/terms', '/privacy']
  // /app/memory входит сюда после того, как страница была задеплоена без пункта в меню: маршрут
  // существовал, дойти до него было нельзя, и ни одна проверка этого не заметила.
  const appRoutes = ['/app', '/app/agents', '/app/swarms', '/app/dialogues', '/app/lead-forms', '/app/analytics', '/app/autopost', '/app/followups', '/app/quality', '/app/runtime', '/app/integrations', '/app/templates', '/app/memory']

  async function checkRoute(route) {
    // Vite keeps a development/HMR connection open, so networkidle0 can hang
    // even after the route is fully rendered. Assert the actual app surface.
    // Адрес и код ответа печатаются всегда, а не только при отказе.
    //
    // Гейт однажды упал строкой «[FAIL] Website smoke test» и больше ничем — понять, какой
    // маршрут и почему, было нельзя, и падение осталось неотличимым от сетевого сбоя во время
    // деплоя. Тест, не объясняющий себя, заставляет гадать; гадание про упавшую проверку стоит
    // дороже одной строки вывода.
    const url = baseUrl + route
    let response
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (error) {
      // Сетевая ошибка не несёт адреса сама по себе: «net::ERR_CONNECTION_REFUSED» без URL
      // одинаково выглядит на любом из четырнадцати маршрутов.
      throw new Error(`${url} — запрос не состоялся: ${error?.message ?? error}`)
    }
    if (!response) throw new Error(`${url} — ответа нет`)
    const status = response.status()
    if (status >= 400) throw new Error(`${url} — HTTP ${status}`)
    await page.waitForFunction(() => {
      const root = document.querySelector('#root')
      return Boolean(root?.childElementCount && document.body.innerText.trim().length >= 30)
    }, { timeout: 30_000 })
    const result = await page.evaluate(() => ({
      text: document.body.innerText.trim(),
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
      viteError: Boolean(document.querySelector('vite-error-overlay')),
      path: window.location.pathname,
    }))
    if (result.viteError || result.rootChildren === 0 || result.text.length < 30) throw new Error(`${url} — HTTP ${status}, но страница пустая или сломана`)
    if (result.path !== route) throw new Error(`${url} — HTTP ${status}, но перебросило на ${result.path}`)
    console.log(`[OK] ${status} ${url}`)
  }

  for (const route of publicRoutes) await checkRoute(route)
  await page.evaluate(() => localStorage.setItem('nemo.user', JSON.stringify({
    id: 'smoke-user', email: 'smoke@nemo.local', name: 'Smoke User', lang: 'uz', role: 'user', onboardingCompleted: true, createdAt: '2026-07-10', quotaUsed: 0, quotaLimit: 100,
  })))
  for (const route of appRoutes) await checkRoute(route)

  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await checkRoute('/app')

  if (runtimeErrors.length) throw new Error(`Browser runtime errors:\n${[...new Set(runtimeErrors)].join('\n')}`)
  console.log('Nemo website smoke test passed on public, authenticated-demo, and mobile routes.')
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
  fs.writeFileSync(path.join(artifacts, 'server.log'), serverLog)
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  stopServer()
}
