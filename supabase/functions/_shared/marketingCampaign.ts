import { z } from 'zod'

export const MarketingPlatformSchema = z.enum([
  'reels',
  'shorts',
  'telegram',
  'linkedin',
  'instagram_carousel',
])

export const MarketingGoalSchema = z.enum([
  'lead_gen',
  'reach',
  'sales',
  'expert_authority',
])

export const MarketingRatioSchema = z.enum(['1:1', '4:5', '9:16'])

export const HookTypeSchema = z.enum(['provocation', 'mistake', 'case_study'])

export const VisualPresetSchema = z.enum([
  'editorial_photo_35mm',
  'minimal_tech_ui',
  '3d_modern_clay_isometric',
  'flat_vector_infographic',
])

export const VISUAL_PRESETS = {
  editorial_photo_35mm: {
    label: 'Editorial Photo (35mm)',
    positive: '35mm editorial photography, natural light, authentic materials, documentary detail',
    negative: 'plastic skin, overprocessed HDR, stock-photo posing, illegible text, watermark',
  },
  minimal_tech_ui: {
    label: 'Minimal Tech UI',
    positive: 'clean product UI, precise grid, soft elevation, modern typography, useful data cards',
    negative: 'clutter, fake metrics, illegible interface text, excessive glow, watermark',
  },
  '3d_modern_clay_isometric': {
    label: '3D Modern Clay / Isometric',
    positive: 'premium modern clay render, controlled isometric composition, tactile materials, studio lighting',
    negative: 'childish mascot, cheap plastic, noisy scene, distorted geometry, watermark',
  },
  flat_vector_infographic: {
    label: 'Flat Vector / Infographic',
    positive: 'crisp flat vector infographic, strong information hierarchy, restrained shapes, accessible contrast',
    negative: 'clip-art look, dense decoration, unreadable labels, inconsistent stroke widths, watermark',
  },
} as const

const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'expected a six-digit HEX color')

export const BrandKitSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  colors: z.array(HexColorSchema).min(1).max(8),
  fonts: z.object({
    heading: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(120),
  }).strict(),
  tone_of_voice: z.string().trim().min(1).max(1200),
  stop_words: z.array(z.string().trim().min(1).max(80)).max(100),
  visual_preset: VisualPresetSchema,
  custom_visual_rules: z.string().trim().max(2000).default(''),
}).strict()

export const GenerateCampaignInputSchema = z.object({
  topic: z.string().trim().min(3).max(4000),
  platform: MarketingPlatformSchema,
  goal: MarketingGoalSchema,
  brand_kit_id: z.string().uuid(),
  image_ratio: MarketingRatioSchema.optional(),
  language: z.enum(['uz', 'ru', 'en']).default('ru'),
  context: z.string().trim().max(8000).optional(),
}).strict()

const MarketingHookSchema = z.object({
  id: z.string().trim().min(1).max(80),
  type: HookTypeSchema,
  text: z.string().trim().min(1).max(600),
  rationale: z.string().trim().min(1).max(800),
}).strict()

export const MarketingOutputSchema = z.object({
  audit: z.object({
    target_segment: z.string().trim().min(1).max(1000),
    angle: z.string().trim().min(1).max(1000),
    core_pain: z.string().trim().min(1).max(1000),
  }).strict(),
  hooks: z.array(MarketingHookSchema).length(3).superRefine((hooks, ctx) => {
    const types = new Set(hooks.map((hook) => hook.type))
    for (const required of HookTypeSchema.options) {
      if (!types.has(required)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `missing hook type: ${required}` })
      }
    }
    if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'hook ids must be unique' })
    }
  }),
  timeline: z.array(z.object({
    step: z.number().int().min(1).max(100),
    timestamp_or_slide: z.string().trim().min(1).max(120),
    visual_description: z.string().trim().min(1).max(1200),
    script_text: z.string().trim().min(1).max(2000),
    on_screen_text: z.string().trim().min(1).max(600),
  }).strict()).min(1).max(30),
  cta: z.object({
    action_type: z.string().trim().min(1).max(120),
    copy: z.string().trim().min(1).max(800),
  }).strict(),
  visual_spec: z.object({
    prompt: z.string().trim().min(1).max(3000),
    negative_prompt: z.string().trim().min(1).max(2000),
    recommended_ratio: MarketingRatioSchema,
    style_preset: VisualPresetSchema,
  }).strict(),
}).strict()

export type MarketingOutput = z.infer<typeof MarketingOutputSchema>
export type GenerateCampaignInput = z.infer<typeof GenerateCampaignInputSchema>
export type BrandKit = z.infer<typeof BrandKitSchema>

