// Telegram inbound webhook. Verifies Telegram's secret token + dedups the update, then EITHER
// enqueues the update to the durable pgmq queue (TG_QUEUE=1 → a lease-serialized, rate-capped
// worker does the heavy LLM work, so a burst can never fan out into 1000 concurrent calls) OR
// processes it inline in the background (legacy waitUntil path). The flag makes this a reversible
// canary. Public (verify_jwt = false) — authenticity is Telegram's secret token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { processTelegramUpdate } from '../_shared/tgProcess.ts'
import { tgAnswerCallback, tgEditMessage, tgSendHtml, tgSendKeyboard } from '../_shared/telegram.ts'
import { escapeHtml } from '../_shared/telegramFormat.ts'
import { applyKeyboard, CB_APPLY, CB_PICK, ownerChatFor, proposalText } from '../_shared/commerceEconomicsChat.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
import { timingSafeEqual } from '../_shared/safeEqual.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('WATCH_CRON_SECRET') ?? Deno.env.get('CRON_SECRET') ?? ''
const TG_QUEUE = Deno.env.get('TG_QUEUE') === '1'
const WORKER_URL = `${SUPABASE_URL}/functions/v1/agent-worker`

async function handleCommerceCallback(db: any, channelId: string, botToken: string | undefined, cb: any): Promise<void> {
  const data = String(cb?.data ?? '')
  const chatId = String(cb?.message?.chat?.id ?? '')
  const messageId = Number(cb?.message?.message_id ?? 0)
  const parts = data.split(':')
  if (!botToken || !chatId || (parts[0] !== CB_APPLY && parts[0] !== CB_PICK)) return
  const [kind, proposalId, arg] = parts
  if (!UUID.test(proposalId ?? '')) return

  // The presser must be the chat this proposal was created for. A forwarded button from another
  // chat must never be able to move another account's numbers.
  const owner = await ownerChatFor(db, channelId, chatId)
  const { data: proposal } = await db.from('commerce_economics_proposals')
    .select('id, account_id, chat_id, status, expires_at, candidates, sku_id, unit_cost_tiyin, lead_time_days, safety_stock, min_margin_percent, product_query')
    .eq('id', proposalId).maybeSingle()
  if (!owner || !proposal || proposal.chat_id !== chatId || proposal.account_id !== owner.accountId) {
    await tgAnswerCallback(botToken, cb.id, 'Это подтверждение недоступно.')
    return
  }
  if (proposal.status !== 'pending') {
    await tgAnswerCallback(botToken, cb.id, 'Уже обработано.')
    return
  }
  if (new Date(proposal.expires_at) <= new Date()) {
    await db.from('commerce_economics_proposals').update({ status: 'expired' }).eq('id', proposal.id).eq('status', 'pending')
    await tgAnswerCallback(botToken, cb.id, 'Срок подтверждения истёк.')
    await tgEditMessage(botToken, chatId, messageId, '⌛ Срок подтверждения истёк. Продиктуйте цифры ещё раз.')
    return
  }

  if (kind === CB_PICK) {
    const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : []
    const chosen = candidates[Number(arg)]
    if (!chosen?.id) { await tgAnswerCallback(botToken, cb.id, 'Вариант не найден.'); return }
    await db.from('commerce_economics_proposals').update({ sku_id: chosen.id, candidates: [] }).eq('id', proposal.id).eq('status', 'pending')
    await tgAnswerCallback(botToken, cb.id)
    await tgEditMessage(botToken, chatId, messageId, `Выбрано: <b>${escapeHtml(String(chosen.title ?? ''))}</b> (${escapeHtml(String(chosen.external_sku ?? ''))})`)
    await tgSendKeyboard(botToken, chatId, proposalText(chosen, {
      product: proposal.product_query,
      unit_cost_uzs: proposal.unit_cost_tiyin == null ? null : proposal.unit_cost_tiyin / 100,
      lead_time_days: proposal.lead_time_days,
      safety_stock: proposal.safety_stock,
      min_margin_percent: proposal.min_margin_percent,
    }), applyKeyboard(proposal.id))
    return
  }

  if (arg !== 'y') {
    await db.from('commerce_economics_proposals').update({ status: 'rejected' }).eq('id', proposal.id).eq('status', 'pending')
    await tgAnswerCallback(botToken, cb.id, 'Отменено.')
    await tgEditMessage(botToken, chatId, messageId, '✖️ Не сохранено. Цифры остались прежними.')
    return
  }

  const { data: result, error } = await db.rpc('apply_commerce_economics_proposal', { p_proposal_id: proposal.id })
  if (error) {
    // Leave the keyboard in place: the proposal is still pending, so a retry must not require the
    // owner to dictate everything again. Editing the message away used to strip the buttons.
    console.error('commerce proposal apply failed:', error)
    await tgAnswerCallback(botToken, cb.id, 'Не удалось сохранить, попробуйте ещё раз.')
    return
  }
  const applied = Array.isArray(result?.applied_fields) ? result.applied_fields.length : 0
  await tgAnswerCallback(botToken, cb.id, 'Сохранено')
  await tgEditMessage(botToken, chatId, messageId, `✅ Сохранено (${applied} показател${applied === 1 ? 'ь' : 'я'}).\nЭти цифры теперь подтверждены вами — по ним включены критические оповещения.`)
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    const channelId = url.pathname.split('/').filter(Boolean).pop()
    if (!channelId) return new Response('no channel', { status: 400 })

    const db = createClient(SUPABASE_URL, SERVICE_ROLE)
    const { data: channel } = await db.from('channels').select('id, secret_token, agent_id, credentials').eq('id', channelId).single()
    if (!channel) return new Response('channel not found', { status: 404 })

    const secret = req.headers.get('x-telegram-bot-api-secret-token')
    if (!channel.secret_token || !timingSafeEqual(secret, channel.secret_token)) return new Response('forbidden', { status: 403 })

    const { data: agent } = channel.agent_id
      ? await db.from('agents').select('account_id').eq('id', channel.agent_id).maybeSingle()
      : { data: null }
    if (!agent?.account_id || await blocksExternalActions(db, agent.account_id)) return new Response('ok')

    const update = await req.json()

    // Button presses on a commerce economics proposal. This is the only place money moves, and it
    // moves only for the bound owner chat pressing Yes on a proposal it owns.
    if (update?.callback_query) {
      await handleCommerceCallback(db, channelId, channel.credentials?.bot_token, update.callback_query)
      return new Response('ok')
    }

    const startToken = String(update?.message?.text ?? '').match(/^\/start\s+commerce_([0-9a-f-]{36})$/i)?.[1]
    if (startToken && update?.message?.chat?.id) {
      const chatId = String(update.message.chat.id)
      const botToken = channel.credentials?.bot_token
      const { data: link } = await db.from('commerce_telegram_links').select('account_id, expires_at, used_at').eq('token', startToken).maybeSingle()
      const expired = link ? new Date(link.expires_at) <= new Date() : false
      if (link && !link.used_at && !expired) {
        // Bind notifications to THIS channel: the bot that received /start is by construction the
        // one the owner can receive messages from. Picking any other bot on the account would be
        // rejected by Telegram and the digest would silently never arrive.
        await db.from('business_profiles').upsert({ account_id: link.account_id, notify_chat_id: chatId, notify_channel_id: channelId, updated_at: new Date().toISOString() })
        await db.from('commerce_telegram_links').update({ used_at: new Date().toISOString(), channel_id: channelId }).eq('token', startToken).is('used_at', null)
        if (botToken) {
          await tgSendHtml(botToken, chatId, [
            '✅ <b>Nemo Commerce подключён</b>',
            '',
            'Что будет приходить сюда:',
            '☀️ сводка каждое утро в 09:00 по Ташкенту',
            '🔴 срочное сообщение, когда товар вот-вот закончится',
            '',
            '<b>Можно отвечать прямо сюда.</b> Напишите или наговорите голосом, например:',
            '<i>«XALTA 50*60 себестоимость 20000, доставка 12 дней»</i>',
            'Я покажу, что понял, и сохраню только после вашего подтверждения.',
            '',
            '<i>Nemo не меняет цены и не оформляет заказы на Uzum.</i>',
          ].join('\n'))
        }
        return new Response('ok')
      }
      // A dead link must say so. Staying silent here looked exactly like a broken bot.
      if (botToken) {
        await tgSendHtml(botToken, chatId, link
          ? '⚠️ <b>Ссылка уже использована или истекла</b>\nОна действует 15 минут.\n\nОткройте Nemo → Commerce и нажмите «Connect Telegram notifications», чтобы получить новую.'
          : '⚠️ <b>Ссылка не распознана</b>\n\nОткройте Nemo → Commerce и нажмите «Connect Telegram notifications», чтобы получить новую.')
      }
      return new Response('ok')
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rt = (globalThis as any).EdgeRuntime

    // Queue mode performs dedupe + enqueue atomically in the database. If enqueue
    // fails we return non-2xx so Telegram retries instead of silently losing work.
    const updateId = update?.update_id
    if (TG_QUEUE) {
      if (!update?.message) return new Response('ok')
      const { data: enqueued, error: queueError } = await db.rpc('enqueue_telegram_job', {
        p_channel_id: channelId,
        p_update_id: typeof updateId === 'number' ? updateId : null,
        p_payload: { kind: 'telegram', channel_id: channelId, update },
      })
      if (queueError) throw new Error(`telegram enqueue failed: ${queueError.message}`)
      if (enqueued !== true) return new Response('ok')

      const nudge = fetch(WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET }, body: JSON.stringify({ action: 'drain' }) }).then(() => {}).catch(() => {})
      if (rt?.waitUntil) rt.waitUntil(nudge)
      return new Response('ok')
    }

    // Legacy inline mode keeps the old short-window dedupe path.
    if (typeof updateId === 'number') {
      const GRACE_MS = 120_000
      const { data: seen } = await db.from('tg_updates').select('created_at').eq('channel_id', channelId).eq('update_id', updateId).maybeSingle()
      if (seen && Date.now() - Date.parse(seen.created_at) < GRACE_MS) return new Response('ok')
      await db.from('tg_updates').upsert({ channel_id: channelId, update_id: updateId, created_at: new Date().toISOString() }, { onConflict: 'channel_id,update_id' })
    }
    if (!update?.message) return new Response('ok')

    // Legacy: ack-then-process inline in the background.
    const run = processTelegramUpdate(db, channelId, update).catch((e: unknown) => console.error('tg bg error:', e))
    if (rt?.waitUntil) rt.waitUntil(run); else await run
    return new Response('ok')
  } catch (e) {
    console.error('telegram webhook error:', e)
    return new Response('retry', { status: 503 })
  }
})
