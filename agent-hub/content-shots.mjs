// Снимки продукта для контента: реальный интерфейс, а не выдуманный.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ ПАНЕЛЬ БРАУЗЕРА. Панель отдаёт кадр только когда она открыта на
// экране у человека; в фоне страница не отрисовывается вовсе. Здесь нужен ФАЙЛ — его потом кладут
// в пост, отдают Higgsfield как start_image и хранят в репозитории. Поэтому Playwright напрямую.
//
// РАЗМЕРЫ ВЗЯТЫ ПОД INSTAGRAM, а не «на глаз»:
//   1080×1350 — лента, вертикальный пост (4:5). Занимает максимум высоты в ленте.
//   1080×1080 — лента, квадрат (1:1). Для сеток и каруселей.
//   1080×1920 — Reels и Stories (9:16).
// Съёмка идёт с deviceScaleFactor=2 и половинным окном: так текст остаётся резким на телефоне.
//
// ТЁМНАЯ ТЕМА ПРИНУДИТЕЛЬНО. Лендинг подстраивается под тему системы, и на светлой машине снимок
// вышел бы серым — не тем продуктом, который показывают в тёмной премиальной теме.
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'

const BASE = process.argv[2] ?? 'https://nemo-ai-firda00s-projects.vercel.app'
const OUT = path.resolve('content/shots')

/** Что снимаем. selector — если нужен конкретный блок, а не вся видимая область. */
const SHOTS = [
  { name: '01-hero-4x5', route: '/', w: 540, h: 675, scroll: 0 },
  { name: '02-hero-9x16', route: '/', w: 540, h: 960, scroll: 0 },
  { name: '03-hero-1x1', route: '/', w: 540, h: 540, scroll: 0 },
  { name: '04-how-4x5', route: '/', w: 540, h: 675, scroll: 1 },
  { name: '05-how-1x1', route: '/', w: 540, h: 540, scroll: 1 },
  { name: '06-capabilities-4x5', route: '/', w: 540, h: 675, scroll: 2 },
  { name: '07-templates-1x1', route: '/', w: 540, h: 540, scroll: 3 },
  { name: '08-pricing-4x5', route: '/pricing', w: 540, h: 675, scroll: 0 },
  { name: '09-desktop-16x9', route: '/', w: 1280, h: 720, scroll: 0 },
]

const browser = await chromium.launch()
await fs.mkdir(OUT, { recursive: true })
const made = []

for (const shot of SHOTS) {
  const context = await browser.newContext({
    viewport: { width: shot.w, height: shot.h },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'uz-UZ',
  })
  const page = await context.newPage()
  try {
    await page.goto(`${BASE}${shot.route}`, { waitUntil: 'networkidle', timeout: 45_000 })
    // Анимации входа успевают доиграть: снимок на середине перехода даёт полупрозрачные блоки.
    await page.waitForTimeout(1200)

    if (shot.scroll) {
      // Прокрутка ЭКРАНАМИ, а не пикселями: высота окна у каждого формата своя, и «на 900px»
      // попало бы в разные места вёрстки.
      await page.evaluate((screens) => window.scrollTo({ top: window.innerHeight * screens, behavior: 'instant' }), shot.scroll)
      await page.waitForTimeout(900)
    }

    const file = path.join(OUT, `${shot.name}.png`)
    await page.screenshot({ path: file })
    const { size } = await fs.stat(file)
    made.push(`${shot.name}.png  ${shot.w * 2}×${shot.h * 2}  ${Math.round(size / 1024)} КБ`)
  } catch (error) {
    made.push(`${shot.name}  — НЕ СНЯТ: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
  }
  await context.close()
}

await browser.close()
console.log(made.join('\n'))
console.log(`\nПапка: ${OUT}`)
