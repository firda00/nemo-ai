// PPTX continuation calibration — ACTUAL RENDERING, not character counts. The assembler's
// wrap model (CHARS_PER_LINE × LINES_PER_SLIDE) is a conservative estimate; this smoke lays
// out every emitted slide's text in a real browser engine at the EXACT slide geometry the
// OOXML encodes (box width/height in EMU, 18pt font, the 120% a:lnSpc line spacing) and fails
// if any slide's measured height exceeds its box. RU and UZ fixtures, long unbroken words and
// the worst schema-legal bullets included; stepped-down long titles are measured too.
// Honest scope: this calibrates TEXT FIT in a browser layout engine; full office-renderer
// visual certification (fonts/kerning in PowerPoint itself) stays an open gap — no soffice
// is bundled here.
// Run: npm run test:document-overflow
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import puppeteer from 'puppeteer'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..')
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemo-doc-overflow-'))
const bundlePath = path.join(buildDir, 'pptx.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'agent-hub', 'documents', 'pptx-assembler.ts')],
  bundle: true,
  outfile: bundlePath,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
})
const {
  planSlides, titleFontSize, PptxPresentationInputSchema,
  BODY_W, BODY_H, TITLE_H, BODY_FONT_PT, BODY_LINE_HEIGHT, INSET_LR, INSET_TB,
} = await import(pathToFileURL(bundlePath).href)

// the measured geometry is the CONTENT box: the encoded insets are subtracted, so the browser
// lays out exactly what the OOXML declares — no reliance on Office defaults
const EMU_PER_PX = 9525
const bodyWidthPx = (BODY_W - 2 * INSET_LR) / EMU_PER_PX
const bodyHeightPx = (BODY_H - 2 * INSET_TB) / EMU_PER_PX
const titleHeightPx = (TITLE_H - 2 * INSET_TB) / EMU_PER_PX
const bodyFontPx = (BODY_FONT_PT * 4) / 3

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`[OK] ${name}`)
  else { failed += 1; console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`) }
}

const FIXTURES = [
  {
    name: 'RU long-word prose',
    slides: [{
      title: 'Многофункциональность',
      bullets: Array.from({ length: 12 }, (_v, i) =>
        `Пункт ${i}: многофункциональность и конкурентоспособность — ${'взаимоответственность '.repeat(9)}`.slice(0, 400)),
    }],
  },
  {
    name: 'UZ prose',
    slides: [{
      title: "Yakuniy hisobot va rejalashtirish bo‘yicha taqdimot",
      bullets: Array.from({ length: 12 }, (_v, i) =>
        `Band ${i}: qo‘shimcha ma’lumotlar, mas’uliyat taqsimoti va istiqbolli yo‘nalishlar — ${'takomillashtirish '.repeat(10)}`.slice(0, 400)),
    }],
  },
  {
    name: 'unbroken 400-char words ×12',
    slides: [{ title: 'Стресс', bullets: Array.from({ length: 12 }, () => 'ў'.repeat(400)) }],
  },
  {
    name: 'schema-legal 2000-char prose bullet (forces the continuation split)',
    slides: [{ title: 'Проза', bullets: ['и снова взаимоответственность команды растёт — '.repeat(43).slice(0, 2000)] }],
  },
]

let browser
try {
  browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()

  for (const fixture of FIXTURES) {
    const input = PptxPresentationInputSchema.parse({ kind: 'pptx_presentation', title: 'Т', slides: fixture.slides })
    const emitted = planSlides(input)
    check(`${fixture.name}: continuation emitted ${emitted.length} slide(s), nothing dropped`,
      emitted.flatMap((s) => s.bullets).join('') === fixture.slides.flatMap((s) => s.bullets).join(''))
    const heights = await page.evaluate(({ slides, widthPx, fontPx, lineHeight }) => {
      document.body.innerHTML = ''
      return slides.map((slide) => {
        const box = document.createElement('div')
        box.style.cssText = `width:${widthPx}px;font:${fontPx}px Calibri, Arial, sans-serif;line-height:${lineHeight};overflow-wrap:break-word;position:absolute;visibility:hidden;`
        for (const bullet of slide.bullets) {
          const p = document.createElement('div')
          p.textContent = `• ${bullet}`
          box.appendChild(p)
        }
        document.body.appendChild(box)
        return box.scrollHeight
      })
    }, { slides: emitted, widthPx: bodyWidthPx, fontPx: bodyFontPx, lineHeight: BODY_LINE_HEIGHT })
    const worst = Math.max(...heights)
    check(`${fixture.name}: every emitted slide FITS the ${Math.floor(bodyHeightPx)}px body box (worst ${Math.ceil(worst)}px)`,
      worst <= bodyHeightPx)
  }

  // stepped-down titles must fit the title box at their EXPLICIT encoded size — each step
  // boundary, the boundary+1 worst case, and WIDE glyphs (Ш/W) that narrow-glyph counts hide
  const titles = [
    ...[26, 27, 72, 73, 160, 161, 200].map((length) => 'ы'.repeat(length)),
    ...[26, 27, 72, 73, 160, 161, 200].map((length) => 'Ш'.repeat(length)),
    ...[26, 27, 72, 73, 160, 161, 200].map((length) => 'W'.repeat(length)),
  ]
  const titleHeights = await page.evaluate(({ items, widthPx, lineHeight }) => {
    document.body.innerHTML = ''
    return items.map(({ text, fontPx }) => {
      const box = document.createElement('div')
      box.style.cssText = `width:${widthPx}px;font:bold ${fontPx}px Calibri, Arial, sans-serif;line-height:${lineHeight};overflow-wrap:break-word;position:absolute;visibility:hidden;`
      box.textContent = text
      document.body.appendChild(box)
      return box.scrollHeight
    })
  }, {
    items: titles.map((text) => ({ text, fontPx: (titleFontSize(text) / 100) * 4 / 3 })),
    widthPx: bodyWidthPx,
    lineHeight: BODY_LINE_HEIGHT,
  })
  check(`long titles fit the ${Math.floor(titleHeightPx)}px title box at their stepped sizes (worst ${Math.ceil(Math.max(...titleHeights))}px)`,
    Math.max(...titleHeights) <= titleHeightPx)
} catch (error) {
  failed += 1
  console.error(`[FAIL] document-overflow-smoke crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  try { if (browser) await browser.close() } catch { /* best effort */ }
}

if (failed > 0) { console.error(`document-overflow-smoke: ${failed} check(s) failed.`); process.exit(1) }
console.log('PPTX continuation calibrated against ACTUAL browser text layout at the encoded slide geometry.')
