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
import {
  applyCategory, catalogueContext, categoryToken, CB_LISTING, CB_LISTING_CATEGORY, draftCard, draftKeyboard,
  newListingText,
} from '../_shared/commerceListingChat.ts'
import { CB_COST_BATCH, costCampaignState } from '../_shared/commerceCostCampaign.ts'
import {
  acceptedText, ownPricePrompt, parseOwnPrice, parsePriceCallback, refusalText, replyTarget,
} from '../_shared/commercePriceChat.ts'
import { entitlementFor, lockMessage } from '../_shared/entitlement.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
import { timingSafeEqual } from '../_shared/safeEqual.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'
import { handleForgeVoiceCallback } from '../_shared/telegramVoiceCallback.ts'
import { enqueueTelegramVoiceForge } from '../_shared/telegramVoiceForge.ts'

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

/**
 * One press on a batch of dictated costs. The owner said several numbers in one message and gets
 * one outcome: all of them or none, reported by count so a partial apply cannot pass as a whole.
 */
async function handleCostBatchCallback(db: any, channelId: string, botToken: string | undefined, cb: any): Promise<void> {
  const data = String(cb?.data ?? '')
  const chatId = String(cb?.message?.chat?.id ?? '')
  const messageId = Number(cb?.message?.message_id ?? 0)
  const parts = data.split(':')
  if (!botToken || !chatId || parts[0] !== CB_COST_BATCH) return
  const [, batchKey, arg] = parts
  if (!UUID.test(batchKey ?? '')) return

  const owner = await ownerChatFor(db, channelId, chatId)
  const { data: pending } = await db.from('commerce_economics_proposals')
    .select('id, account_id, chat_id, status').eq('batch_key', batchKey).limit(50)
  const rows = pending ?? []
  // The batch belongs to this chat and this account, or it belongs to nobody here.
  if (!owner || !rows.length || rows.some((row: any) => row.chat_id !== chatId || row.account_id !== owner.accountId)) {
    await tgAnswerCallback(botToken, cb.id, 'Это подтверждение недоступно.')
    return
  }
  if (!rows.some((row: any) => row.status === 'pending')) {
    await tgAnswerCallback(botToken, cb.id, 'Уже обработано.')
    return
  }

  if (arg !== 'y') {
    await db.from('commerce_economics_proposals').update({ status: 'rejected' }).eq('batch_key', batchKey).eq('status', 'pending')
    await tgAnswerCallback(botToken, cb.id, 'Отменено.')
    await tgEditMessage(botToken, chatId, messageId, '✖️ Не сохранено. Себестоимость осталась прежней.')
    return
  }

  const { data: result, error } = await db.rpc('apply_commerce_cost_batch', { p_batch_key: batchKey })
  if (error) {
    // Keyboard stays: the proposals are still pending, and a retry must not cost the owner the
    // whole dictation again.
    console.error('cost batch apply failed:', error)
    await tgAnswerCallback(botToken, cb.id, 'Не удалось сохранить, попробуйте ещё раз.')
    return
  }
  const applied = Number(result?.applied ?? 0)
  // Scoped to this owner's catalogues. Counting every SKU on the platform would put another
  // tenant's number in front of this seller.
  const { remaining } = await costCampaignState(db, owner.accountId, 0)
  await tgAnswerCallback(botToken, cb.id, `Сохранено: ${applied}`)
  await tgEditMessage(botToken, chatId, messageId, [
    `✅ <b>Сохранено: ${applied}</b>`,
    'Это ваши числа — по ним включены критические оповещения.',
    `\nОсталось без себестоимости: <b>${remaining}</b>`,
    'Напишите «что дальше», чтобы продолжить.',
  ].join('\n'))
}

/**
 * Button presses on a listing draft: approve, discard, or pick the category.
 *
 * Nothing here reaches Uzum — approving marks the text ready for the owner to paste, which is all
 * a read-only integration can honestly offer. The same ownership check as the economics handler
 * applies: a button forwarded out of this chat must not move another account's draft.
 */
/**
 * Загружает совет и проверяет, что он принадлежит владельцу этого чата.
 *
 * Кнопку можно переслать, а callback_data — подделать: единственное, что делает нажатие
 * безопасным, — это проверка владения на сервере при каждом нажатии.
 */
