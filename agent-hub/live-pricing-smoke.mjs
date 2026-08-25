import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'

const url = (process.env.NEMO_LIVE_URL || 'https://nemo-ai-swart.vercel.app').replace(/\/$/, '') + '/pricing'
const out = path.resolve('agent-hub/artifacts')
fs.mkdirSync(out, { recursive: true })

const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => localStorage.setItem('nemo.lang', 'ru'))
  for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
    await page.setViewport({ width, height, isMobile: name === 'mobile' })
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (!response || response.status() !== 200) throw new Error(`${name}: HTTP ${response?.status()}`)
    await page.waitForFunction(() => document.body.innerText.includes('$350') && document.body.innerText.includes('$119'))
    const text = await page.evaluate(() => document.body.innerText)
    for (const price of ['$25', '$59', '$119', '$350']) if (!text.includes(price)) throw new Error(`${name}: missing ${price}`)
    if (!text.includes('\u041f\u043e \u0434\u043e\u0433\u043e\u0432\u043e\u0440\u0443')) throw new Error(`${name}: missing Enterprise contract wording`)
    if (/безлимит/iu.test(text)) throw new Error(`${name}: forbidden unlimited wording`)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    if (overflow) throw new Error(`${name}: page-level horizontal overflow`)
    await page.screenshot({ path: path.join(out, `pricing-live-${name}.png`), fullPage: true })
    console.log(`[OK] live pricing ${name}: prices, wording and page overflow`)
  }
} finally {
  await browser.close()
}
