// Уведомления и хранение: мгновенный алерт в Telegram для горячих лидов, все лиды — в базу.
//
// ТОЛЬКО горячие уходят в Telegram. Алерт о каждом найденном лиде превращается в поток, который
// выключают на второй день, — и вместе с ним выключают те несколько сообщений в неделю, ради
// которых всё делалось (contracts.ts:Notifier).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { LeadStore, Notifier } from './contracts.ts'
import type { Lead } from './schemas.ts'

const TABLE = 'sdr_leads'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Текст сообщения — то, что человек реально прочитает в Telegram за три секунды. */
export function formatHotLeadMessage(lead: Lead): string {
  const lines = [
    `🔥 <b>${escapeHtml(lead.name)}</b> — ${escapeHtml(lead.city)}`,
    lead.score ? `Оценка: <b>${lead.score.score}/100</b> — ${escapeHtml(lead.score.reason)}` : '',
    lead.phone ? `Телефон: ${escapeHtml(lead.phone)}` : '',
    lead.website ? `Сайт: ${escapeHtml(lead.website)}` : '',
    lead.score?.key_decision_maker ? `ЛПР: ${escapeHtml(lead.score.key_decision_maker)}` : '',
    lead.score?.icebreaker_pitch ? `\n💬 ${escapeHtml(lead.score.icebreaker_pitch)}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

/**
 * Кнопки быстрого действия — только ССЫЛКИ.
 *
 * callback_data потребовал бы запущенного вебхука, который слушает нажатия, — его в этом пайплайне
 * нет. Кнопка без обработчика нажимается и ничего не делает, а это хуже отсутствия кнопки: человек
 * решает, что расширение сломано, а не что этой части ещё не существует.
 */
function buildKeyboard(lead: Lead): Array<Array<{ text: string; url: string }>> {
  const row: Array<{ text: string; url: string }> = []
  if (lead.website) row.push({ text: '🌐 Сайт', url: lead.website })
  if (lead.enrichment.socials.telegram) row.push({ text: '✈️ Telegram', url: lead.enrichment.socials.telegram })
  return row.length ? [row] : []
}

export class TelegramNotifier implements Notifier {
  private readonly botToken: string
  private readonly chatId: string
  private readonly fetchImpl: typeof fetch

  constructor(botToken: string, chatId: string, fetchImpl: typeof fetch = fetch) {
    this.botToken = botToken
    this.chatId = chatId
    this.fetchImpl = fetchImpl
  }

  async alertHot(lead: Lead): Promise<{ ok: boolean; error?: string }> {
    if (lead.score?.status !== 'HOT') return { ok: false, error: 'not_hot' }
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: formatHotLeadMessage(lead),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: buildKeyboard(lead) },
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { ok: false, error: `telegram_http_${res.status}` }
      return { ok: true }
    } catch {
      return { ok: false, error: 'telegram_unreachable' }
    }
  }
}

/** Бот и чат для SDR-алертов — отдельная пара ключей, не бот службы поддержки платформы:
 * общий токен смешал бы алерты о лидах Ustudy IT с сообщениями клиентов Nemo в одном канале. */
export function resolveNotifier(env: NodeJS.ProcessEnv = process.env): TelegramNotifier | null {
  const token = env.SDR_TELEGRAM_BOT_TOKEN
  const chatId = env.SDR_TELEGRAM_CHAT_ID
  if (!token || !chatId) return null
  return new TelegramNotifier(token, chatId)
}

function serializeLead(lead: Lead): Record<string, unknown> {
  return {
    place_id: lead.place_id,
    dedupe_key: lead.dedupe_key,
    name: lead.name,
    normalized_name: lead.normalized_name,
    city: lead.city,
    address: lead.address,
    phone: lead.phone,
    website: lead.website,
    rating: lead.rating,
    reviews: lead.reviews,
    operational: lead.operational,
    enrichment: lead.enrichment,
    score: lead.score,
    found_at: lead.found_at,
  }
}

/** Хранилище лидов в Supabase/Postgres. Идемпотентно по dedupe_key — тот же лид не плодит строки. */
export class SupabaseLeadStore implements LeadStore {
  private readonly client: SupabaseClient

  constructor(url: string, serviceKey: string) {
    this.client = createClient(url, serviceKey)
  }

  async save(leads: Lead[]): Promise<{ added: number; skipped: number }> {
    if (!leads.length) return { added: 0, skipped: 0 }

    // Что было ДО апсерта, а не что вернул апсерт: upsert().select() отдаёт все успешно записанные
    // строки без различия «новая» и «обновлённая», а added/skipped обязан различать именно это —
    // тот же контракт, что у SheetSync.append.
    const keys = leads.map((lead) => lead.dedupe_key)
    const { data: existing, error: selectError } = await this.client.from(TABLE).select('dedupe_key').in('dedupe_key', keys)
    if (selectError) throw new Error(`sdr_leads select: ${selectError.message}`)
    const existingKeys = new Set((existing ?? []).map((row: { dedupe_key: string }) => row.dedupe_key))

    const rows = leads.map(serializeLead)
    const { error: upsertError } = await this.client.from(TABLE).upsert(rows, { onConflict: 'dedupe_key' })
    if (upsertError) throw new Error(`sdr_leads upsert: ${upsertError.message}`)

    const added = leads.filter((lead) => !existingKeys.has(lead.dedupe_key)).length
    return { added, skipped: leads.length - added }
  }
}

export function resolveLeadStore(env: NodeJS.ProcessEnv = process.env): SupabaseLeadStore | null {
  const ref = env.SUPABASE_PROJECT_REF
  const key = env.SUPABASE_SECRET_KEY
  if (!ref || !key) return null
  return new SupabaseLeadStore(`https://${ref}.supabase.co`, key)
}
