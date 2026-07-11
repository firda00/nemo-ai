// Auto follow-up / nurture sequences ("автоворонка дожима").
// The AI keeps nudging a lead over several days until they convert or opt out.
// Each call advances due sequences: generate the next message from the conversation
// + business profile, send it (Telegram or Gmail), then reschedule or finish.
//
//   POST /functions/v1/follow-up
//   User (Bearer jwt):
//     { action:'enqueue', channel, target, goal, dialogue_id?, agent_id?, lead_id?, max_steps?, cadence_hours?, first_delay_hours? }
//     { action:'list' }                       -> { items }
//     { action:'stop', id }                   -> { ok }
//     { action:'run_mine', force? }           -> { processed, results }  (owner "run now")
//   Cron (x-cron-secret header):
//     { action:'run_due' }                    -> { processed, results }  (all accounts)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { googleAccessToken } from '../_shared/google.ts'
import { tgSend } from '../_shared/telegram.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const CRON_SECRET = Deno.env.get('FOLLOWUP_CRON_SECRET') ?? ''

/* eslint-disable @typescript-eslint/no-explicit-any */

// per-step intent so each message escalates naturally instead of repeating itself
function stepIntent(step: number, maxSteps: number): string {
  if (step <= 0) return 'A gentle first reminder: re-open the conversation, restate the single biggest benefit for THIS person, and ask one easy question. Do not sound automated.'
  if (step >= maxSteps - 1) return 'Final touch: a friendly last-call with a concrete reason to act now (a limited spot, a bonus, or a deadline if the business profile supports one). Make it easy to say yes.'
  return 'Middle touch: address the most likely objection (price, time, doubt), add one piece of proof or a concrete example, and invite a small next step.'
}

async function businessBlock(admin: any, accountId: string): Promise<string> {
  const { data } = await admin.from('business_profiles').select('*').eq('account_id', accountId).maybeSingle()
  if (!data) return ''
  const rows: [string, unknown][] = [
    ['Компания', data.name], ['Сфера', data.industry], ['О компании', data.about],
    ['Аудитория', data.audience], ['Продукты/услуги', data.offerings], ['Тон', data.tone], ['Города', data.cities],
  ]
  const filled = rows.filter(([, v]) => v && String(v).trim())
  return filled.length ? '\n\n=== БИЗНЕС КЛИЕНТА (пиши от его лица, факты не выдумывай) ===\n' + filled.map(([k, v]) => `${k}: ${String(v).trim()}`).join('\n') : ''
}

