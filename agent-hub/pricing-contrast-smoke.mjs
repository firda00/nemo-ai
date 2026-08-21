// Читаемость страницы тарифов: контраст текста к фону, измеренный по WCAG, в ОБЕИХ темах.
//
// ЗАЧЕМ ИЗМЕРЯТЬ, А НЕ СМОТРЕТЬ. «Тускло» и «нечитаемо» на глаз различают по-разному, а
// зависит это ещё и от монитора. Контраст — число: 4.5 для обычного текста и 3.0 для крупного
// (18pt и выше, либо 14pt жирным) — порог WCAG AA, ниже которого текст перестают различать люди
// со слабым зрением и все остальные при ярком свете.
//
// ОБЕ ТЕМЫ ОБЯЗАТЕЛЬНЫ. Здесь уже был отказ ровно этого вида: страница задавала тёмный фон
// константой, но не ставила theme-dark-scope, поэтому цвета текста следовали теме ПОСЕТИТЕЛЯ.
// У человека со светлой темой получался тёмный текст на почти чёрном фоне. У разработчика с
// тёмной темой всё выглядело исправно.
//
// Запуск: npm run test:pricing-contrast
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const root = path.resolve(import.meta.dirname, '..')
const baseUrl = 'http://127.0.0.1:4181'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'pricing')
fs.mkdirSync(artifacts, { recursive: true })

const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4181 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4181', '--strictPort']
const server = spawn(command, args, {
  cwd: root,
  env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let log = ''
server.stdout.on('data', (c) => { log += c }); server.stderr.on('data', (c) => { log += c })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const stop = () => {
  if (server.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' })
  else server.kill('SIGTERM')
}

let failed = 0
const ok = (name, detail = '') => console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`)
const bad = (name, detail = '') => { failed += 1; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`) }

/**
 * Снимает контраст каждого заметного элемента страницы.
 *
 * Фон ищется ВВЕРХ ПО ДЕРЕВУ до первого непрозрачного: у самого текста фон почти всегда
 * прозрачный, и сравнивать цвет с прозрачностью бессмысленно — так и получается «контраст 21»
 * на нечитаемой странице.
 */
const MEASURE = `(() => {
  const luminance = (color) => {
    const parts = String(color).match(/[0-9.]+/g)
    if (!parts || parts.length < 3) return null
    const [r, g, b] = parts.slice(0, 3).map(Number).map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const backgroundOf = (node) => {
    let el = node
    while (el) {
      const bg = getComputedStyle(el).backgroundColor
      const parts = String(bg).match(/[0-9.]+/g)
      const alpha = parts && parts.length > 3 ? Number(parts[3]) : 1
      if (parts && alpha > 0.9) return bg
      el = el.parentElement
    }
    return getComputedStyle(document.body).backgroundColor
  }
  const contrast = (node) => {
    const front = luminance(getComputedStyle(node).color)
    const back = luminance(backgroundOf(node))
    if (front === null || back === null) return null
    return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)
  }
  const seen = []
  const cards = [...document.querySelectorAll('main h1, main h2, main p, main a, main button, main th, main td, main span')]
  for (const el of cards) {
    const text = (el.textContent || '').trim()
    if (!text || el.children.length > 2) continue
    const box = el.getBoundingClientRect()
    if (box.width < 4 || box.height < 4) continue
    const value = contrast(el)
    if (value === null) continue
    const style = getComputedStyle(el)
    const size = parseFloat(style.fontSize)
    const weight = Number(style.fontWeight) || 400
    // Порог WCAG AA: крупный текст (24px, либо 18.66px жирным) допускает 3.0.
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    seen.push({ text: text.slice(0, 28), ratio: Number(value.toFixed(2)), need: large ? 3 : 4.5, size, weight })
  }
  return seen
})()`

try {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(baseUrl)).ok) break } catch {}
    await delay(250)
  }
  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1100 })

  for (const scheme of ['dark', 'light']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
    await page.goto(`${baseUrl}/pricing`, { waitUntil: 'networkidle0', timeout: 30_000 })
    await delay(700)

    const rows = await page.evaluate(MEASURE)
    const dim = rows.filter((row) => row.ratio < row.need)
    dim.length === 0
      ? ok(`тема ${scheme}: весь текст читается`, `проверено элементов: ${rows.length}`)
      : bad(`тема ${scheme}: текст ниже порога`, dim.slice(0, 5).map((d) => `«${d.text}» ${d.ratio} < ${d.need}`).join('; '))

    await page.screenshot({ path: path.join(artifacts, `pricing-${scheme}.png`) })
  }

  /*
   * Заголовок страницы обязан быть на месте.
   *
   * Сетка карточек без заголовка — это прайс-лист без объяснения, за что платят: человек видит
   * пять цен и не понимает, чем они отличаются от бесплатного плана.
   */
  const head = await page.evaluate(() => {
    const h1 = document.querySelector('main h1')
    const badge = [...document.querySelectorAll('main span, main p')].find((e) => /тариф|narx|pricing/i.test(e.textContent || ''))
    return { title: h1?.textContent?.trim() ?? '', hasBadge: Boolean(badge) }
  })
  head.title.length > 8 ? ok('заголовок страницы на месте', head.title.slice(0, 48)) : bad('нет заголовка страницы', head.title)

  await browser.close()
} catch (error) {
  failed += 1
  console.error('прогон не состоялся:', error.message, log.slice(-300))
} finally { stop() }

console.log()
if (failed) { console.error(`Тарифы: ${failed} проверок упало.`); process.exit(1) }
console.log('Тарифы: текст читается в обеих темах.')
