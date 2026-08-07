// Shared Telegram update processing — called BOTH by the webhook (legacy waitUntil path) and by
// the queue worker (durable pgmq path). Given a channel id + the raw Telegram update, it runs the
// full flow: voice transcription, group task-bot, DM task-completion, customer dialogue + reply.
// Extracted so the webhook can just enqueue and a rate-capped worker does the heavy LLM work.
import { buildReply, buildSubAgentReply, type ReplyDiagnostics } from './agent.ts'
import { PRIMARY_MODEL } from './llm.ts'
import { tgSend, tgSendHtml, tgSendKeyboard } from './telegram.ts'
import { escapeHtml } from './telegramFormat.ts'
import { handleTaskBot, handleTeamCompletionDM } from './taskbot.ts'
import {
  accountSkus, applyKeyboard, looksLikeEconomics, matchSkus, ownerChatFor,
  parseEconomicsMessage, pickKeyboard, proposalRow, proposalText, type OwnerChat,
} from './commerceEconomicsChat.ts'
import {
  buildListingDraft, draftCard, draftKeyboard, NEW_LISTING_HELP, newListingText,
} from './commerceListingChat.ts'
import {
  asksWhatNext, batchCard, batchKeyboard, costCampaignState, latestPricesUzs, looksLikeCostBatch, matchBatch,
  nextCard, parseCostBatch,
} from './commerceCostCampaign.ts'
import { resolveOpenRouterKey } from './keys.ts'
import { planOf } from './plans.ts'
import { transcribeAudio } from './transcribe.ts'
import { isRegulatedAgent } from './riskPolicy.ts'

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const MAX_MSG = 4000

// Friendly note when a voice message can't be turned into text (too big, or transcription failed).
// Telegram lets a BOT download files only up to 20 MB — that's the hard ceiling for voice size.
const VOICE_MSG = {
  uz: { long: '🎙 Ovozli xabar juda katta — Telegram bot faqat 20 MB gacha faylni yuklab oladi. Iltimos, qisqaroq ovozli yoki matn yuboring.', fail: '🎙 Ovozli xabarni oʻqiy olmadim. Iltimos, matn koʻrinishida yoki qisqaroq ovozli yuboring.' },
  ru: { long: '🎙 Голосовое слишком большое — Telegram отдаёт боту файлы только до 20 МБ. Отправьте голосовое покороче или текстом.', fail: '🎙 Не смог распознать голосовое. Отправьте текстом или более коротким голосовым.' },
  en: { long: '🎙 The voice message is too large — Telegram only lets a bot download files up to 20 MB. Please send a shorter voice note or text.', fail: '🎙 I couldn’t transcribe that voice message. Please send text or a shorter voice note.' },
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// Reply as a specific sub-agent (its own bot), then persist the message + usage.
async function subAgentReply(db: any, agent: any, subId: string, dialogueId: string): Promise<string> {
  const { data: sub } = await db.from('sub_agents').select('*').eq('id', subId).maybeSingle()
  if (!sub || (sub.status && sub.status !== 'active')) return ''
  const { data: acc } = await db.from('accounts').select('token_balance, plan').eq('id', agent.account_id).single()
  if (acc && Number(acc.token_balance) <= 0) return ''
  const { data: history } = await db.from('messages').select('author, content').eq('dialogue_id', dialogueId).eq('message_type', 'chat').order('created_at', { ascending: false }).limit(20)
  const chronological = (history ?? []).slice().reverse()
  const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
  // the sub-agent's saved model runs through the same plan gate as every other path
  const { text, tokens } = await buildSubAgentReply(db, apiKey, sub, chronological, planOf(acc?.plan).premium)
  if (text) {
    await db.from('messages').insert({ dialogue_id: dialogueId, author: 'agent', content: text })
    await db.from('usage').insert({ account_id: agent.account_id, tokens, model: null, stage: 'subagent' })
    if (tokens) await db.rpc('decrement_token_balance', { p_account: agent.account_id, p_amount: tokens })
  }
  return text
}

async function downloadTelegramFile(token: string, fileId: string): Promise<string> {
  try {
    const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`).then((r) => r.json())
    const path = gf?.result?.file_path
    if (!path) return ''
    const buf = await fetch(`https://api.telegram.org/file/bot${token}/${path}`).then((r) => r.arrayBuffer())
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  } catch { return '' }
}

function decodeTextAttachment(base64: string): string {
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8').decode(bytes).split(String.fromCharCode(0)).join('').trim()
  } catch { return '' }
}

