// Group "task-bot". Lives in a Telegram group. When @mentioned it understands a
// natural-language assignment ("@bot @Aziz подготовь отчёт до пятницы"), records the
// people it sees (the "special list of user ids"), creates a task row tied to the
// assignee's Telegram identity, and can list open tasks. Reminders are sent by a
// separate scheduled function that reads tasks.due_at.
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from './llm.ts'
import { tgSend } from './telegram.ts'
import { runGroupDiscussion } from './groupchat.ts'
import { googleAccessToken, sheetsAppend } from './google.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractJson(text: string): Record<string, any> | null {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}

function fullName(u: any): string {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || 'User'
}

// Remember everyone the bot sees in the group -> resolve @mentions to real users later.
async function rememberMember(db: any, accountId: string, channelId: string, chatId: string, u: any) {
  if (!u?.id) return
  await db.from('telegram_members').upsert({
    account_id: accountId, channel_id: channelId, chat_id: chatId,
    tg_user_id: String(u.id), username: u.username ?? null, display_name: fullName(u),
  }, { onConflict: 'channel_id,chat_id,tg_user_id' })
}

/**
 * Handle one group message for a task-bot channel. Returns true if it acted (so the
 * caller can stop). `apiKey` is the resolved OpenRouter key; `botUsername` is the bot's @handle.
 */
