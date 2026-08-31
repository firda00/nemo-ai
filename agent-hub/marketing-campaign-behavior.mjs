import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BrandKitSchema,
  GenerateCampaignInputSchema,
  MarketingOutputSchema,
  VISUAL_PRESETS,
  buildMarketingPrompt,
} from '../supabase/functions/_shared/marketingCampaign.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

const brand = BrandKitSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Nemo',
  colors: ['#22D3EE', '#8B7CF8'],
  fonts: { heading: 'Inter', body: 'Inter' },
  tone_of_voice: 'Clear B2B expert voice',
  stop_words: ['guaranteed'],
  visual_preset: '3d_modern_clay_isometric',
  custom_visual_rules: 'Use the cyan accent sparingly.',
})

const input = GenerateCampaignInputSchema.parse({
  topic: 'How AI teams reduce response time',
  platform: 'instagram_carousel',
  goal: 'lead_gen',
  brand_kit_id: brand.id,
  image_ratio: '4:5',
})

const validOutput = {
  audit: { target_segment: 'SMB founders', angle: 'Operational speed', core_pain: 'Slow lead response' },
  hooks: [
    { id: 'h1', type: 'provocation', text: 'Your AI is not the bottleneck.', rationale: 'Challenges the default belief.' },
    { id: 'h2', type: 'mistake', text: 'One routing mistake delays every lead.', rationale: 'Names an actionable error.' },
    { id: 'h3', type: 'case_study', text: 'Map the handoff before buying another model.', rationale: 'Avoids inventing unsupported numbers.' },
  ],
  timeline: [{ step: 1, timestamp_or_slide: 'Slide 1', visual_description: 'Routing map', script_text: 'Start here.', on_screen_text: 'Fix the handoff' }],
  cta: { action_type: 'comment', copy: 'Comment MAP for the checklist.' },
  visual_spec: {
    prompt: 'Premium modern clay isometric routing map with cyan accents.',
    negative_prompt: 'Childish mascot, cheap plastic, watermark.',
    recommended_ratio: '4:5',
    style_preset: '3d_modern_clay_isometric',
  },
}

assert.equal(MarketingOutputSchema.safeParse(validOutput).success, true, 'valid structured campaign must pass')
assert.equal(MarketingOutputSchema.safeParse({
  ...validOutput,
  hooks: validOutput.hooks.map((hook) => ({ ...hook, type: 'mistake' })),
}).success, false, 'all three hook types are mandatory')
assert.equal(GenerateCampaignInputSchema.safeParse({ ...input, unexpected: true }).success, false, 'request contract must reject unknown fields')

const prompt = buildMarketingPrompt(input, brand)
assert.match(prompt, /3d_modern_clay_isometric/, 'selected 3D preset must reach the prompt')
assert.match(prompt, /modern clay render/i, '3D must be a supported preset, not globally banned')
assert.doesNotMatch(VISUAL_PRESETS.editorial_photo_35mm.negative, /no 3d/i, 'photo preset must not impose a global hard-coded 3D ban')

const endpoint = read('supabase/functions/generate-campaign/index.ts')
assert.match(endpoint, /type: 'json_schema'/, 'OpenRouter must receive json_schema structured output')
assert.match(endpoint, /strict: true/, 'provider schema must run in strict mode')
assert.match(endpoint, /require_parameters: true/, 'routing must exclude providers that ignore structured output')
assert.match(endpoint, /MarketingOutputSchema\.safeParse/, 'provider output must be validated again on the server')
assert.match(endpoint, /\.eq\('account_id', accountId\)\.eq\('id', input\.brand_kit_id\)/, 'Brand Kit lookup must be tenant-bound')
assert.match(endpoint, /record_token_usage/, 'actual provider usage must be accounted for')

const migration = read('supabase/migrations/20260830120000_marketing_brand_kits.sql')
assert.match(migration, /enable row level security/i, 'Brand Kits need RLS')
assert.match(migration, /account_id = public\.current_account_id\(\)/, 'Brand Kit policy must isolate tenants')
assert.match(migration, /3d_modern_clay_isometric/, 'database preset allowlist must include 3D')
assert.match(migration, /flat_vector_infographic/, 'database preset allowlist must include vector illustration')

const vercel = JSON.parse(read('vercel.json'))
const marketingRoute = vercel.rewrites.find((rule) => rule.source === '/api/marketing/generate-campaign')
assert.ok(marketingRoute, 'product API path must proxy to the Edge Function')
assert.match(marketingRoute.destination, /\/functions\/v1\/generate-campaign$/, 'marketing proxy must target the campaign function')

console.log('Marketing campaign schema, presets, tenant isolation, Structured Outputs and API wiring passed.')