// Full processing of ONE Telegram update for a channel. Safe to run in the background / a worker.
const COMMERCE_HELP = [
  '👋 <b>Здравствуйте! Это Nemo.</b>',
  '',
  'Если у вас магазин на Uzum Market, я слежу за остатками и маржой и пишу, когда пора закупать.',
  '',
  '<b>Как подключить:</b>',
  'Откройте Nemo → Commerce и нажмите «Connect Telegram notifications».',
  '',
  '<b>Что можно писать сюда:</b>',
  'Себестоимость и срок поставки — текстом или голосом. Например:',
  '<i>«XALTA 50*60 себестоимость 20000, доставка 12 дней»</i>',
  'Я покажу, что понял, и сохраню только после вашего подтверждения.',
  '',
  '<i>Nemo не меняет цены и не оформляет заказы на Uzum.</i>',
].join('\n')

// Returns true when the message was handled as a commerce economics proposal. Never writes to
// commerce_skus — it only stores a pending proposal and asks the owner to confirm it.
async function handleEconomicsMessage(
  db: any,
  apiKey: string,
  agent: any,
  botToken: string,
  owner: OwnerChat,
  text: string,
): Promise<boolean> {
  // Deliberately NOT agent.model: an agent may be configured with a free-tier chat model that
  // ignores response_format. Extraction is a structured task where reliability beats persona, and
  // a silent parse failure here looks to the owner like the feature simply does not work.
  const parsed = await parseEconomicsMessage(apiKey, PRIMARY_MODEL, text)
  if (!parsed) return false

  const skus = await accountSkus(db, owner.accountId)
  if (!skus.length) {
    await tgSendHtml(botToken, owner.chatId, 'Каталог ещё не синхронизирован с Uzum, поэтому себестоимость пока не к чему привязать.\n\nОткройте Commerce и дождитесь первой синхронизации.')
    return true
  }
  const candidates = matchSkus(parsed.product, skus)
  if (!candidates.length) {
    await tgSendHtml(botToken, owner.chatId, [
      `🔎 Не нашёл в каталоге: «${escapeHtml(parsed.product)}»`,
      '',
      'Пришлите точное название из Uzum или артикул — я не подставляю похожие товары, чтобы не записать цифры не туда.',
      '',
      `Например: <code>${escapeHtml(skus[0].external_sku)}</code> — ${escapeHtml(skus[0].title)}`,
    ].join('\n'))
    return true
  }

  const single = candidates.length === 1 ? candidates[0] : null
  const { data: proposal, error } = await db.from('commerce_economics_proposals')
    .insert(proposalRow(owner, parsed, text, single ? [] : candidates.slice(0, 5), single?.id ?? null))
    .select('id').single()
  if (error || !proposal) {
    await tgSendHtml(botToken, owner.chatId, 'Не смог подготовить подтверждение. Попробуйте ещё раз или внесите цифры в таблице Commerce.')
    return true
  }

  if (single) {
    await tgSendKeyboard(botToken, owner.chatId, proposalText(single, parsed), applyKeyboard(proposal.id))
  } else {
    await tgSendKeyboard(botToken, owner.chatId, `Нашёл несколько товаров по запросу «${escapeHtml(parsed.product)}». Какой имели в виду?`, pickKeyboard(proposal.id, candidates))
  }
  return true
}

/**
 * A batch of dictated costs. Returns true when it was handled — including when nothing could be
 * matched, because saying "I matched none of these" is handling it, and falling through to the
 * single-item parser would take the first cost and lose the rest without saying so.
 */
async function handleCostBatch(db: any, agent: any, botToken: string, owner: OwnerChat, text: string): Promise<boolean> {
  const parsed = parseCostBatch(text)
  const skus = await accountSkus(db, owner.accountId)
  if (!skus.length) {
    await tgSendHtml(botToken, owner.chatId, 'Каталог ещё не синхронизирован с Uzum, поэтому себестоимость пока не к чему привязать.')
    return true
  }
  // Prices for the plausibility check: a cost at or above what the SKU sells for is not a cost.
  const prices = await latestPricesUzs(db, skus.map((sku: any) => sku.id))
  const matched = matchBatch(parsed.items, skus, matchSkus, prices)
  const savable = matched.filter((row) => row.kind === 'matched')
  const state = await costCampaignState(db, owner.accountId, 0)

  // One key for the whole message: the owner pressed one button and expects one outcome.
  const batchKey = crypto.randomUUID()
  if (savable.length) {
    const rows = savable.map((row: any) => ({
      account_id: owner.accountId,
      channel_id: owner.channelId,
      chat_id: owner.chatId,
      sku_id: row.sku.id,
      candidates: [],
      product_query: row.item.query.slice(0, 200),
      source_text: text.slice(0, 2000),
      unit_cost_tiyin: Math.round(row.item.costUzs * 100),
      batch_key: batchKey,
    }))
    const { error } = await db.from('commerce_economics_proposals').insert(rows)
    if (error) {
      console.error('cost batch proposals insert failed:', error)
      await tgSendHtml(botToken, owner.chatId, 'Не смог подготовить подтверждение. Попробуйте ещё раз.')
      return true
    }
  }
  await tgSendKeyboard(
    botToken,
    owner.chatId,
    batchCard(matched, parsed.unparsed, state.remaining),
    batchKeyboard(batchKey, savable.length) ?? { inline_keyboard: [] },
  )
  return true
}

