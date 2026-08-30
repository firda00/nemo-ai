import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const studio = read('src/components/platform/MarketingCampaignStudio.tsx')
const page = read('src/pages/app/ContentStudioPage.tsx')

assert.match(page, /const tab: Leaf = .*: 'campaign'/, '/app/content must open the campaign studio by default')
assert.match(page, /<MarketingCampaignStudio \/>/, 'campaign studio must be mounted in the content page')
assert.match(studio, /MarketingOutputSchema\.safeParse\(body\?\.campaign\)/, 'campaign response must be validated by the canonical Zod schema')
assert.match(studio, /fetch\('\/api\/marketing\/generate-campaign'/, 'UI must call the authenticated marketing endpoint')
assert.match(studio, /Authorization: `Bearer \$\{token\}`/, 'campaign generation must send the user session')
assert.match(studio, /from\('brand_kits'\)/, 'Brand Kits must come from the tenant-scoped table')
assert.match(studio, /BrandKitSchema\.safeParse/, 'Brand Kit rows must be validated before rendering')
assert.match(studio, /BrandKitSchema\.omit\(\{ id: true \}\)\.safeParse/, 'new Brand Kits must be validated before insert')
assert.match(studio, /functions\.invoke\('generate-image'/, 'Visual Studio must use the real image generator')
assert.match(studio, /preview: 'Демо-превью · не сгенерировано'/, 'local preview must be explicitly labelled as not generated')
assert.match(studio, /provocation[\s\S]*mistake[\s\S]*case_study/, 'hook selector must cover all three schema hook types')
for (const field of ['timestamp_or_slide', 'visual_description', 'script_text', 'on_screen_text']) {
  assert.match(studio, new RegExp(`scene\\.${field}`), `storyboard must render ${field}`)
}
for (const format of ['short_video', 'carousel', 'post']) {
  assert.match(studio, new RegExp(`${format}:`), `format selector must include ${format}`)
}
assert.match(studio, /setActiveHook/, 'hooks must have an interactive active state')
assert.match(studio, /navigator\.clipboard\.writeText/, 'hooks and CTA must support quick copy')
assert.match(studio, /setVisualPreset/, 'Visual Studio must allow preset changes')

console.log('[OK] Marketing campaign UI: Brand Kit, strict output, hooks, storyboard and real visual generation')
