// Навигация лендинга: прилипшая шапка и переходы по якорям (постоянная, в гейте качества).
//
// Запуск: npm run test:landing-nav
/*
 * Проверка якорной навигации лендинга: заголовок секции обязан остаться ВИДИМЫМ под прилипшей
 * шапкой, а не уехать под неё.
 *
 * Измеряется не наличие класса, а ГЕОМЕТРИЯ после перехода: верх заголовка должен быть НИЖЕ нижней
 * границы шапки. Проверка на класс прошла бы и при неверной величине отступа.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer'

const root = path.resolve(import.meta.dirname, '..')
const baseUrl = 'http://127.0.0.1:4177'
const artifacts = path.join(root, 'agent-hub', 'artifacts', 'landing-nav')
fs.mkdirSync(artifacts, { recursive: true })
const command = process.platform === 'win32' ? process.env.ComSpec : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 4177 --strictPort']
  : ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4177', '--strictPort']
const server = spawn(command, args, { cwd: root, env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
server.stdout.on('data', (c) => { log += c }); server.stderr.on('data', (c) => { log += c })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const stop = () => { if (server.exitCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' }); else server.kill('SIGTERM') } }

let failed = 0
const check = (name, cond, detail = '') => { if (cond) console.log(`[OK]   ${name}${detail ? ` — ${detail}` : ''}`); else { failed++; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`) } }

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(baseUrl)).ok) break } catch {} await delay(250) }
  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
  await page.goto(baseUrl + '/', { waitUntil: 'networkidle0', timeout: 30_000 })
  await delay(500)

  const header = await page.evaluate(() => {
    const el = document.querySelector('header')
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return { position: cs.position, top: cs.top, zIndex: cs.zIndex, borderBottom: cs.borderBottomWidth, bg: cs.backgroundColor, blur: cs.backdropFilter, height: r.height, width: r.width, viewport: innerWidth }
  })
  check('шапка найдена', Boolean(header))
  if (header) {
    check('прилипшая к верху', header.position === 'sticky' && header.top === '0px', `${header.position}, top=${header.top}`)
    check('во всю ширину', Math.abs(header.width - header.viewport) < 2, `${Math.round(header.width)} из ${header.viewport}px`)
    check('нижняя граница есть', parseFloat(header.borderBottom) > 0, header.borderBottom)
    check('фон не прозрачный', !/rgba\(0, 0, 0, 0\)/.test(header.bg), header.bg)
    check('размытие подложки', /blur/.test(header.blur), header.blur)
    check('поверх содержимого', Number(header.zIndex) >= 40, `z-index=${header.zIndex}`)
  }

  /*
   * ГЛАВНАЯ ПРОВЕРКА: ШАПКА ОСТАЁТСЯ НА МЕСТЕ ПОСЛЕ ПРОКРУТКИ.
   *
   * `position: sticky` в вычисленных стилях ничего не доказывает. Он липнет к БЛИЖАЙШЕМУ
   * контейнеру прокрутки, и если у предка стоит overflow-x: hidden, таким контейнером становится
   * предок — который сам не прокручивается. В стилях всё выглядит верно, а шапка уезжает.
   *
   * Ровно это здесь и было: при scrollY = 1359 верх шапки оказывался на −1359px. Первая редакция
   * проверки этого не заметила, потому что сравнивала заголовок с уехавшей шапкой и проходила
   * ВХОЛОСТУЮ: 240 >= −2606 верно всегда.
   */
  const afterScroll = await page.evaluate(async () => {
    window.scrollTo(0, 1500)
    await new Promise((r) => setTimeout(r, 400))
    const r = document.querySelector('header').getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, scrollY: window.scrollY }
  })
  check('остаётся на месте после прокрутки', Math.abs(afterScroll.top) < 2,
    `при scrollY=${Math.round(afterScroll.scrollY)} верх шапки на ${Math.round(afterScroll.top)}px (ожидается 0)`)
  await page.evaluate(() => window.scrollTo(0, 0))
  await delay(300)

  // Переход по каждому якорю из шапки.
  const anchors = await page.evaluate(() => [...document.querySelectorAll('header a[href*="#"]')].map((a) => a.getAttribute('href')))
  check('якорные ссылки в шапке', anchors.length >= 3, anchors.join(', '))

  for (const href of anchors) {
    const id = href.split('#')[1]
    const result = await page.evaluate(async (anchorId) => {
      const target = document.getElementById(anchorId)
      if (!target) return { missing: true }
      window.scrollTo(0, 0)
      await new Promise((r) => setTimeout(r, 100))
      location.hash = ''
      location.hash = anchorId
      /*
       * Ждём ОСТАНОВКИ прокрутки, а не фиксированный срок.
       *
       * Плавная прокрутка длится тем дольше, чем дальше секция. С паузой в 900 мс ближние якоря
       * успевали, дальние — нет, и проверка объявляла исправную ссылку сломанной. Хуже того, зависел
       * бы результат от скорости машины: на своей зелено, в CI красно.
       */
      let last = -1
      for (let i = 0; i < 60 && last !== window.scrollY; i += 1) {
        last = window.scrollY
        await new Promise((r) => setTimeout(r, 100))
      }
      const head = document.querySelector('header').getBoundingClientRect()
      const heading = target.querySelector('h1,h2,h3') ?? target
      const box = heading.getBoundingClientRect()
      return {
        headerBottom: head.bottom, headerHeight: head.height,
        headingTop: box.top,
        // Верх САМОЙ секции — то, на что влияет scroll-margin-top. Заголовок для этого не годится:
        // у секций внутренний отступ py-20, и заголовок оказывается ниже шапки даже без отступа под
        // якорь. Проверка по заголовку прошла бы и со снятым scroll-margin-top — проверено мутацией.
        sectionTop: target.getBoundingClientRect().top,
        text: (heading.textContent ?? '').trim().slice(0, 30),
      }
    }, id)
    if (result.missing) { check(`якорь #${id}`, false, 'секции с таким id на странице нет'); continue }
    /*
     * Заголовок обязан быть НИЖЕ шапки И В ПРЕДЕЛАХ ЭКРАНА. Второе условие обязательно: без него
     * проверка проходит вхолостую, когда шапка уехала за верх (её низ отрицателен) или когда
     * переход вообще не сработал и заголовок остался далеко внизу.
     */
    const belowHeader = result.sectionTop >= result.headerBottom
    const onScreen = result.headingTop >= 0 && result.headingTop < 800
    const headerSticks = Math.abs(result.headerBottom - result.headerHeight) < 2
    check(`якорь #${id}`, belowHeader && onScreen && headerSticks,
      `секция «${result.text}» начинается на ${Math.round(result.sectionTop)}px, низ шапки ${Math.round(result.headerBottom)}px`)
  }

  await page.screenshot({ path: path.join(artifacts, 'landing-nav.png') })
  await browser.close()
} catch (e) {
  failed++; console.error('прогон не состоялся:', e.message, log.slice(-400))
} finally { stop() }

process.exit(failed ? 1 : 0)