export async function processTelegramUpdate(db: any, channelId: string, update: any): Promise<void> {
  const { data: channel } = await db.from('channels').select('*, agents(*)').eq('id', channelId).single()
  if (!channel) return
  const msg = update?.message
  if (!msg) return
  const isGroupChat = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup'

  const chatId = String(msg.chat.id)
  const customerName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Telegram'
  const botToken = channel.credentials?.bot_token
  const botUsername = channel.credentials?.username ?? ''
  const agent = channel.agents
  if (isRegulatedAgent(agent)) {
    await db.from('channels').update({ status: 'safety_blocked' }).eq('id', channelId)
    return
  }

  let text = msg.text ? String(msg.text).slice(0, MAX_MSG) : (msg.caption ? String(msg.caption).slice(0, MAX_MSG) : '')

  // A chat id is not a password, but it is the stable Telegram identity used to bind a private
  // owner chat to the account. Expose it through the bot so owners do not need a third-party bot
  // and do not mistype it. This command performs no LLM call and reveals only the caller's id.
  if (!isGroupChat && /^\/myid(?:@\w+)?$/i.test(text.trim())) {
    if (botToken) await tgSend(botToken, chatId, `Ваш Telegram chat_id: ${chatId}\nВставьте его в Nemo → «Мой бизнес» → «Telegram chat_id владельца» и сохраните профиль.`)
    return
  }
  const voice = msg.voice ?? msg.audio
  let voiceProblem: 'long' | 'fail' | null = null
  if (!text && voice?.file_id && botToken && OPENROUTER_API_KEY && agent?.account_id) {
    // Telegram bots can only download files up to 20 MB — that's the real ceiling. Duration up to
    // ~3h is fine as long as the file fits under it (low-bitrate voice notes usually do).
    const tooBig = (voice.duration && voice.duration > 3 * 3600) || (voice.file_size && voice.file_size > 19 * 1024 * 1024)
    if (tooBig) {
      voiceProblem = 'long'
    } else {
      try {
        const orKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
        const b64 = await downloadTelegramFile(botToken, voice.file_id)
        if (b64) {
          text = String(await transcribeAudio(
            orKey,
            b64,
            'ogg',
            agent?.default_lang ?? 'auto',
            agent?.stt_model ?? 'auto',
          )).slice(0, MAX_MSG)
        }
      } catch { /* voice transcription is best-effort */ }
      if (!text) voiceProblem = 'fail'
    }
    if (text) msg.text = text
  }
  // A voice we couldn't turn into text -> tell the user instead of staying silent. DMs only, so we
  // don't add noise to groups (the group task-bot only acts on @mentions anyway).
  if (voice && !text && voiceProblem && botToken && !isGroupChat) {
    const vlang: 'uz' | 'ru' | 'en' = agent?.default_lang === 'ru' ? 'ru' : agent?.default_lang === 'en' ? 'en' : 'uz'
    await tgSend(botToken, chatId, VOICE_MSG[vlang][voiceProblem])
    return
  }

  // Uzum's published seller API does not expose reviews/comments. Let the owner supply a small
  // CSV/TXT export (or paste its contents) so the agent can analyse the real text instead of
  // inventing customer feedback. Binary office files are deliberately not guessed as text.
  const document = msg.document
  if (document?.file_id && botToken && !isGroupChat) {
    const fileName = String(document.file_name ?? 'export').slice(0, 160)
    const textFile = /\.(csv|tsv|txt)$/i.test(fileName) || /^text\/(csv|plain|tab-separated-values)$/i.test(String(document.mime_type ?? ''))
    const tooLarge = Number(document.file_size ?? 0) > 2 * 1024 * 1024
    if (textFile && !tooLarge) {
      const data = decodeTextAttachment(await downloadTelegramFile(botToken, document.file_id))
      if (data) {
        const caption = text ? `${text}\n\n` : ''
        text = `${caption}[ВЛОЖЕНИЕ ВЛАДЕЛЬЦА: ${fileName}]\n${data.slice(0, 12_000)}`
      } else if (!text) {
        await tgSend(botToken, chatId, 'Не смог прочитать текстовый файл. Пришлите экспорт отзывов в CSV/TXT или вставьте текст сообщения.')
        return
      }
    } else if (/(отзыв|комментар|review|feedback)/i.test(`${text}\n${fileName}`)) {
      await tgSend(botToken, chatId, tooLarge
        ? 'Файл с отзывами больше 2 МБ для анализа в чате. Экспортируйте CSV/TXT меньшего размера или пришлите частями.'
        : 'Сейчас для отзывов можно прислать CSV/TXT или вставить текст. XLSX и другие бинарные файлы бот не будет читать как текст, чтобы не исказить данные.')
      return
    }
  }
  const hasAttachment = (Array.isArray(msg.photo) && msg.photo.length > 0) || Boolean(msg.document?.file_id)
  if (!text && !hasAttachment) return

  // Commerce owner DM. This has to run BEFORE the group branch: a team bot carries scope='group',
  // and that branch returns for every message including private ones — which is why dictating a
  // cost to such a bot did nothing at all. Runs after transcription, so voice behaves like text.
  if (!isGroupChat && text && botToken && agent?.account_id) {
    const owner = await ownerChatFor(db, channelId, chatId)
    if (owner) {
      // A bare /start used to fall through to a silent path. The owner is our own customer, so
      // naming Nemo here is correct — unlike a customer-facing DM bot, which must keep its persona.
      if (/^\/start(?:@\w+)?$/i.test(text.trim())) {
        await tgSendHtml(botToken, chatId, COMMERCE_HELP)
        return
      }
      // BEFORE the economics branch on purpose. "новый товар, себестоимость 18000" satisfies
      // looksLikeEconomics too, and taking that path would hunt for an existing SKU to edit
      // instead of drafting the new product the owner just announced.
      const listingText = newListingText(text)
      if (listingText !== null) {
        try {
          if (!listingText) { await tgSendHtml(botToken, chatId, NEW_LISTING_HELP); return }
          const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
          const built = await buildListingDraft(db, apiKey, owner, listingText)
          if (!built) {
            await tgSendHtml(botToken, chatId, '🆕 Пока не с чем считать: подключите магазин Uzum в Nemo — комиссия берётся из категорий, в которых вы уже продаёте.')
            return
          }
          await tgSendKeyboard(botToken, chatId, draftCard(built.draft), draftKeyboard(built.draft, built.categories))
          return
        } catch (e) { console.error('commerce listing chat failed:', e) }
      }

      // The cost campaign. Both branches sit above the single-item economics path: "что дальше"
      // is a question, not a dictated number, and a batch of two or more costs is a shape the
      // single-item parser would take the first of and silently drop the rest.
      if (asksWhatNext(text)) {
        const state = await costCampaignState(db, agent.account_id)
        await tgSendHtml(botToken, chatId, nextCard(state.targets, state.remaining))
        return
      }
      if (looksLikeCostBatch(text)) {
        try {
          if (await handleCostBatch(db, agent, botToken, owner, text)) return
        } catch (e) { console.error('commerce cost batch failed:', e) }
      }

      if (OPENROUTER_API_KEY && looksLikeEconomics(text)) {
        try {
          const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
          if (await handleEconomicsMessage(db, apiKey, agent, botToken, owner, text)) return
        } catch (e) { console.error('commerce economics chat failed:', e) }
      }
    } else if (channel.scope === 'group' && /^\/start(?:@\w+)?$/i.test(text.trim())) {
      // A group-scoped bot is an internal team bot: its private chats are with staff, not with a
      // tenant's customers, so a Nemo-branded pointer is safe here and beats silence.
      await tgSendHtml(botToken, chatId, COMMERCE_HELP)
      return
    }
  }

  // GROUP task-bot
  if (channel.scope === 'group' || isGroupChat) {
    if (botToken && OPENROUTER_API_KEY && agent?.account_id && agent.status === 'active') {
      const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
      await handleTaskBot(db, apiKey, channel, agent.account_id, botToken, botUsername, msg)
    }
    return
  }

  // DM task-completion report
  if (botToken && OPENROUTER_API_KEY && agent?.account_id && agent.status === 'active' && !channel.sub_agent_id) {
    try {
      const apiKey = await resolveOpenRouterKey(db, agent.account_id, OPENROUTER_API_KEY)
      if (await handleTeamCompletionDM(db, apiKey, channel, agent.account_id, botToken, msg)) return
    } catch { /* fall through to normal reply flow */ }
  }
  if (!text) return

  let { data: dialogue } = await db.from('dialogues').select('*').eq('channel_id', channelId).eq('external_id', chatId).maybeSingle()
  if (!dialogue) {
    const ins = await db.from('dialogues').insert({
      agent_id: agent.id, channel_id: channelId, channel: 'telegram', external_id: chatId,
      customer_name: customerName, customer_contact: msg.from?.username ? '@' + msg.from.username : chatId, status: 'open',
    }).select('*').single()
    dialogue = ins.data
  }

  await db.from('messages').insert({ dialogue_id: dialogue.id, author: 'customer', content: text })
  await db.from('dialogues').update({ status: dialogue.status === 'resolved' ? 'open' : dialogue.status }).eq('id', dialogue.id)

  if (dialogue.operator_takeover) return
  if (agent.status !== 'active') return
  if (!OPENROUTER_API_KEY) {
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
    if (botToken) await tgSend(botToken, chatId, 'OpenRouter key is not configured on the server. Operator will join shortly.')
    return
  }

  // Sticky routing: keep an earlier hand-off target
  let effectiveAgent = agent
  if (!channel.sub_agent_id && dialogue.agent_id && dialogue.agent_id !== agent.id) {
    const { data: ra } = await db.from('agents').select('*').eq('id', dialogue.agent_id).eq('account_id', agent.account_id).maybeSingle()
    if (ra && (ra.status ?? 'active') === 'active') effectiveAgent = ra
  }

  const diag: ReplyDiagnostics = {}
  const reply = channel.sub_agent_id
    ? await subAgentReply(db, agent, channel.sub_agent_id, dialogue.id)
    : await buildReply(db, OPENROUTER_API_KEY, effectiveAgent, dialogue.id, diag)

  if (reply) {
    if (botToken) await tgSend(botToken, chatId, reply)
  } else {
    await db.from('dialogues').update({ status: 'needs_operator' }).eq('id', dialogue.id)
    // Persist WHY, so the failure is visible in the app's trace view and in the database — not
    // only in a Telegram line nobody can query afterwards. Every silent handoff so far left no
    // record at all, which is why diagnosing one needed database archaeology.
    await db.from('messages').insert({
      dialogue_id: dialogue.id,
      author: 'agent',
      agent_id: effectiveAgent.id ?? null,
      message_type: 'system_trace',
      content: JSON.stringify({
        version: 2,
        replyMessageId: null,
        escalated: true,
        steps: [{
          kind: 'human_review',
          agentId: effectiveAgent.id ?? null,
          agentName: String(effectiveAgent.name ?? 'agent').slice(0, 80),
          reason: `${diag.reason ?? 'no_output'}${diag.detail ? `: ${diag.detail}` : ''}`.slice(0, 300),
        }],
      }),
    })
    // A customer gets the graceful handoff. The OWNER gets the actual cause: eight different
    // conditions used to produce this one sentence, so a paused agent, an empty balance and a
    // crash were indistinguishable from a real decision to involve a human.
    if (botToken) await tgSend(botToken, chatId, diag.ownerContext ? ownerReason(diag) : WAIT_LINE)
  }
}