async function priceRecommendation(db: any, channelId: string, chatId: string, idOrPrefix: string) {
  const owner = await ownerChatFor(db, channelId, chatId)
  if (!owner) return null
  const { data: catalogs } = await db.from('commerce_catalogs').select('id').eq('account_id', owner.accountId)
  const catalogIds = (catalogs ?? []).map((row: { id: string }) => row.id)
  if (!catalogIds.length) return null
  const { data: skus } = await db.from('commerce_skus').select('id, title, external_sku').in('catalog_id', catalogIds)
  const byId = new Map((skus ?? []).map((row: any) => [row.id, row]))
  if (!byId.size) return null
  const query = db.from('commerce_recommendations')
    .select('id, kind, status, sku_id, calculation, suggested_action')
    .in('sku_id', [...byId.keys()])
    .in('kind', ['price_guard', 'deadstock'])
  // Метка в приглашении «своя цена» — первые восемь символов id: полный uuid в текст сообщения
  // не влезает по смыслу, а не по длине — его незачем показывать владельцу.
  const { data: rows } = idOrPrefix.length === 36
    ? await query.eq('id', idOrPrefix).limit(1)
    : await query.like('id', `${idOrPrefix}%`).limit(2)
  // Два совпадения по префиксу — не повод выбрать одно наугад: это чужая цена на чужом товаре.
  if (!rows?.length || rows.length > 1) return null
  return { owner, row: rows[0], sku: byId.get(rows[0].sku_id) as any }
}

