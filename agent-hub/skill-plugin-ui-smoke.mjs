import fs from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))), '..')
const baseUrl = process.env.NEMO_LOCAL_URL || 'http://127.0.0.1:5173'
const artifacts = path.join(root, 'agent-hub', 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })

const browser = await puppeteer.launch({ headless: true })
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('nemo.lang', 'ru')
    localStorage.setItem('nemo.user', JSON.stringify({ id: 'ui-smoke', email: 'ui@nemo.local', name: 'UI Smoke', lang: 'ru', role: 'user' }))
  })

  await page.goto(`${baseUrl}/app/agents/ag_autonomous_operator`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount)
  const editorText = await page.evaluate(() => document.body.innerText)
  if (!editorText.includes('Свой skill из файла')) throw new Error(`Skill importer not rendered at ${page.url()}: ${editorText.slice(0, 500)}`)
  const skillInput = await page.$('input[type="file"]:not([accept])')
  if (!skillInput) throw new Error('Custom skill file input not found')
  await skillInput.uploadFile(path.join(root, 'agent-hub', 'fixtures', 'investor-demo-skill.md'))
  await page.waitForFunction(() => document.body.innerText.includes('investor-demo-skill.md'))
  const unsaved = await page.evaluate(() => document.body.innerText.includes('Несохранённые изменения'))
  if (!unsaved) throw new Error('Imported skill did not make the agent draft dirty')
  await page.screenshot({ path: path.join(artifacts, 'custom-skill-desktop.png'), fullPage: true })

  await page.goto(`${baseUrl}/app/tools`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#root')?.childElementCount)
  const integrationsText = await page.evaluate(() => document.body.innerText)
  if (!integrationsText.includes('Манифест плагина')) throw new Error(`Plugin importer not rendered at ${page.url()}: ${integrationsText.slice(0, 500)}`)
  const manifestInput = await page.$('input[type="file"][accept*=".json"]')
  if (!manifestInput) throw new Error('Plugin manifest input not found')
  await manifestInput.uploadFile(path.join(root, 'agent-hub', 'fixtures', 'demo-mcp-plugin.json'))
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((input) => input.value === 'demo_crm_tools'))
  const saveDisabled = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Сохранить'))
    return button instanceof HTMLButtonElement && button.disabled
  })
  if (!saveDisabled) throw new Error('MCP plugin can be saved before a successful probe')
  await page.screenshot({ path: path.join(artifacts, 'plugin-manifest-desktop.png'), fullPage: true })

  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.goto(`${baseUrl}/app/tools`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.innerText.includes('Манифест плагина'))
  await page.screenshot({ path: path.join(artifacts, 'plugin-manifest-mobile.png'), fullPage: true })
  const overflow = await page.evaluate(() => ({
    page: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
    elements: [...document.querySelectorAll('body *')]
      .map((element) => ({ tag: element.tagName, cls: element.className, text: element.textContent?.trim().slice(0, 60), right: element.getBoundingClientRect().right }))
      .filter((item) => item.right > document.documentElement.clientWidth + 1)
      .slice(0, 8),
  }))
  if (overflow.page[1] > overflow.page[0] + 1) throw new Error(`Plugin page has page-level mobile overflow: ${JSON.stringify(overflow)}`)

  if (errors.length) throw new Error(`Browser errors: ${[...new Set(errors)].join('; ')}`)
  console.log('[OK] custom skill upload changes the real agent prompt draft')
  console.log('[OK] MCP manifest stays disabled until a real server probe')
  console.log('[OK] skill/plugin UI renders on desktop and mobile without page overflow')
} finally {
  await browser.close()
}
