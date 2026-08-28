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
    // $143 \u2014 \u0446\u0435\u043d\u0430 \u041d\u041e\u0412\u041e\u0419 \u043b\u0435\u0441\u0442\u043d\u0438\u0446\u044b: \u043e\u0436\u0438\u0434\u0430\u043d\u0438\u0435 \u043d\u0430 \u043d\u0435\u0439 \u0440\u043e\u043d\u044f\u0435\u0442 \u0441\u043c\u043e\u0443\u043a \u043d\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u0432\u0448\u0435\u043c \u0434\u0435\u043f\u043b\u043e\u0435 \u0441\u0440\u0430\u0437\u0443,
    // \u0430 \u043d\u0435 \u043f\u043e\u0441\u043b\u0435 \u0442\u043e\u0433\u043e, \u043a\u0430\u043a \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u043d\u0438\u0436\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u044f\u0442 \u0441\u0442\u0430\u0440\u044b\u0435 \u0446\u0435\u043d\u044b \u043a\u0430\u043a \u00ab\u0436\u0438\u0432\u044b\u0435\u00bb.
    await page.waitForFunction(() => document.body.innerText.includes('$350') && document.body.innerText.includes('$143'))
    // \u0412\u0438\u0442\u0440\u0438\u043d\u0430 \u0432\u0435\u0434\u0451\u0442 \u0421\u0423\u041c\u041c\u041e\u0419 (\u0435\u0451 \u0441\u043f\u0438\u0441\u044b\u0432\u0430\u0435\u0442 Payme/Click), \u0434\u043e\u043b\u043b\u0430\u0440 \u0438\u0434\u0451\u0442 \u043c\u0435\u043b\u043a\u043e\u0439 \u043f\u043e\u0434\u043f\u0438\u0441\u044c\u044e \u2014 \u043f\u0440\u043e\u0432\u0435\u0440\u044f\u0435\u043c
    // \u043e\u0431\u0435 \u0441\u0442\u0440\u043e\u043a\u0438. formatUzs \u0441\u043a\u043b\u0435\u0438\u0432\u0430\u0435\u0442 \u0440\u0430\u0437\u0440\u044f\u0434\u044b \u041d\u0415\u0420\u0410\u0417\u0420\u042b\u0412\u041d\u042b\u041c \u043f\u0440\u043e\u0431\u0435\u043b\u043e\u043c (U+00A0), \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u0442\u0435\u043a\u0441\u0442
    // \u043d\u043e\u0440\u043c\u0430\u043b\u0438\u0437\u0443\u0435\u0442\u0441\u044f \u0437\u0434\u0435\u0441\u044c: \u0434\u0435\u0440\u0436\u0430\u0442\u044c U+00A0 \u0432 \u0438\u0441\u0445\u043e\u0434\u043d\u0438\u043a\u0435 \u0442\u0435\u0441\u0442\u0430 \u2014 \u043f\u0440\u0438\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0435 \u043a \u043b\u043e\u0436\u043d\u043e\u043c\u0443 \u043f\u0430\u0434\u0435\u043d\u0438\u044e.
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\u00a0/g, ' ')
    for (const price of ['$59', '$143', '$254', '$350']) if (!text.includes(price)) throw new Error(`${name}: missing ${price}`)
    for (const uzs of ['690 000', '1 690 000', '2 990 000', '4 120 000']) if (!text.includes(uzs)) throw new Error(`${name}: missing ${uzs} UZS`)
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