const stringSchema = (description: string) => ({ type: 'string', description })

// Kept next to MarketingOutputSchema so the provider contract and server validator evolve together.
export const MARKETING_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    audit: {
      type: 'object', additionalProperties: false,
      properties: {
        target_segment: stringSchema('Specific audience segment for this campaign.'),
        angle: stringSchema('Concrete marketing angle grounded in the task and audience.'),
        core_pain: stringSchema('Primary audience pain addressed by the campaign.'),
      },
      required: ['target_segment', 'angle', 'core_pain'],
    },
    hooks: {
      type: 'array', minItems: 3, maxItems: 3,
      description: 'Exactly one provocation, one mistake and one case_study hook.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: stringSchema('Unique stable hook identifier.'),
          type: { type: 'string', enum: HookTypeSchema.options },
          text: stringSchema('Publishable hook copy.'),
          rationale: stringSchema('Why this hook should work for the target segment.'),
        },
        required: ['id', 'type', 'text', 'rationale'],
      },
    },
    timeline: {
      type: 'array', minItems: 1, maxItems: 30,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          step: { type: 'integer', minimum: 1, maximum: 100 },
          timestamp_or_slide: stringSchema('Video time range or carousel slide number.'),
          visual_description: stringSchema('Concrete shot, B-roll or slide composition.'),
          script_text: stringSchema('Voiceover or main narrative for this step.'),
          on_screen_text: stringSchema('Short text visible on screen.'),
        },
        required: ['step', 'timestamp_or_slide', 'visual_description', 'script_text', 'on_screen_text'],
      },
    },
    cta: {
      type: 'object', additionalProperties: false,
      properties: {
        action_type: stringSchema('Concrete conversion action.'),
        copy: stringSchema('Publishable CTA copy.'),
      },
      required: ['action_type', 'copy'],
    },
    visual_spec: {
      type: 'object', additionalProperties: false,
      properties: {
        prompt: stringSchema('Production-ready English image prompt using the selected brand preset.'),
        negative_prompt: stringSchema('Preset-specific exclusions; never a universal ban on 3D or illustration.'),
        recommended_ratio: { type: 'string', enum: MarketingRatioSchema.options },
        style_preset: { type: 'string', enum: VisualPresetSchema.options },
      },
      required: ['prompt', 'negative_prompt', 'recommended_ratio', 'style_preset'],
    },
  },
  required: ['audit', 'hooks', 'timeline', 'cta', 'visual_spec'],
} as const

export function buildMarketingPrompt(input: GenerateCampaignInput, brand: BrandKit): string {
  const preset = VISUAL_PRESETS[brand.visual_preset]
  const languageName = { uz: 'Uzbek', ru: 'Russian', en: 'English' }[input.language]
  return [
    'Create a senior-level content marketing campaign. Return only the requested structured object.',
    `Write all audience-facing copy in ${languageName}. Keep the image prompt and negative prompt in English.`,
    'Do not invent facts, measurements, customer results, prices or evidence. If the brief lacks a number, do not manufacture one for the case-study hook.',
    'The hooks array must contain exactly one item of each type: provocation, mistake, case_study. Use unique ids.',
    'Timeline steps must be sequential and adapted to the selected platform.',
    `Topic: ${input.topic}`,
    `Platform: ${input.platform}`,
    `Goal: ${input.goal}`,
    input.context ? `Additional context: ${input.context}` : '',
    `Requested ratio: ${input.image_ratio ?? 'choose the best of 1:1, 4:5 or 9:16'}`,
    `Brand: ${brand.name}`,
    `Tone of voice: ${brand.tone_of_voice}`,
    `Forbidden words and phrases: ${brand.stop_words.length ? brand.stop_words.join(', ') : 'none'}`,
    `Brand colors: ${brand.colors.join(', ')}`,
    `Fonts: heading=${brand.fonts.heading}; body=${brand.fonts.body}`,
    `Visual preset id: ${brand.visual_preset}`,
    `Visual preset direction: ${preset.positive}`,
    `Preset negative direction: ${preset.negative}`,
    brand.custom_visual_rules ? `Additional visual rules: ${brand.custom_visual_rules}` : '',
    `The visual_spec.style_preset must be exactly "${brand.visual_preset}".`,
    input.image_ratio ? `The visual_spec.recommended_ratio must be exactly "${input.image_ratio}".` : '',
  ].filter(Boolean).join('\n')
}

export function estimateMarketingUsage(prompt: string, maxCompletionTokens: number, model: string) {
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4))
  const completionTokens = maxCompletionTokens
  const totalTokens = promptTokens + completionTokens
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, model }
}
