// Media generation billing model (images / video / voice):
//   • BYO — the account connected its OWN provider key → generate on it (their cost, no Nemo cap).
//     Available on any paid tier.
//   • INCLUDED — "Pro/Max" tiers (plan.mediaIncluded): generate on Nemo's key, no API to connect,
//     monthly fair-use cap.
//   • TRIAL — only plans with an explicit mediaTrialWeekly allowance may temporarily use Nemo's key.
// resolveMediaAccess returns the API key to use + the source, or a block code + message.
// Callers pass acceptedProviders to opt into a direct adapter (e.g. ['openai'] for an explicit
// gpt-image-1 request); by default image/video stay on OpenRouter so a stored key for an
// unrelated provider can never hijack the route or receive the wrong credential.
import { type PlanLimit, monthlyMedia, weeklyMedia } from './plans.ts'
import { openSecret, providerSecretContext } from './secretBox.ts'

export type MediaKind = 'image' | 'video' | 'voice'
export interface MediaAccess {
  ok: boolean
  key?: string
  source?: 'byo' | 'included' | 'trial' | 'admin'
  provider?: string // for BYO: which provider_keys entry matched (e.g. 'elevenlabs' vs 'openai')
  code?: 'PLAN' | 'NEED_KEY' | 'LIMIT' | 'ERROR'
  message?: string
}

// provider_keys entries that may EVER act as the customer's own key for a media kind.
// acceptedProviders can only narrow within this list, never widen it.
const BYO_PROVIDERS: Record<MediaKind, string[]> = {
  image: ['openrouter', 'openai'],
  video: ['openrouter', 'replicate'],
  voice: ['openrouter', 'elevenlabs', 'openai'],
}
// Defaults when the caller doesn't opt into a direct adapter: image/video run through
// OpenRouter only; voice keeps its historical provider order.
const DEFAULT_ACCEPTED: Record<MediaKind, string[]> = {
  image: ['openrouter'],
  video: ['openrouter'],
  voice: ['openrouter', 'elevenlabs', 'openai'],
}

const MSG_TRIAL_OUT =
  'Пробные генерации на этой неделе исчерпаны. Подключите свой API-ключ (тарифы Стандарт/Плюс) или перейдите на Pro/Макс — там генерация включена без подключения API.'
const MSG_NO_NEMO_KEY =
  'Для этого типа генерации подключите свой API-ключ провайдера в разделе «Интеграции».'
const MSG_NO_PLAN =
  'Генерация недоступна на вашем тарифе. Перейдите на платный тариф.'
const MSG_KEY_CHECK_FAILED =
  'Не удалось проверить подключённые ключи. Попробуйте ещё раз.'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveMediaAccess(
  admin: any, accountId: string, plan: PlanLimit, kind: MediaKind, nemoKey: string, isAdmin = false,
  acceptedProviders?: string[],
): Promise<MediaAccess> {
  // Feature gate: generation only on paid tiers (own key too — "own key only on paid tiers").
  if (!plan.media && !isAdmin) return { ok: false, code: 'PLAN', message: MSG_NO_PLAN }

  const accepted = (acceptedProviders ?? DEFAULT_ACCEPTED[kind]).filter((p) => BYO_PROVIDERS[kind].includes(p))

  // 1) BYO — own key for an ACCEPTED provider → use it (their cost, no Nemo cap).
  // Query only the accepted rows and decrypt only the selected one, so an unrelated
  // or corrupt key for another provider can never affect this request.
  if (accepted.length) {
    const { data: keys, error } = await admin.from('provider_keys')
      .select('provider, api_key').eq('account_id', accountId).in('provider', accepted)
    // fail closed: a DB error must not fall through to Nemo's paid key
    if (error) return { ok: false, code: 'ERROR', message: MSG_KEY_CHECK_FAILED }
    const sealedByProvider = new Map<string, string>(
      (keys ?? []).map((r: { provider: string; api_key: string }) => [r.provider, r.api_key]),
    )
    for (const prov of accepted) {
      const sealed = sealedByProvider.get(prov)
      if (!sealed) continue
      try {
        const key = await openSecret(sealed, providerSecretContext(accountId, prov))
        if (key) return { ok: true, key, source: 'byo', provider: prov }
      } catch { /* fall through to the explicit ERROR below */ }
      // the selected key is unreadable — surface it instead of silently billing Nemo's key
      return { ok: false, code: 'ERROR', message: MSG_KEY_CHECK_FAILED }
    }
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
  // 4) Explicitly trial-enabled plans may use Nemo's key up to their weekly allowance.
  if (plan.mediaTrialWeekly > 0) {
    const usedWk = await weeklyMedia(admin, accountId)
    if (usedWk < plan.mediaTrialWeekly) return { ok: true, key: nemoKey, source: 'trial' }
    return { ok: false, code: 'NEED_KEY', message: MSG_TRIAL_OUT }
  }
  return { ok: false, code: 'NEED_KEY', message: MSG_NO_NEMO_KEY }
}
