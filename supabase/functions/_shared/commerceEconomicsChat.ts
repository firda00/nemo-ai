// Telegram economics input for the Commerce owner chat.
//
// Three rules hold this together and none of them may be relaxed:
//   1. Only the chat bound through /start (notify_chat_id + notify_channel_id) can propose money.
//   2. The LLM only PARSES. Nothing reaches commerce_skus until the owner presses Yes on the
//      exact numbers echoed back — voice transcription and extraction both misfire, and a wrong
//      cost silently poisons every margin calculation downstream.
//   3. SKU matching stays exact. Several candidates -> ask with buttons. None -> say so.
import { callOpenRouter } from './llm.ts'
import { escapeHtml } from './telegramFormat.ts'

export const CB_APPLY = 'ce'
export const CB_PICK = 'cs'

type Parsed = {
  product: string
  unit_cost_uzs: number | null
  lead_time_days: number | null
  safety_stock: number | null
  min_margin_percent: number | null
}

export type OwnerChat = { accountId: string; channelId: string; chatId: string }

// Cheap pre-filter: only pay for an LLM call when the message plausibly carries economics.
// Keeps ordinary owner chat (questions, greetings) on the normal agent path.
const ECONOMICS_HINT = /(себестоимо|закуп|costi|tannarx|доставк|срок|lead\s*time|запас|safety|маржа|margin|foyda)/i
export function looksLikeEconomics(text: string): boolean {
  return /\d/.test(text) && ECONOMICS_HINT.test(text)
}

const SCHEMA = `{"product":"string, the product name or SKU code exactly as the owner said it","unit_cost_uzs":"number or null, supplier purchase cost per unit in UZS","lead_time_days":"number or null, supplier delivery time in days","safety_stock":"number or null, buffer units","min_margin_percent":"number or null, minimum acceptable margin percent"}`

