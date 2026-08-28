import assert from 'node:assert/strict'
import { businessIntentToForgePrompt, createBusinessIntent } from '../src/lib/business-intent.ts'

const campaign = createBusinessIntent(
  'Запусти в пятницу скидку 20% для постоянных клиентов в Telegram',
  { source: 'telegram_voice', intentId: '018ff6a0-32f4-7a11-8b30-92ab59e79a31', now: new Date('2026-08-27T08:00:00+05:00') },
)
assert.equal(campaign.goal, 'launch_campaign')
assert.equal(campaign.extractedFacts.discountPercent, 20)
assert.deepEqual(campaign.channels, ['telegram'])
assert.equal(campaign.safety.externalEffectsRequireApproval, true)
assert.equal(campaign.clarificationRequired, false)

const competitor = createBusinessIntent(
  'Проанализируй конкурента https://example.com/product и подготовь выводы',
  { intentId: '018ff6a0-32f4-7a11-8b30-92ab59e79a32' },
)
assert.equal(competitor.goal, 'competitor_audit')
assert.equal(competitor.extractedFacts.competitorUrl, 'https://example.com/product')
assert.match(businessIntentToForgePrompt(competitor), /external_effects=approval_required/)

const ambiguous = createBusinessIntent('Помоги улучшить бизнес', {
  intentId: '018ff6a0-32f4-7a11-8b30-92ab59e79a33',
})
assert.equal(ambiguous.goal, 'generic_business_task')
assert.equal(ambiguous.clarificationRequired, true)
assert.ok(ambiguous.clarificationQuestions.length > 0)

assert.throws(() => createBusinessIntent('ок', {
  intentId: '018ff6a0-32f4-7a11-8b30-92ab59e79a34',
}))

console.log('business intent tests: ok')
