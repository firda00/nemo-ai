// Visible TEAM discussion in a Telegram group.
// When the group's coordinator bot is asked to have the team WORK SOMETHING OUT
// ("команда, обсудите…", "подготовьте план…") rather than assign one task, the lead
// plans who should speak, then each relevant sub-agent posts its OWN contribution into
// the group — from its own bot when it has one — so the humans SEE the agents
// collaborate and build on each other, and the lead posts the final decision.
// One lead controls the whole discussion. Account-scoped (service-role caller).
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from './llm.ts'
import { tgSend } from './telegram.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractJson(text: string): Record<string, any> | null {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}

const MAX_SPEAKERS = 4

/**
 * Run one visible team discussion. `coordToken` is the coordinator (lead) bot's token,
 * `topic` is what the team was asked to work on. Returns true (it always answers).
 */
export async function runGroupDiscussion(
  db: any, apiKey: string, channel: any, accountId: string, coordToken: string, msg: any, topic: string,
): Promise<boolean> {
  const chatId = String(msg.chat.id)
  const agent = channel.agents
  if (!agent) return false

  // cost guard — don't run a whole team on an empty balance
  const { data: acc } = await db.from('accounts').select('token_balance').eq('id', accountId).single()
  if (acc && Number(acc.token_balance) <= 0) {
    await tgSend(coordToken, chatId, '⚠️ Закончился баланс токенов — пополните, чтобы команда продолжила работать.')
    return true
  }

  // load the lead's saved team (department + specialist sub-agents)
  const { data: depts } = await db.from('departments').select('id').eq('main_agent_id', agent.id).order('created_at', { ascending: false }).limit(1)
  const dept = depts?.[0]
  if (!dept) { await tgSend(coordToken, chatId, 'У этого агента ещё нет команды. Создайте команду на сайте, затем позовите её сюда.'); return true }
  const { data: subsRaw } = await db.from('sub_agents').select('id, name, role, prompt, model, status').eq('department_id', dept.id).limit(8)
  const subs = (subsRaw ?? []).filter((s: any) => (s.status ?? 'active') !== 'paused')
  if (!subs.length) { await tgSend(coordToken, chatId, 'В команде пока нет специалистов.'); return true }

  // each sub-agent's OWN bot token (so it can post as itself), if it has one connected
  const { data: subChannels } = await db.from('channels').select('sub_agent_id, credentials').eq('agent_id', agent.id).eq('type', 'telegram').not('sub_agent_id', 'is', null)
  const tokenBySub = new Map<string, string>()
  for (const c of subChannels ?? []) { const t = c.credentials?.bot_token; if (c.sub_agent_id && t) tokenBySub.set(c.sub_agent_id, t) }

  const roster = subs.map((s: any) => `- ${s.name} (${s.role})`).join('\n')

  // 1) LEAD plans who speaks and on what angle
  const plan = await callOpenRouter({
    apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.3, maxTokens: 400,
    messages: [
      { role: 'system', content:
        `You are the team lead. Your team:\n${roster}\n\n` +
        `The group asked the team to work on a task. Pick 2-${MAX_SPEAKERS} of YOUR specialists most relevant to it, ` +
        'and for each give a one-line angle they should cover. Respond ONLY as JSON ' +
        '{"speakers":[{"name":string,"focus":string}]}. Use the exact specialist names from the roster.' },
      { role: 'user', content: topic },
    ],
  })
  let tokens = plan.tokens
  const wanted = (extractJson(plan.content)?.speakers ?? []) as any[]
  const chosen = wanted.slice(0, MAX_SPEAKERS).map((sp: any) => {
    const nm = String(sp?.name ?? '').toLowerCase()
    const sa = subs.find((s: any) => String(s.name).toLowerCase() === nm) ?? subs.find((s: any) => nm && String(s.name).toLowerCase().includes(nm))
    return sa ? { sa, focus: String(sp?.focus ?? '') } : null
  }).filter(Boolean) as { sa: any; focus: string }[]
  const speakers = chosen.length ? chosen : subs.slice(0, Math.min(3, subs.length)).map((sa: any) => ({ sa, focus: '' }))

  // kickoff — coordinator opens the discussion visibly
  await tgSend(coordToken, chatId, `🧩 Команда, работаем над задачей:\n«${topic}»\n\nПодключаю: ${speakers.map((x) => x.sa.name).join(', ')}.`)

  // 2) each specialist posts its OWN contribution, aware of what was said before it
  const discussion: { name: string; role: string; text: string }[] = []
  for (const { sa, focus } of speakers) {
    const p = sa.prompt ?? {}
    const prior = discussion.length ? discussion.map((d) => `${d.name} (${d.role}): ${d.text}`).join('\n\n') : '(ты выступаешь первым)'
    const out = await callOpenRouter({
      apiKey, model: sa.model || PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 320,
      messages: [
        { role: 'system', content:
          `You are "${sa.name}", a ${sa.role}. ${p.role ?? ''} Your tasks: ${p.tasks ?? ''}.\n` +
          'You are in a TEAM group chat working together on a task. Give ONE concrete, professional contribution ' +
          'from your area of expertise — build on what colleagues already said, do NOT repeat them. Be specific and ' +
          'brief (2-5 sentences). Reply in the SAME language as the task. No AI/assistant talk, no greetings.' +
          (focus ? ` Focus on: ${focus}.` : '') },
        { role: 'user', content: `Task: ${topic}\n\nWhat the team already said:\n${prior}\n\nYour turn — add your part.` },
      ],
    })
    tokens += out.tokens
    const contribution = (out.content ?? '').trim()
    if (!contribution) continue
    discussion.push({ name: sa.name, role: sa.role, text: contribution })
    const ownToken = tokenBySub.get(sa.id)
    if (ownToken) await tgSend(ownToken, chatId, contribution)                                   // from the specialist's OWN bot
    else await tgSend(coordToken, chatId, `🧑‍💼 ${sa.name} (${sa.role}):\n${contribution}`)      // fallback: coordinator relays, labeled
  }

  // 3) LEAD synthesizes the decision the group can act on
  const synth = await callOpenRouter({
    apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.4, maxTokens: 500,
    messages: [
      { role: 'system', content:
        'You are the team lead. Turn the team discussion into a clear decision/plan the group can act on: ' +
        '3-6 concrete next steps, with an owner where it makes sense. Warm, professional, same language as the task. ' +
        'No mention of AI/JSON/internal steps.' },
      { role: 'user', content: `Task: ${topic}\n\nTeam discussion:\n${discussion.map((d) => `${d.name}: ${d.text}`).join('\n\n')}\n\nWrite the final decision for the group.` },
    ],
  })
  tokens += synth.tokens
  if (synth.content) await tgSend(coordToken, chatId, `✅ Итог от лида:\n${synth.content.trim()}`)

  // usage accounting
  await db.from('usage').insert({ account_id: accountId, tokens, model: null, stage: 'group-discussion' })
  if (tokens) await db.rpc('decrement_token_balance', { p_account: accountId, p_amount: tokens })
  return true
}
/* eslint-enable @typescript-eslint/no-explicit-any */