// RFC822 -> base64url for Gmail send
function buildRawEmail(from: string, to: string, subject: string, body: string): string {
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  const enc = (s: string) => `=?UTF-8?B?${b64(s)}?=`
  const mime = `From: ${from}\r\nTo: ${to}\r\nSubject: ${enc(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}`
  return b64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Advance ONE sequence: generate + send the next message, then reschedule or finish.
// Returns a short status string for the response (never throws — one bad row must
// not abort a batch cron run).
async function processOne(admin: any, row: any): Promise<{ id: string; status: string }> {
  try {
    const accountId = row.account_id
    const { data: acc } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).single()
    if (acc?.blocked || Number(acc?.token_balance ?? 0) <= 0) return { id: row.id, status: 'skipped_no_tokens' }

    // Resolve the send target + (for telegram) the bot token and conversation history.
    let botToken = ''
    let chatId = String(row.target ?? '')
    let history: { author: string; content: string }[] = []

    if (row.dialogue_id) {
      const { data: dlg } = await admin.from('dialogues').select('external_id, channel_id, agent_id, updated_at').eq('id', row.dialogue_id).maybeSingle()
      if (dlg) {
        if (!chatId) chatId = String(dlg.external_id ?? '')
        // STOP-ON-REPLY: if the customer wrote after our last message, they're engaged —
        // hand back to the live agent instead of nagging.
        if (row.last_sent_at) {
          const { data: replied } = await admin.from('messages').select('id').eq('dialogue_id', row.dialogue_id).eq('author', 'customer').gt('created_at', row.last_sent_at).limit(1)
          if (replied && replied.length) {
            await admin.from('follow_ups').update({ status: 'converted', updated_at: new Date().toISOString() }).eq('id', row.id)
            return { id: row.id, status: 'converted_reply' }
          }
        }
        const { data: msgs } = await admin.from('messages').select('author, content').eq('dialogue_id', row.dialogue_id).eq('message_type', 'chat').order('created_at', { ascending: false }).limit(10)
        history = (msgs ?? []).reverse()
        if (row.channel === 'telegram' && dlg.channel_id) {
          const { data: ch } = await admin.from('channels').select('credentials').eq('id', dlg.channel_id).maybeSingle()
          botToken = ch?.credentials?.bot_token ?? ''
        }
      }
    }
    // No dialogue channel? fall back to any connected telegram bot on the account.
    if (row.channel === 'telegram' && !botToken) {
      const { data: agents } = await admin.from('agents').select('id').eq('account_id', accountId)
      const ids = (agents ?? []).map((a: any) => a.id)
      if (ids.length) {
        const { data: ch } = await admin.from('channels').select('credentials').in('agent_id', ids).eq('type', 'telegram').limit(1).maybeSingle()
        botToken = ch?.credentials?.bot_token ?? ''
      }
    }

    const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
    if (!orKey) return { id: row.id, status: 'skipped_no_llm_key' }
    const biz = await businessBlock(admin, accountId)

    const histText = history.length
      ? history.map((m) => `${m.author === 'customer' ? 'Клиент' : 'Мы'}: ${String(m.content).slice(0, 300)}`).join('\n')
      : '(предыдущей переписки нет — это первый дожим по этому контакту)'

    const sys =
      'Ты — вежливый, живой менеджер по продажам, который дожимает лида в мессенджере. ' +
      `Напиши ОДНО короткое сообщение (2–4 предложения) на языке клиента (по переписке; если непонятно — на русском). ` +
      `Это касание №${(row.step ?? 0) + 1} из ${row.max_steps}. Интент этого касания: ${stepIntent(row.step ?? 0, row.max_steps)} ` +
      'Пиши как реальный человек: без «Здравствуйте, уважаемый», без канцелярита, без markdown и без подписи. Мягкий призыв в конце. ' +
      'Не выдумывай факты, скидки и сроки, которых нет в профиле бизнеса. Если клиент явно отказался — не дави.' + biz
    const usr = `Цель дожима: ${row.goal || 'вернуть клиента к покупке/записи'}\n\nПереписка:\n${histText}\n\nНапиши следующее сообщение.`

    const msgs: ChatMsg[] = [{ role: 'system', content: sys }, { role: 'user', content: usr }]
    const r = await callOpenRouter({ apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.7, maxTokens: 400, messages: msgs })
    const text = (r.content ?? '').trim()
    if (!text) return { id: row.id, status: 'skipped_empty' }

    // Deliver
    let sent = false
    if (row.channel === 'telegram') {
      if (!botToken || !chatId) return { id: row.id, status: 'skipped_no_target' }
      sent = await tgSend(botToken, chatId, text)
      if (sent && row.dialogue_id) await admin.from('messages').insert({ dialogue_id: row.dialogue_id, author: 'agent', content: text })
    } else if (row.channel === 'email') {
      const g = await googleAccessToken(admin, accountId)
      if (!g.token) return { id: row.id, status: 'skipped_google_not_connected' }
      const subject = row.goal ? String(row.goal).slice(0, 120) : 'На связи'
      const raw = buildRawEmail(g.email || 'me', chatId, subject, text)
      const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
      }).then((x) => x.json())
      sent = Boolean(resp?.id)
    }
    if (!sent) return { id: row.id, status: 'send_failed' }

    // Account for tokens
    if (r.tokens) {
      await admin.from('usage').insert({ account_id: accountId, tokens: r.tokens, model: PRIMARY_MODEL })
      await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: r.tokens })
    }

    // Advance: schedule the next step or finish the sequence
    const nextStep = (row.step ?? 0) + 1
    const now = new Date()
    const patch: Record<string, unknown> = { step: nextStep, last_sent_at: now.toISOString(), last_message: text.slice(0, 1000), claimed_at: null, updated_at: now.toISOString() }
    if (nextStep >= row.max_steps) {
      patch.status = 'done'
    } else {
      patch.status = 'active'
      const cadence: number[] = Array.isArray(row.cadence_hours) ? row.cadence_hours : [24, 72, 168]
      const hrs = Number(cadence[nextStep] ?? cadence[cadence.length - 1] ?? 72)
      patch.next_run_at = new Date(now.getTime() + hrs * 3600 * 1000).toISOString()
    }
    await admin.from('follow_ups').update(patch).eq('id', row.id)
    return { id: row.id, status: nextStep >= row.max_steps ? 'sent_done' : 'sent_scheduled' }
  } catch (e) {
    return { id: row.id, status: 'error:' + String(e).slice(0, 80) }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  // --- CRON path: process ALL due sequences (no user, static secret) ---
  const cronSecret = req.headers.get('x-cron-secret')
  if (cronSecret && CRON_SECRET && cronSecret === CRON_SECRET) {
    if (action !== 'run_due') return json({ error: 'cron can only run_due' }, 400)
    const { data: due, error } = await admin.rpc('claim_due_follow_ups', { p_limit: 50 })
    if (error) return json({ ok: false, error: error.message }, 500)
    const results = []
    for (const row of due ?? []) results.push(await processOne(admin, row))
    return json({ ok: true, processed: results.length, results })
  }

  // --- USER path (Bearer jwt) ---
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  if (action === 'enqueue') {
    const channel = body.channel === 'email' ? 'email' : 'telegram'
    const target = String(body.target ?? '').trim()
    const goal = String(body.goal ?? '').trim().slice(0, 500)
    if (!target && !body.dialogue_id) return json({ error: 'target or dialogue_id required' }, 400)
    const maxSteps = Math.max(1, Math.min(6, Number(body.max_steps) || 3))
    const cadence = Array.isArray(body.cadence_hours) && body.cadence_hours.length ? body.cadence_hours.map((h: any) => Math.max(1, Number(h) || 24)).slice(0, 6) : [24, 72, 168]
    const firstDelay = Number(body.first_delay_hours)
    const delayHrs = Number.isFinite(firstDelay) ? Math.max(0, firstDelay) : cadence[0]
    const nextRun = new Date(Date.now() + delayHrs * 3600 * 1000).toISOString()
    const { data, error } = await admin.from('follow_ups').insert({
      account_id: accountId, channel, target: target || null, goal,
      agent_id: body.agent_id ?? null, dialogue_id: body.dialogue_id ?? null, lead_id: body.lead_id ?? null,
      max_steps: maxSteps, cadence_hours: cadence, next_run_at: nextRun,
    }).select('*').single()
    if (error) return json({ error: error.message }, 400)
    return json({ ok: true, item: data })
  }

  if (action === 'list') {
    const { data } = await admin.from('follow_ups').select('*').eq('account_id', accountId).order('created_at', { ascending: false }).limit(100)
    return json({ ok: true, items: data ?? [] })
  }

  if (action === 'stop') {
    const id = String(body.id ?? '')
    if (!id) return json({ error: 'id required' }, 400)
    await admin.from('follow_ups').update({ status: 'stopped', updated_at: new Date().toISOString() }).eq('id', id).eq('account_id', accountId)
    return json({ ok: true })
  }

  if (action === 'run_mine') {
    // owner triggers their OWN due sequences now (for testing / "send now")
    const q = admin.from('follow_ups').select('*').eq('account_id', accountId).eq('status', 'active')
    const { data: rows } = body.force ? await q.limit(20) : await q.lte('next_run_at', new Date().toISOString()).limit(20)
    const results = []
    for (const row of rows ?? []) {
      const { data: claimed } = await admin.from('follow_ups')
        .update({ status: 'processing', claimed_at: new Date().toISOString(), attempt_count: Number(row.attempt_count ?? 0) + 1, updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('account_id', accountId).eq('status', 'active').select('*').maybeSingle()
      if (claimed) results.push(await processOne(admin, claimed))
    }
    return json({ ok: true, processed: results.length, results })
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
