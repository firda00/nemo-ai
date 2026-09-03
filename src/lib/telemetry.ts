import { isSupabaseEnabled, supabase } from './supabase'

type SafeValue = string | number | boolean | null

function safePath(): string {
  if (typeof window === 'undefined') return ''
  return window.location.pathname.slice(0, 300)
}

function safeProperties(input: Record<string, unknown> = {}): Record<string, SafeValue> {
  const out: Record<string, SafeValue> = {}
  for (const [key, value] of Object.entries(input).slice(0, 20)) {
    if (!/^[a-z0-9_]{1,50}$/i.test(key)) continue
    if (typeof value === 'string') out[key] = value.slice(0, 200)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
  }
  return out
}

export async function trackEvent(name: string, properties: Record<string, unknown> = {}): Promise<void> {
  if (!isSupabaseEnabled || !supabase || !/^[a-z0-9_]{2,80}$/.test(name)) return
  try { await supabase.from('product_events').insert({ name, path: safePath(), properties: safeProperties(properties) }) } catch { /* telemetry must never break the product */ }
}

export async function recordClientError(error: unknown, source = 'ui'): Promise<void> {
  if (!isSupabaseEnabled || !supabase) return
  const e = error instanceof Error ? error : new Error(String(error))
  const message = e.message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 500)
  const stack = (e.stack ?? '').replace(/https?:\/\/[^\s)]+/g, '[url]').slice(0, 4000)
  try {
    await supabase.from('client_errors').insert({
      fingerprint: `${source}:${message}`.slice(0, 300), message, stack, path: safePath(),
      browser: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 300),
    })
  } catch { /* avoid recursive failures while offline */ }
}

export type FeedbackTopic = 'agent_quality' | 'speed' | 'technical' | 'billing' | 'onboarding' | 'other'

export async function submitFeedback(
  rating: -1 | 1,
  category: 'product' | 'agent_result' | 'bug' | 'idea',
  comment: string,
  options: { topic?: FeedbackTopic; contactRequested?: boolean } = {},
): Promise<{ ok: boolean; id?: string }> {
  if (!isSupabaseEnabled || !supabase) return { ok: false }
  let result = await supabase.from('customer_feedback').insert({
    rating,
    category,
    topic: options.topic ?? null,
    contact_requested: options.contactRequested === true,
    comment: comment.trim().slice(0, 2000) || null,
    path: safePath(),
  }).select('id').single()
  // During a rolling deploy the frontend can reach an older database for a few minutes.
  // Keep the complaint instead of losing it; the prefix remains visible to the administrator.
  if (result.error && /topic|contact_requested|schema cache/i.test(result.error.message)) {
    const prefix = `[topic:${options.topic ?? 'none'}; contact:${options.contactRequested === true ? 'yes' : 'no'}] `
    result = await supabase.from('customer_feedback').insert({
      rating,
      category,
      comment: `${prefix}${comment.trim()}`.slice(0, 2000) || prefix.trim(),
      path: safePath(),
    }).select('id').single()
  }
  const { data, error } = result
  if (!error) void trackEvent('feedback_submitted', { rating, category, topic: options.topic ?? 'none' })
  return { ok: !error, id: data?.id }
}

function stableBucket(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return Math.abs(hash) % 100
}

export async function featureEnabled(key: string, userId = ''): Promise<boolean> {
  if (!isSupabaseEnabled || !supabase) return true
  try {
    const { data } = await supabase.from('feature_flags').select('enabled,rollout_percent,account_id').eq('key', key).order('account_id', { ascending: false, nullsFirst: false })
    const flag = data?.[0]
    return flag ? Boolean(flag.enabled) && stableBucket(`${userId}:${key}`) < Number(flag.rollout_percent ?? 0) : true
  } catch { return true }
}