async function handlePriceCallback(db: any, channelId: string, botToken: string | undefined, cb: any): Promise<void> {
  const parsed = parsePriceCallback(cb?.data)
  const chatId = String(cb?.message?.chat?.id ?? '')
  const messageId = Number(cb?.message?.message_id ?? 0)
  if (!botToken || !chatId || !parsed) return

  const found = await priceRecommendation(db, channelId, chatId, parsed.id)
  if (!found) { await tgAnswerCallback(botToken, cb.id, 'Этот совет недоступен.'); return }
  // Кнопка живёт в чате дольше подписки. Проверка стоит на НАЖАТИИ, а не на отправке: иначе
  // вчерашняя кнопка применяла бы решение аккаунта, который уже не платит.
  const access = await entitlementFor(db, found.owner.accountId)
  if (!access.allowed) { await tgAnswerCallback(botToken, cb.id, 'Подписка истекла'); await tgSendHtml(botToken, chatId, lockMessage(access)); return }
  const { row, sku } = found
  const title = String(sku?.title ?? sku?.external_sku ?? 'товар')
  const floor = Number(row.calculation?.min_selling_price_tiyin ?? 0) || null

  if (parsed.action === 'n') {
    await db.from('commerce_recommendations').update({ status: 'dismissed', updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', 'open')
    await tgAnswerCallback(botToken, cb.id, 'Отклонено.')
    await tgEditMessage(botToken, chatId, messageId, `❌ Совет по цене отклонён — ${escapeHtml(title)}`)
    return
  }

  if (parsed.action === 'c') {
    await tgAnswerCallback(botToken, cb.id, 'Пришлите число')
    // force_reply, потому что ответ обязан нести исходное сообщение: метка в нём — единственное,
    // что связывает набранное число с товаром. Состояние держать негде, вебхук без памяти.
    await tgSendKeyboard(botToken, chatId, ownPricePrompt(row.id, escapeHtml(title), floor ?? 0), { force_reply: true })
    return
  }

  const result = await db.rpc('commerce_accept_price', {
    p_account_id: found.owner.accountId,
    p_recommendation_id: row.id,
    p_price_tiyin: parsed.priceTiyin,
  })
  const payload = result?.data ?? {}
  if (!payload.ok) {
    await tgAnswerCallback(botToken, cb.id, 'Не принято')
    await tgSendHtml(botToken, chatId, refusalText(String(payload.reason ?? ''), Number(payload.floor_tiyin) || floor))
    return
  }
  await tgAnswerCallback(botToken, cb.id, 'Принято')
  await tgEditMessage(botToken, chatId, messageId, acceptedText(escapeHtml(title), Number(payload.price_tiyin), payload.horizon_at ?? null))
}

/** Ответ числом на приглашение «своя цена». Возвращает true, если сообщение было для нас. */
async function handleOwnPriceReply(db: any, channelId: string, botToken: string | undefined, message: any): Promise<boolean> {
  const target = replyTarget(message?.reply_to_message?.text)
  const chatId = String(message?.chat?.id ?? '')
  if (!botToken || !chatId || !target) return false

  const found = await priceRecommendation(db, channelId, chatId, target)
  if (!found) return false
  const access = await entitlementFor(db, found.owner.accountId)
  if (!access.allowed) { await tgSendHtml(botToken, chatId, lockMessage(access)); return true }
  const price = parseOwnPrice(message?.text)
  const title = String(found.sku?.title ?? found.sku?.external_sku ?? 'товар')
  if (price == null) {
    await tgSendHtml(botToken, chatId, refusalText('invalid_price', null))
    return true
  }

  // Пол проверяется в базе, а не здесь: число пришло из чата, и единственное место, где проверку
  // нельзя обойти, — RPC. Здесь только показывается его ответ.
  const result = await db.rpc('commerce_accept_price', {
    p_account_id: found.owner.accountId,
    p_recommendation_id: found.row.id,
    p_price_tiyin: price,
  })
  const payload = result?.data ?? {}
  if (!payload.ok) {
    await tgSendHtml(botToken, chatId, refusalText(String(payload.reason ?? ''), Number(payload.floor_tiyin) || null))
    return true
  }
  await tgSendHtml(botToken, chatId, acceptedText(escapeHtml(title), Number(payload.price_tiyin), payload.horizon_at ?? null))
  return true
}

async function handleListingCallback(db: any, channelId: string, botToken: string | undefined, cb: any): Promise<void> {
  const data = String(cb?.data ?? '')
  const chatId = String(cb?.message?.chat?.id ?? '')
  const messageId = Number(cb?.message?.message_id ?? 0)
  const separator = data.indexOf(':')
  const kind = data.slice(0, separator)
  if (!botToken || !chatId || (kind !== CB_LISTING && kind !== CB_LISTING_CATEGORY)) return
  const rest = data.slice(separator + 1)
  const draftId = rest.slice(0, 36)
  const arg = rest.slice(37)
  if (!UUID.test(draftId)) return

  const owner = await ownerChatFor(db, channelId, chatId)
  const { data: draft } = await db.from('commerce_listing_drafts').select('*').eq('id', draftId).maybeSingle()
  if (!owner || !draft || draft.account_id !== owner.accountId) {
    await tgAnswerCallback(botToken, cb.id, 'Этот черновик недоступен.')
    return
  }
  if (draft.status !== 'draft') {
    await tgAnswerCallback(botToken, cb.id, 'Уже обработано.')
    return
  }

  if (kind === CB_LISTING_CATEGORY) {
    const { options } = await catalogueContext(db, owner.accountId)
    // Resolved against the categories the seller actually sells in, so a stale or tampered button
    // cannot introduce a commission that exists nowhere in their catalogue.
    const matches = options.filter((option) => categoryToken(option.category) === arg)
    // Two names hashing alike is vanishingly unlikely at a dozen categories, but picking one at
    // random would silently set the wrong commission. Ask instead.
    if (matches.length !== 1) {
      await tgAnswerCallback(botToken, cb.id, matches.length ? 'Уточните категорию в интерфейсе.' : 'Категория не найдена.')
      return
    }
    const chosen = matches[0]
    const updated = await applyCategory(db, draft, chosen)
    if (!updated) { await tgAnswerCallback(botToken, cb.id, 'Не удалось обновить черновик.'); return }
    await tgAnswerCallback(botToken, cb.id, chosen.category)
    await tgEditMessage(botToken, chatId, messageId, draftCard(updated))
    await tgSendKeyboard(botToken, chatId, `Категория: <b>${escapeHtml(chosen.category)}</b> — комиссия ${chosen.commission_percent}%`, draftKeyboard(updated, options))
    return
  }

  if (arg !== 'y') {
    await db.from('commerce_listing_drafts').update({ status: 'discarded', updated_at: new Date().toISOString() }).eq('id', draft.id).eq('status', 'draft')
    await tgAnswerCallback(botToken, cb.id, 'Убрано.')
    await tgEditMessage(botToken, chatId, messageId, '✖️ Черновик убран.')
    return
  }

  // Approval is refused while anything is missing, exactly as in the interface: a listing with no
  // floor price is how a product gets sold below cost.
  const missing = Array.isArray(draft.missing) ? draft.missing : []
  if (missing.length) {
    await tgAnswerCallback(botToken, cb.id, 'Сначала пришлите недостающее.')
    return
  }
  const { error } = await db.from('commerce_listing_drafts')
    .update({ status: 'ready', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', draft.id).eq('status', 'draft')
  if (error) {
    console.error('listing draft approve failed:', error)
    await tgAnswerCallback(botToken, cb.id, 'Не удалось сохранить, попробуйте ещё раз.')
    return
  }
  await tgAnswerCallback(botToken, cb.id, 'Одобрено')
  await tgEditMessage(botToken, chatId, messageId, `${draftCard(draft)}\n\n✅ <b>Одобрено.</b> Текст готов — перенесите его в кабинет Uzum. Nemo туда ничего не пишет.`)
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

    // ПЕРВОЕ действие после проверки подписи — до дедупа, до кнопок, до очереди.
    //
    // Три дня подряд фотография «не доходила», и отличить «Telegram не доставил» от «мы отбросили
    // раньше нужной ветки» было нечем: tg_updates пишется только в очередной ветке, а логи
    // аналитики отстают на минуты и однажды уже заставили меня пять раз подряд сказать владельцу
    // неправду. Теперь у пустоты здесь одно толкование: запроса не было.
    //
    // Содержимое не пишется, только форма: переписка владельца с ботом — его дело.
    const logged = update?.message ?? update?.callback_query?.message
    await db.from('tg_inbound_log').insert({
      channel_id: channelId,
      update_id: typeof update?.update_id === 'number' ? update.update_id : null,
      kind: update?.callback_query ? 'callback_query' : update?.message ? 'message' : 'other',
      has_photo: Array.isArray(update?.message?.photo) && update.message.photo.length > 0,
      has_document: Boolean(update?.message?.document?.file_id),
      has_voice: Boolean(update?.message?.voice?.file_id),
      has_text: Boolean(update?.message?.text),
      has_caption: Boolean(update?.message?.caption),
      // Признак, а не текст: сработал ли триггер «новый товар» на подписи. Содержимое переписки
      // владельца с ботом — его дело, а для диагноза довольно знать, узнала ли его система.
      has_listing_trigger: newListingText(String(update?.message?.text ?? update?.message?.caption ?? '')) !== null,
      chat_id: logged?.chat?.id != null ? String(logged.chat.id) : null,
    }).then(() => {}, (error: unknown) => {
      // Диагностика не имеет права ронять доставку: сломанная запись в журнал — это потерянный
      // журнал, а не потерянное сообщение владельца.
      console.error('tg inbound log failed:', error)
    })


    // Button presses on a commerce economics proposal. This is the only place money moves, and it
    // moves only for the bound owner chat pressing Yes on a proposal it owns.
    if (update?.callback_query) {
      // Two handlers, one press. Each ignores callback data that is not its own prefix, so the
      // order is irrelevant and a new button type cannot silently shadow an existing one.
      await handleCommerceCallback(db, channelId, channel.credentials?.bot_token, update.callback_query)
      await handleListingCallback(db, channelId, channel.credentials?.bot_token, update.callback_query)
      await handleCostBatchCallback(db, channelId, channel.credentials?.bot_token, update.callback_query)
      await handlePriceCallback(db, channelId, channel.credentials?.bot_token, update.callback_query)
      await handleForgeVoiceCallback(db, channelId, channel.credentials?.bot_token, update.callback_query, {
        findOwner: ownerChatFor,
        answer: tgAnswerCallback,
        edit: tgEditMessage,
        enqueue: enqueueTelegramVoiceForge,
      })
      return new Response('ok')
    }

    // Ответ числом на приглашение «своя цена». Стоит ДО остальных обработчиков сообщений: иначе
    // «58750» уедет агенту как реплика в разговоре, и владелец не получит ни цены, ни отказа.
    if (update?.message?.reply_to_message) {
      const handled = await handleOwnPriceReply(db, channelId, channel.credentials?.bot_token, update.message)
      if (handled) return new Response('ok')
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
