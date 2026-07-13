// Media generation billing model (images / video / voice):
//   • BYO — the account connected its OWN provider key → generate on it (their cost, no Nemo cap).
//     Available on any paid tier.
//   • INCLUDED — "Pro/Max" tiers (plan.mediaIncluded): generate on Nemo's key, no API to connect,
//     monthly fair-use cap.
//   • TRIAL — "Standard/Plus" tiers (BYO) with no key yet: a small weekly free allowance on Nemo's
//     key, then they must connect a key or upgrade.
// resolveMediaAccess returns the API key to use + the source, or a block code + message.
import { type PlanLimit, monthlyMedia, weeklyMedia } from './plans.ts'
import { openSecret } from './secretBox.ts'

export type MediaKind = 'image' | 'video' | 'voice'
export interface MediaAccess {
  ok: boolean
  key?: string
  source?: 'byo' | 'included' | 'trial' | 'admin'
  provider?: string // for BYO: which provider_keys entry matched (e.g. 'elevenlabs' vs 'openai')
  code?: 'PLAN' | 'NEED_KEY' | 'LIMIT'
  message?: string
}

// provider_keys entries that count as the customer's OWN key for each media kind
const BYO_PROVIDERS: Record<MediaKind, string[]> = {
  image: ['openrouter'], // nemoImage runs on an OpenRouter key
  video: ['replicate'],
  voice: ['elevenlabs', 'openai'],
}

const MSG_TRIAL_OUT =
  'Пробные генерации на этой неделе исчерпаны. Подключите свой API-ключ (тарифы Стандарт/Плюс) или перейдите на Pro/Макс — там генерация включена без подключения API.'
const MSG_NO_NEMO_KEY =
  'Для этого типа генерации подключите свой API-ключ провайдера в разделе «Интеграции».'
const MSG_NO_PLAN =
  'Генерация недоступна на вашем тарифе. Перейдите на платный тариф.'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveMediaAccess(
  admin: any, accountId: string, plan: PlanLimit, kind: MediaKind, nemoKey: string, isAdmin = false,
): Promise<MediaAccess> {
  // Feature gate: generation only on paid tiers (own key too — "own key only on paid tiers").
  if (!plan.media && !isAdmin) return { ok: false, code: 'PLAN', message: MSG_NO_PLAN }

  // 1) BYO — own key for this media kind → use it (their cost, no Nemo cap)
  const { data: keys } = await admin.from('provider_keys').select('provider, api_key').eq('account_id', accountId)
  const byProvider: Record<string, string> = {}
  for (const r of keys ?? []) byProvider[r.provider] = await openSecret(r.api_key)
  for (const prov of BYO_PROVIDERS[kind]) {
    if (byProvider[prov]) return { ok: true, key: byProvider[prov], source: 'byo', provider: prov }
  }
  // admins run on Nemo's key, uncapped (internal testing)
  if (isAdmin) return nemoKey ? { ok: true, key: nemoKey, source: 'admin' } : { ok: false, code: 'NEED_KEY', message: MSG_NO_NEMO_KEY }
  if (!nemoKey) return { ok: false, code: 'NEED_KEY', message: MSG_NO_NEMO_KEY }

  // 3) INCLUDED tiers (Pro/Max): Nemo's key + monthly fair-use cap
  if (plan.mediaIncluded) {
    const used = await monthlyMedia(admin, accountId)
    if (used >= plan.mediaMonthly) return { ok: false, code: 'LIMIT', message: `Лимит генераций по тарифу (${plan.mediaMonthly}/мес) исчерпан.` }
    return { ok: true, key: nemoKey, source: 'included' }
  }
  // 4) BYO tiers (Standard/Plus) with no key → small weekly trial on Nemo's key
  if (plan.mediaTrialWeekly > 0) {
    const usedWk = await weeklyMedia(admin, accountId)
    if (usedWk < plan.mediaTrialWeekly) return { ok: true, key: nemoKey, source: 'trial' }
  }
  return { ok: false, code: 'NEED_KEY', message: MSG_TRIAL_OUT }
}