export async function handleTaskBot(
  db: any, apiKey: string, channel: any, accountId: string, botToken: string, botUsername: string, msg: any,
): Promise<boolean> {
  const chatId = String(msg.chat.id)
  const text = String(msg.text ?? '')
  // learn the sender + anyone mentioned by text_mention
  await rememberMember(db, accountId, channel.id, chatId, msg.from)
  const entities: any[] = msg.entities ?? []
  for (const en of entities) if (en.type === 'text_mention' && en.user) await rememberMember(db, accountId, channel.id, chatId, en.user)

  // only act when the bot is addressed: @mention, /command, or a reply to the bot
  const addressed =
    (botUsername && text.toLowerCase().includes('@' + botUsername.toLowerCase())) ||
    text.startsWith('/') ||
    (msg.reply_to_message?.from?.username && botUsername && msg.reply_to_message.from.username.toLowerCase() === botUsername.toLowerCase())
  if (!addressed) return false

  // pull @username mentions present in the text (assignee candidates)
  const mentioned: string[] = entities
    .filter((en) => en.type === 'mention')
    .map((en) => text.substring(en.offset + 1, en.offset + en.length))
    .filter((h) => h.toLowerCase() !== (botUsername || '').toLowerCase())

  const now = new Date().toISOString()
  const route = await callOpenRouter({
    apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0, maxTokens: 250,
    messages: [
      { role: 'system', content:
        'You are the coordinator of a team group chat. Current time (ISO): ' + now + '. ' +
        'From the message decide the intent. Respond ONLY as JSON: ' +
        '{"intent":"create"|"list"|"complete"|"discuss"|"none","assignee_username":string|null,"assignee_name":string|null,"title":string|null,"due_iso":string|null,"topic":string|null}. ' +
        'intent="create": assign ONE task to a specific person. intent="list": show open tasks. intent="complete": close a task. ' +
        'intent="discuss": the group asks the TEAM to collaboratively work something out / brainstorm / prepare a plan or content (not a single-person assignment); set "topic" to what they should work on. ' +
        'due_iso = absolute ISO datetime derived from any deadline mentioned (relative to current time), else null. Keep title/topic short and in the message language.' },
      { role: 'user', content: text },
    ],
  })
  const j = extractJson(route.content) ?? {}
  const intent = String(j.intent ?? 'none')

  if (intent === 'discuss') {
    // strip the @mention of the coordinator bot so the topic reads cleanly
    const cleaned = botUsername ? text.replace(new RegExp('@' + botUsername, 'ig'), '').trim() : text.trim()
    const topic = (typeof j.topic === 'string' && j.topic.trim()) ? j.topic.trim() : (cleaned || text)
    await runGroupDiscussion(db, apiKey, channel, accountId, botToken, msg, topic)
    return true
  }

  if (intent === 'list') {
    const { data: tasks } = await db.from('tasks')
      .select('title, assignee_name, assignee_tg, due_at, status')
      .eq('telegram_chat_id', chatId).neq('status', 'done')
      .order('due_at', { ascending: true }).limit(20)
    if (!tasks?.length) { await tgSend(botToken, chatId, 'Открытых задач нет. ✅'); return true }
    const lines = tasks.map((t: any, i: number) => {
      const who = t.assignee_tg ? (t.assignee_tg.startsWith('@') ? t.assignee_tg : '@' + t.assignee_tg) : (t.assignee_name ?? '—')
      const due = t.due_at ? ` — до ${new Date(t.due_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''
      return `${i + 1}. ${t.title} · ${who}${due}`
    })
    await tgSend(botToken, chatId, '📋 Открытые задачи:\n' + lines.join('\n'))
    return true
  }

  if (intent === 'complete') {
    const uname = (j.assignee_username || mentioned[0] || '').replace(/^@/, '')
    let q = db.from('tasks').select('id, title').eq('telegram_chat_id', chatId).neq('status', 'done').order('created_at', { ascending: false }).limit(1)
    if (uname) q = q.eq('assignee_tg', '@' + uname)
    const { data: t } = await q
    if (t?.[0]) { await db.from('tasks').update({ status: 'done' }).eq('id', t[0].id); await tgSend(botToken, chatId, `✅ Задача закрыта: ${t[0].title}`); return true }
    await tgSend(botToken, chatId, 'Не нашёл подходящую задачу для закрытия.'); return true
  }

  if (intent === 'create' && j.title) {
    // resolve assignee: prefer an @username from the message, else the extracted name
    const uname = (j.assignee_username || mentioned[0] || '').replace(/^@/, '')
    let assigneeName = j.assignee_name ?? null
    if (uname) {
      const { data: m } = await db.from('telegram_members').select('display_name').eq('channel_id', channel.id).eq('chat_id', chatId).eq('username', uname).maybeSingle()
      if (m?.display_name) assigneeName = m.display_name
    }
    const dueAt = j.due_iso && !isNaN(Date.parse(j.due_iso)) ? new Date(j.due_iso).toISOString() : null
    await db.from('tasks').insert({
      account_id: accountId, channel_id: channel.id, telegram_chat_id: chatId,
      title: String(j.title).slice(0, 300), assignee_tg: uname ? '@' + uname : null, assignee_name: assigneeName,
      created_by: fullName(msg.from), source: 'telegram', status: 'todo',
      due_at: dueAt, deadline: dueAt ? dueAt.slice(0, 10) : null,
    })
    const who = uname ? '@' + uname : (assigneeName ?? 'команда')
    const due = dueAt ? ` до ${new Date(dueAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''
    // log to the account's Google Sheet (task / meeting log), if configured + Google connected
    let sheetOk = false
    try {
      const { data: bp } = await db.from('business_profiles').select('tasks_sheet_id').eq('account_id', accountId).maybeSingle()
      if (bp?.tasks_sheet_id) {
        const g = await googleAccessToken(db, accountId)
        if (g.token) {
          const stamp = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
          const dueStr = dueAt ? new Date(dueAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : ''
          sheetOk = await sheetsAppend(g.token, bp.tasks_sheet_id, [stamp, String(j.title), who, dueStr, fullName(msg.from), text.slice(0, 500)])
        }
      }
    } catch { /* sheet logging is best-effort */ }
    await tgSend(botToken, chatId, `✅ Задача записана для ${who}: «${String(j.title)}»${due}. Напомню ближе к сроку.${sheetOk ? ' 📊 В Google-таблице.' : ''}`)
    return true
  }

  return false
}
/* eslint-enable @typescript-eslint/no-explicit-any */