const WAIT_LINE = 'Bir lahza, operator ulanadi. / Секунду, оператор скоро подключится.'

const OWNER_REASON: Record<string, string> = {
  agent_paused: 'Агент на паузе — включите его на странице «Агенты».',
  outside_work_hours: 'Сейчас вне рабочих часов агента. Поставьте расписание 24/7 или измените часы.',
  rate_limited: 'Слишком много сообщений подряд — сработала защита от флуда. Повторите через минуту.',
  no_tokens: 'Закончились токены аккаунта. Пополните лимит на странице «Тарифы и лимиты».',
  session_cap: 'Достигнут лимит токенов на этот диалог. Начните новый диалог.',
  escalated: 'Команда не сошлась во мнениях и передала вопрос человеку — это осознанное решение, а не сбой.',
  error: 'Внутренняя ошибка при подготовке ответа.',
  no_output: 'Агент не выдал ответ.',
}

function ownerReason(diag: ReplyDiagnostics): string {
  const base = OWNER_REASON[diag.reason ?? 'no_output'] ?? OWNER_REASON.no_output
  return `⚠️ Ответа нет. Причина: ${base}${diag.detail ? `\nДетали: ${diag.detail}` : ''}`
}
/* eslint-enable @typescript-eslint/no-explicit-any */