// Models that ignore response_format wrap JSON in a ```json fence or add a sentence around it.
// Extracting the outermost object costs nothing and saves an otherwise silent parse failure.
function stripFence(content: string): string {
  const text = String(content ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

export async function parseEconomicsMessage(apiKey: string, model: string, text: string): Promise<Parsed | null> {
  const raw = await callOpenRouter({
    apiKey,
    model,
    temperature: 0,
    maxTokens: 300,
    responseFormat: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You extract unit economics a marketplace seller dictates in Russian or Uzbek. Return ONLY JSON matching ${SCHEMA}. Rules: never invent a number that was not stated; use null for anything not mentioned; "80 тысяч"/"80 ming" means 80000; costs are in UZS, never tiyin; if no product is identifiable return {"product":""}.`,
      },
      { role: 'user', content: text.slice(0, 1000) },
    ],
  })
    .then((res) => JSON.parse(stripFence(res.content)) as Record<string, unknown>)
    .catch(() => null)
  if (!raw || typeof raw !== 'object') return null

  const num = (value: unknown, min: number, max: number): number | null => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[\s\u00a0]/g, '').replace(',', '.')) : NaN
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null
  }
  const product = typeof raw.product === 'string' ? raw.product.trim().slice(0, 200) : ''
  if (!product) return null
  const parsed: Parsed = {
    product,
    unit_cost_uzs: num(raw.unit_cost_uzs, 0, 100_000_000_000),
    lead_time_days: num(raw.lead_time_days, 0, 365),
    safety_stock: num(raw.safety_stock, 0, 1_000_000),
    min_margin_percent: num(raw.min_margin_percent, 0, 99.9999),
  }
  const hasValue = parsed.unit_cost_uzs != null || parsed.lead_time_days != null || parsed.safety_stock != null || parsed.min_margin_percent != null
  return hasValue ? parsed : null
}

export type SkuCandidate = { id: string; external_sku: string; title: string }

// Exact first, then a contained-substring fallback that must still be unambiguous. Anything
// fuzzier would let "наушники" silently overwrite the economics of the wrong headphone SKU.
export function matchSkus(query: string, skus: SkuCandidate[]): SkuCandidate[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const exact = skus.filter((sku) => sku.external_sku.toLowerCase() === needle || sku.title.trim().toLowerCase() === needle)
  if (exact.length) return exact
  return skus.filter((sku) => sku.title.toLowerCase().includes(needle) || needle.includes(sku.title.toLowerCase()))
}

const money = (uzs: number) => `${Math.round(uzs).toLocaleString('ru-RU')} сум`

export function skuLabel(sku: SkuCandidate): string {
  return `<b>${escapeHtml(sku.title)}</b> <code>${escapeHtml(sku.external_sku)}</code>`
}

export function proposalText(sku: SkuCandidate, parsed: Parsed): string {
  const lines = [
    parsed.unit_cost_uzs != null ? `💵 Себестоимость: <b>${money(parsed.unit_cost_uzs)}</b>` : null,
    parsed.lead_time_days != null ? `🚚 Срок поставки: <b>${parsed.lead_time_days} дн.</b>` : null,
    parsed.safety_stock != null ? `📦 Страховой запас: <b>${parsed.safety_stock} шт.</b>` : null,
    parsed.min_margin_percent != null ? `📈 Мин. маржа: <b>${parsed.min_margin_percent}%</b>` : null,
  ].filter(Boolean)
  return [
    'Проверьте, правильно ли я понял:',
    '',
    skuLabel(sku),
    ...lines,
    '',
    'Сохранить эти цифры?',
    '<i>После сохранения они считаются подтверждёнными вами — по ним включатся срочные оповещения.</i>',
  ].join('\n')
}

export function applyKeyboard(proposalId: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Да, сохранить', callback_data: `${CB_APPLY}:${proposalId}:y` },
      { text: '✖️ Нет', callback_data: `${CB_APPLY}:${proposalId}:n` },
    ]],
  }
}

export function pickKeyboard(proposalId: string, candidates: SkuCandidate[]) {
  return {
    inline_keyboard: candidates.slice(0, 5).map((sku, index) => [
      { text: `${sku.title} (${sku.external_sku})`.slice(0, 60), callback_data: `${CB_PICK}:${proposalId}:${index}` },
    ]),
  }
}

// Resolves the owner chat only if this exact chat+channel pair was bound through /start.
export async function ownerChatFor(db: any, channelId: string, chatId: string): Promise<OwnerChat | null> {
  const { data } = await db.from('business_profiles')
    .select('account_id, notify_chat_id, notify_channel_id')
    .eq('notify_chat_id', chatId).eq('notify_channel_id', channelId).maybeSingle()
  return data?.account_id ? { accountId: data.account_id, channelId, chatId } : null
}

export async function accountSkus(db: any, accountId: string): Promise<SkuCandidate[]> {
  const { data: catalogs } = await db.from('commerce_catalogs').select('id').eq('account_id', accountId)
  const ids = (catalogs ?? []).map((catalog: { id: string }) => catalog.id)
  if (!ids.length) return []
  const { data } = await db.from('commerce_skus').select('id, external_sku, title').in('catalog_id', ids).limit(1000)
  return (data ?? []) as SkuCandidate[]
}

export function proposalRow(owner: OwnerChat, parsed: Parsed, sourceText: string, candidates: SkuCandidate[], skuId: string | null) {
  return {
    account_id: owner.accountId,
    channel_id: owner.channelId,
    chat_id: owner.chatId,
    sku_id: skuId,
    candidates,
    product_query: parsed.product,
    source_text: sourceText.slice(0, 2000),
    unit_cost_tiyin: parsed.unit_cost_uzs == null ? null : Math.round(parsed.unit_cost_uzs * 100),
    lead_time_days: parsed.lead_time_days == null ? null : Math.round(parsed.lead_time_days),
    safety_stock: parsed.safety_stock == null ? null : Math.round(parsed.safety_stock),
    min_margin_percent: parsed.min_margin_percent,
  }
}
