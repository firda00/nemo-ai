// Ustudy Operations Team — real business workflows (structured, persisted).
//   POST /functions/v1/ops-workflow   (Authorization: Bearer <user jwt>)
//   action 'payment_control'  { department_id?, input, lang } -> reminders + admin escalations + summary
//   action 'meeting_to_tasks' { department_id?, input, lang } -> decisions + tasks + weekly report
//
// Each step runs ONE real specialist sub-agent (using its saved prompt when the
// team exists) through OpenRouter, produces strict JSON, and the whole run —
// per-step agent trace + manager summary + tasks/notifications — is saved to the
// DB (research_runs + tasks + notifications). Token-guarded + usage-accounted.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsHeaders, json } from '../_shared/cors.ts'
import { buildTaskRow, cleanTitle, STATUS } from '../_shared/planerkaSheet.ts'
import { googleAccessToken, sheetsAppend } from '../_shared/google.ts'
import { readPlanerkaRoster, matchRoster } from '../_shared/planerkaRoster.ts'
import { tgSend } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

const LANG_NAME: Record<string, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English' }

function extractJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s === -1 || e === -1 || e < s) return null
  try {
    return JSON.parse(text.slice(s, e + 1))
  } catch {
    return null
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function subSystem(sa: any, fallback: string): string {
  if (!sa) return fallback
  const p = sa.prompt ?? {}
  return [
    `You are "${sa.name}", a ${sa.role}.`,
    p.role && `Role: ${p.role}`,
    p.tasks && `Tasks: ${p.tasks}`,
    p.tone && `Tone: ${p.tone}`,
    p.rules && `Rules: ${p.rules}`,
  ].filter(Boolean).join('\n')
}

const oneOf = (v: unknown, allowed: string[], def: string) => (allowed.includes(String(v)) ? String(v) : def)
const validDate = (d: unknown): string | null => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

// A two-hour transcript is much larger than one model prompt. Keep the full
// input, split it into bounded overlapping windows, analyze every window, then
// reduce the structured results. The constants cap both provider cost and DB
// side effects while still covering the final words of a 240k-character input.
const MEETING_INPUT_MAX_CHARS = 240_000
const MEETING_CHUNK_CHARS = 22_000
const MEETING_CHUNK_OVERLAP = 400
const MEETING_MAX_CHUNKS = 12
const MEETING_TASKS_PER_CHUNK = 12
const MEETING_FINAL_TASK_LIMIT = 40
const MEETING_NORMALIZE_BATCH = 20

function splitMeetingTranscript(input: string): string[] {
  if (input.length <= MEETING_CHUNK_CHARS) return [input]
  const chunks: string[] = []
  let start = 0
  while (start < input.length && chunks.length < MEETING_MAX_CHUNKS) {
    let end = Math.min(input.length, start + MEETING_CHUNK_CHARS)
    if (end < input.length) {
      // Prefer a sentence/paragraph boundary near the end without shrinking a
      // chunk enough to leave the tail uncovered by the 12-window hard cap.
      const floor = start + Math.floor(MEETING_CHUNK_CHARS * 0.95)
      const window = input.slice(floor, end)
      const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! ')]
      const boundary = Math.max(...candidates)
      if (boundary >= 0) end = floor + boundary + 1
    }
    const chunk = input.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= input.length) break
    start = Math.max(start + 1, end - MEETING_CHUNK_OVERLAP)
  }
  if (start < input.length && chunks.length === MEETING_MAX_CHUNKS) {
    const coveredTail = chunks[chunks.length - 1]
    if (!coveredTail.includes(input.slice(-Math.min(100, input.length)).trim())) throw new Error('MEETING_CHUNK_LIMIT_EXCEEDED')
  }
  return chunks
}

function uniqueText(values: unknown[], limit = 40): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    const key = text.toLocaleLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    result.push(text.slice(0, 500))
    if (result.length >= limit) break
  }
  return result
}

function taskKey(task: any): string {
  return [cleanTitle(task?.title).toLocaleLowerCase(), String(task?.owner ?? '').trim().toLocaleLowerCase(), String(task?.deadline ?? '')].join('|')
}

function roundRobinTaskCandidates(groups: any[][], limit: number): any[] {
  const selected: any[] = []
  const seen = new Set<string>()
  const maxDepth = Math.max(0, ...groups.map((group) => group.length))
  for (let depth = 0; depth < maxDepth && selected.length < limit; depth++) {
    for (let chunkIndex = 0; chunkIndex < groups.length && selected.length < limit; chunkIndex++) {
      const task = groups[chunkIndex]?.[depth]
      if (!task?.title) continue
      const key = taskKey(task)
      if (!key || seen.has(key)) continue
      seen.add(key)
      selected.push({ ...task, source_chunk: chunkIndex + 1 })
    }
  }
  return selected
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { data: prof } = await userDb.from('users').select('account_id').eq('id', user.id).maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: acc } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  if (acc && Number(acc.token_balance) <= 0) return json({ error: 'no_tokens' }, 402)
  const orKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
  if (!orKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured on the server.' }, 503)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')
  const lang = String(body?.lang ?? '').trim()
  const departmentId = typeof body?.department_id === 'string' ? body.department_id : null
  const langRule = lang && LANG_NAME[lang] ? `Write all human-facing text in ${LANG_NAME[lang]}.` : 'Write in the same language as the input.'
  const today = new Date().toISOString().slice(0, 10)

  // Load the team's saved specialist sub-agents (RLS-scoped). If department_id
  // belongs to another account, RLS returns nothing and we fall back to defaults.
  let subs: any[] = []
  let deptNiche = ''
  if (departmentId) {
    const { data: d } = await userDb.from('departments').select('id, niche').eq('id', departmentId).maybeSingle()
    if (!d) return json({ error: 'department not found' }, 404)
    deptNiche = String(d.niche ?? '')
    const { data: s } = await userDb.from('sub_agents').select('*').eq('department_id', departmentId)
    subs = s ?? []
  }
  // Business-agnostic context so the SAME workflows fit ANY tenant (gym, clinic,
  // shop, courses…), not just education. Prefer an explicit hint, else the team niche.
  const business = (String(body?.business ?? '').trim() || deptNiche).slice(0, 200)
  const bizCtx = business ? `The business is: ${business}. ` : ''
  const find = (part: string) => subs.find((s) => String(s.name ?? '').toLowerCase().includes(part.toLowerCase()))

  let totalTokens = 0
  const trace: { query: string; findings: string }[] = []
  const runStep = async (sa: any, roleName: string, fallbackSystem: string, userContent: string, temperature = 0.4, maxTokens = 900): Promise<string> => {
    const messages: ChatMsg[] = [
      { role: 'system', content: `${subSystem(sa, fallbackSystem)}\n${langRule}` },
      { role: 'user', content: userContent },
    ]
    const r = await callOpenRouter({ apiKey: orKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, messages, temperature, maxTokens })
    totalTokens += r.tokens
    trace.push({ query: roleName, findings: r.content })
    return r.content
  }
  let charged = false
  const charge = async () => {
    if (charged || !totalTokens) return
    charged = true
    await admin.from('usage').insert({ account_id: accountId, tokens: totalTokens, model: 'ops-workflow' })
    await admin.rpc('decrement_token_balance', { p_account: accountId, p_amount: totalTokens })
  }

  try {
    if (action === 'payment_control') {
      const input = String(body?.input ?? '').trim().slice(0, 6000)
      if (input.length < 4) return json({ error: 'input required' }, 400)

      const remRaw = await runStep(
        find('Payment Reminder'),
        'Payment Reminder Agent',
        `You are a payment reminder specialist for a business. ${bizCtx}Be respectful and concrete.`,
        `Payment rows (customer, item/service, amount, due, status):\n${input}\n\nFor each unpaid or partial customer, write a short respectful reminder message and assess payment risk. Respond ONLY as JSON: {"reminders":[{"student":string,"course":string,"amount":string,"due":string,"risk":"low"|"medium"|"high","message":string}]} (use the "student" field for the customer name, "course" for the item/service).`,
        0.5,
      )
      const reminders = (extractJson(remRaw)?.reminders as any[]) ?? []

      const escRaw = await runStep(
        find('Admin Control'),
        'Admin Control Agent',
        'You are an admin-control escalation specialist. Escalate overdue / high-risk / no-response cases to the responsible admin.',
        `Reminders JSON:\n${JSON.stringify(reminders)}\n\nFor every high or medium risk (or overdue) case create an escalation for the responsible admin with a concrete next action. Respond ONLY as JSON: {"escalations":[{"admin":string,"student":string,"risk":"low"|"medium"|"high","action":string,"note":string}]}.`,
        0.4,
      )
      const escalations = (extractJson(escRaw)?.escalations as any[]) ?? []

      const summary = await runStep(
        find('Report'),
        'Report Agent',
        'You are a manager-report specialist. Write concise, decision-ready Markdown.',
        `Write a short manager report in Markdown for payment control.\nReminders:\n${JSON.stringify(reminders)}\nEscalations:\n${JSON.stringify(escalations)}\n\nInclude: a one-line overview, a risk table (student, amount, risk, action), and recommended next actions.`,
        0.4,
      )

      const { data: run } = await userDb
        .from('research_runs')
        .insert({ task: 'Payment Control', kind: 'payment_control', department_id: departmentId, status: 'done', report: summary, sources: [], steps: trace, tokens: totalTokens })
        .select('id')
        .single()
      const runId = run?.id ?? null

      const notifRows = escalations
        .filter((e) => e && (e.student || e.note || e.action))
        .slice(0, 30)
        .map((e) => ({
          department_id: departmentId,
          run_id: runId,
          kind: 'admin_escalation',
          title: `Payment escalation: ${String(e.student ?? '').slice(0, 120)}`.trim(),
          body: String(e.note ?? e.action ?? '').slice(0, 1000),
          risk: oneOf(e.risk, ['low', 'medium', 'high'], 'medium'),
          target: e.admin ? String(e.admin).slice(0, 120) : null,
        }))
      let notification_ids: string[] = []
      if (notifRows.length) {
        const { data: n } = await userDb.from('notifications').insert(notifRows).select('id')
        notification_ids = (n ?? []).map((x: any) => x.id)
      }

      await charge()
      return json({ ok: true, run_id: runId, reminders, escalations, summary, notification_ids })
    }

    if (action === 'meeting_to_tasks') {
      const input = String(body?.input ?? '').trim()
      if (input.length < 4) return json({ error: 'input required' }, 400)
      if (input.length > MEETING_INPUT_MAX_CHARS) {
        return json({
          ok: false,
          code: 'INPUT_TOO_LARGE',
          message: `Расшифровка содержит ${input.length} символов и превышает явный лимит ${MEETING_INPUT_MAX_CHARS}. Текст не был обрезан: разделите встречу на части.`,
        }, 200)
      }

      const chunks = splitMeetingTranscript(input)
      const chunkAnalyses: Record<string, unknown>[] = []
      for (let i = 0; i < chunks.length; i++) {
        const anRaw = await runStep(
          find('Meeting Analyst'),
          `Meeting Analyst Agent ${i + 1}/${chunks.length}`,
          'You ANALYZE one ordered chunk of a meeting transcript. Extract only facts and action items that are present in this chunk; never invent missing owners or dates.',
          `Today is ${today}. This is transcript chunk ${i + 1} of ${chunks.length}. Overlap with an adjacent chunk is possible, so keep exact wording useful for later deduplication.\n\n${chunks[i]}\n\n` +
            `Return ONLY JSON: {"decisions":[string],"risks":[string],"priorities":[string],"tasks":[{"title":string,"owner":string,"deadline":string|null,"priority":"low"|"medium"|"high"}]}. ` +
            `Extract at most ${MEETING_TASKS_PER_CHUNK} concrete tasks. A task must be a real action item; preserve the stated owner. Resolve a spoken relative date against today when possible, otherwise deadline is null. Keep all text in the transcript's language.`,
          0.2,
          1200,
        )
        chunkAnalyses.push(extractJson(anRaw) ?? {})
      }

      const decisions = uniqueText(chunkAnalyses.flatMap((analysis) => Array.isArray(analysis.decisions) ? analysis.decisions : []))
      const risks = uniqueText(chunkAnalyses.flatMap((analysis) => Array.isArray(analysis.risks) ? analysis.risks : []))
      const priorities = uniqueText(chunkAnalyses.flatMap((analysis) => Array.isArray(analysis.priorities) ? analysis.priorities : []))
      const taskGroups = chunkAnalyses.map((analysis) => Array.isArray(analysis.tasks)
        ? (analysis.tasks as any[]).filter((task) => task?.title).slice(0, MEETING_TASKS_PER_CHUNK)
        : [])
      const distinctTaskCandidates = new Set(taskGroups.flat().map(taskKey).filter(Boolean)).size
      // Round-robin selection prevents the first chunks from consuming the whole
      // side-effect limit before tasks from the end of the meeting are considered.
      const rawTasks = roundRobinTaskCandidates(taskGroups, MEETING_FINAL_TASK_LIMIT)
      const taskLimitReached = distinctTaskCandidates > rawTasks.length

      const normalized: any[] = []
      for (let offset = 0; offset < rawTasks.length; offset += MEETING_NORMALIZE_BATCH) {
        const batch = rawTasks.slice(offset, offset + MEETING_NORMALIZE_BATCH).map((task, index) => ({ ...task, source_index: offset + index }))
        const tmRaw = await runStep(
          find('Task Manager'),
          `Task Manager Agent ${Math.floor(offset / MEETING_NORMALIZE_BATCH) + 1}/${Math.ceil(rawTasks.length / MEETING_NORMALIZE_BATCH)}`,
          'You are a task manager. Normalize every supplied action item into a clean, trackable task without dropping or merging source items.',
          `Today is ${today}. Raw tasks JSON:\n${JSON.stringify(batch)}\n\n` +
            `Return exactly one item for every source_index and preserve source_index. Each title must be a short imperative phrase (about 7 words); put context in details. Keep the stated owner and valid deadline. Set status to "todo", "in_progress", "done", or "overdue". ` +
            `Respond ONLY as JSON: {"tasks":[{"source_index":number,"title":string,"details":string|null,"owner":string,"deadline":string|null,"priority":"low"|"medium"|"high","status":"todo"|"in_progress"|"done"|"overdue"}]}.`,
          0.2,
          1600,
        )
        const parsed = (extractJson(tmRaw)?.tasks as any[]) ?? []
        const bySource = new Map<number, any>()
        for (const task of parsed) {
          const sourceIndex = Number(task?.source_index)
          if (Number.isInteger(sourceIndex)) bySource.set(sourceIndex, task)
        }
        for (const source of batch) {
          const task = bySource.get(source.source_index) ?? {}
          normalized.push({
            ...source,
            ...task,
            title: cleanTitle(task.title || source.title),
            details: task.details == null ? null : String(task.details).slice(0, 2000),
            owner: String(task.owner ?? source.owner ?? '').slice(0, 120),
            deadline: validDate(task.deadline) ?? validDate(source.deadline),
            priority: oneOf(task.priority ?? source.priority, ['low', 'medium', 'high'], 'medium'),
            status: oneOf(task.status, ['todo', 'in_progress', 'done', 'overdue'], 'todo'),
          })
        }
      }

      const summary = await runStep(
        find('Report'),
        'Report Agent',
        'You are a manager-report specialist. Write a concise weekly operations report in Markdown.',
        `Write a short weekly operations report in Markdown.\nDecisions:\n${JSON.stringify(decisions)}\nRisks:\n${JSON.stringify(risks)}\nPriorities:\n${JSON.stringify(priorities)}\nTasks:\n${JSON.stringify(normalized)}\n\nInclude: key decisions, risks/blockers, a task summary grouped by owner, overdue/at-risk items, and next-week priorities.`,
        0.4,
        1000,
      )

      const { data: run } = await userDb
        .from('research_runs')
        .insert({ task: 'Meeting to Tasks', kind: 'meeting_to_tasks', department_id: departmentId, status: 'done', report: summary, sources: [], steps: trace, tokens: totalTokens })
        .select('id')
        .single()
      const runId = run?.id ?? null

      // Attach the account's Telegram planerka group (if set up) so these meeting tasks are
      // ALSO remindable — the reminder cron needs a channel + chat to ping.
      let grpChannel: string | null = null, grpChat: string | null = null
      try {
        const { data: gch } = await userDb.from('channels').select('id').eq('type', 'telegram').eq('scope', 'group').order('created_at', { ascending: false }).limit(1).maybeSingle()
        if (gch?.id) {
          grpChannel = gch.id
          const { data: tm } = await userDb.from('telegram_members').select('chat_id').eq('channel_id', gch.id).not('chat_id', 'is', null).limit(1).maybeSingle()
          grpChat = tm?.chat_id ?? null
          if (!grpChat) { const { data: pt } = await userDb.from('tasks').select('telegram_chat_id').eq('channel_id', gch.id).not('telegram_chat_id', 'is', null).limit(1).maybeSingle(); grpChat = pt?.telegram_chat_id ?? null }
        }
      } catch { /* best effort — no group means these just won't remind via Telegram */ }

      const taskRows = (normalized as any[])
        .filter((t) => t && t.title)
        .slice(0, 40)
        .map((t) => {
          const dl = validDate(t.deadline)
          return {
            department_id: departmentId,
            run_id: runId,
            title: cleanTitle(t.title) || String(t.title).slice(0, 120),
            owner: t.owner ? String(t.owner).slice(0, 120) : null,
            deadline: dl,
            due_at: dl ? new Date(`${dl}T09:00:00.000Z`).toISOString() : null,
            channel_id: grpChannel,
            telegram_chat_id: grpChat,
            priority: oneOf(t.priority, ['low', 'medium', 'high'], 'medium'),
            status: oneOf(t.status, ['todo', 'in_progress', 'done', 'overdue'], 'todo'),
            source: 'meeting',
          }
        })
      let task_ids: string[] = []
      if (taskRows.length) {
        const { data: tr } = await userDb.from('tasks').insert(taskRows).select('id')
        task_ids = (tr ?? []).map((x: any) => x.id)
      }

      // Keep the user's connected planerka sheet as the source of truth. This only
      // appends the newly extracted tasks; it never creates a replacement sheet.
      let sheet_written = 0
      try {
        const { data: profile } = await admin.from('business_profiles').select('tasks_sheet_id').eq('account_id', accountId).maybeSingle()
        const sheetId = String(profile?.tasks_sheet_id ?? '').trim()
        const sheetLang = ['uz', 'ru', 'en'].includes(lang) ? lang as 'uz' | 'ru' | 'en' : 'en'
        if (sheetId) {
          const g = await googleAccessToken(admin, accountId)
          if (g.token) {
            for (const t of taskRows) {
              const sheetStatus = t.status === 'done' ? STATUS[sheetLang].done : t.status === 'in_progress' ? STATUS[sheetLang].inProgress : STATUS[sheetLang].new
              const ok = await sheetsAppend(g.token, sheetId, buildTaskRow(sheetLang, {
                title: t.title,
                person: t.owner ?? '',
                deadline: t.deadline ?? '',
                taskType: 'meeting',
                status: sheetStatus,
                details: String((normalized as any[]).find((raw) => cleanTitle(raw?.title) === t.title)?.details ?? ''),
              }))
              if (ok) sheet_written++
            }
          }
        }
      } catch { /* sheet sync is best-effort; DB tasks remain authoritative */ }

      // Persist the resolved owner's Telegram chat ID on each task so the reminder
      // cron can follow up with the individual, not only the group chat.
      try {
        const roster = await readPlanerkaRoster(admin, accountId)
        for (let i = 0; i < taskRows.length; i++) {
          const owner = taskRows[i].owner
          const chatId = owner ? matchRoster(roster, owner)?.chatId : undefined
          if (chatId && task_ids[i]) await admin.from('tasks').update({ telegram_chat_id: chatId }).eq('id', task_ids[i])
        }
      } catch { /* roster sync is best-effort */ }

      // Dispatch: DM each person THEIR tasks privately; fall back to a group @mention for anyone the
      // bot can't DM yet (they haven't pressed /start). Also post the analysis summary to the group.
      let dm_sent = 0
      if (grpChannel && taskRows.length) {
        try {
          const { data: ch } = await userDb.from('channels').select('credentials').eq('id', grpChannel).maybeSingle()
          const botToken = ch?.credentials?.bot_token
          if (botToken) {
            const { data: mems } = await userDb.from('telegram_members').select('tg_user_id, username, display_name').eq('channel_id', grpChannel)
            // the company's OWN connected roster sheet (name/username -> its chat_id) takes priority
            const roster = await readPlanerkaRoster(admin, accountId)
            const resolve = (owner: string): { uid?: string; uname?: string } => {
              const o = String(owner ?? '').toLowerCase().replace(/^@/, '').trim()
              if (!o) return {}
              // 1) match against the connected sheet; use its chat_id for the DM when present
              const rm = matchRoster(roster, owner)
              if (rm?.chatId) return { uid: rm.chatId, uname: rm.username || undefined }
              // 2) fall back to members the bot has already seen in the group (pressed /start)
              for (const m of (mems ?? []) as any[]) {
                const un = String(m.username ?? '').toLowerCase(), dn = String(m.display_name ?? '').toLowerCase()
                if ((un && (o === un || o.includes(un) || un.includes(o))) || (dn && (o === dn || dn.includes(o) || o.includes(dn)))) return { uid: m.tg_user_id ? String(m.tg_user_id) : undefined, uname: m.username ?? (rm?.username || undefined) }
              }
              // 3) roster match without a chat_id yet — keep the username so the group @mention still tags them
              if (rm) return { uname: rm.username || undefined }
              return {}
            }
            const byOwner = new Map<string, { lines: string[]; uid?: string; uname?: string }>()
            for (const t of taskRows) {
              const owner = t.owner || '—'
              if (!byOwner.has(owner)) { const r = resolve(owner); byOwner.set(owner, { lines: [], uid: r.uid, uname: r.uname }) }
              byOwner.get(owner)!.lines.push(t.title + (t.deadline ? ` (до ${t.deadline})` : ''))
            }
            const undelivered: string[] = []
            for (const [owner, g] of byOwner) {
              const list = g.lines.map((x, i) => `${i + 1}. ${x}`).join('\n')
              let sent = false
              if (g.uid) { try { sent = await tgSend(botToken, g.uid, `📋 Ваши задачи с планёрки:\n${list}\n\nОтметьте готовые: напишите боту «готово».`) } catch { sent = false } }
              if (sent) dm_sent++; else undelivered.push(`${g.uname ? '@' + g.uname : owner}:\n${list}`)
            }
            if (grpChat) {
              const head = ['🧠 Разбор планёрки:',
                decisions.length ? 'Решения:\n' + decisions.slice(0, 6).map((d) => `• ${d}`).join('\n') : '',
                risks.length ? 'Риски:\n' + risks.slice(0, 5).map((d) => `• ${d}`).join('\n') : '',
                priorities.length ? 'Приоритеты:\n' + priorities.slice(0, 5).map((d) => `• ${d}`).join('\n') : '',
              ].filter(Boolean).join('\n\n')
              const foot = undelivered.length
                ? '\n\n⚠️ Не удалось отправить в личку (пусть напишут боту /start):\n' + undelivered.join('\n\n')
                : (dm_sent ? '\n\n✅ Задачи разосланы каждому в личные сообщения.' : '')
              await tgSend(botToken, grpChat, head + foot)
            }
          }
        } catch { /* dispatch is best-effort */ }
      }

      await charge()
      return json({
        ok: true,
        run_id: runId,
        decisions,
        risks,
        priorities,
        tasks: taskRows,
        task_ids,
        sheet_written,
        dm_sent,
        summary,
        analysis: {
          input_chars: input.length,
          chunks: chunks.length,
          task_candidates: distinctTaskCandidates,
          task_limit: MEETING_FINAL_TASK_LIMIT,
          task_limit_reached: taskLimitReached,
        },
      })
    }

    // retention_scan — detect students who stopped attending / didn't pay next month
    // ("ушли, а мы не знаем") and draft a ready personal win-back message for each.
    if (action === 'retention_scan') {
      const input = String(body?.input ?? '').trim().slice(0, 8000)
      if (input.length < 4) return json({ error: 'input required' }, 400)

      const raw = await runStep(
        find('Retention') ?? find('Payment Reminder'),
        'Retention Specialist',
        `You are a customer-retention specialist for a business. ${bizCtx}You spot customers/clients who stopped engaging (visits, sessions, orders, attendance) or did not renew/pay for the next period, and you write warm, personal win-back messages that get them back.`,
        `Today is ${today}. Customer rows (name, contact, last activity/visit, renewal/payment status):\n${input}\n\n` +
          'For EACH person decide status: "active" | "at_risk" | "churned" (churned = stopped engaging AND did not renew/pay for the next period; at_risk = missed a payment/renewal or engagement clearly dropping). ' +
          'For every at_risk or churned person, write a ready-to-send PERSONAL message: address them by name, reference their specific situation, and offer a concrete way back (e.g. discount, flexible option, a call). Fit the message to THIS business. ' +
          'Respond ONLY as JSON: {"students":[{"name":string,"contact":string,"status":"active"|"at_risk"|"churned","reason":string,"message":string|null}]}.',
        0.5,
      )
      const students = ((extractJson(raw)?.students as any[]) ?? []).filter((s) => s && s.name)
      const flagged = students.filter((s) => s.status === 'churned' || s.status === 'at_risk')

      const summary = await runStep(
        find('Report'),
        'Report Agent',
        'You are a manager-report specialist. Write concise, decision-ready Markdown.',
        `Write a short manager report in Markdown on student retention.\nStudents:\n${JSON.stringify(students)}\n\nInclude: counts (active / at-risk / churned), who left and why, and recommended next actions.`,
        0.4,
      )

      const { data: run } = await userDb
        .from('research_runs')
        .insert({ task: 'Retention Scan', kind: 'retention_scan', department_id: departmentId, status: 'done', report: summary, sources: [], steps: trace, tokens: totalTokens })
        .select('id')
        .single()
      const runId = run?.id ?? null

      const notifRows = flagged.slice(0, 40).map((s) => ({
        department_id: departmentId,
        run_id: runId,
        kind: s.status === 'churned' ? 'churn_alert' : 'payment_risk',
        title: `${s.status === 'churned' ? 'Ушёл' : 'Риск'}: ${String(s.name ?? '').slice(0, 120)}`.trim(),
        body: String(s.reason ?? '').slice(0, 1000),
        risk: s.status === 'churned' ? 'high' : 'medium',
        target: s.contact ? String(s.contact).slice(0, 120) : null,
      }))
      let notification_ids: string[] = []
      if (notifRows.length) {
        const { data: n } = await userDb.from('notifications').insert(notifRows).select('id')
        notification_ids = (n ?? []).map((x: any) => x.id)
      }

      await charge()
      return json({ ok: true, run_id: runId, students, flagged, summary, notification_ids })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    console.error('ops-workflow error:', e)
    await charge().catch(() => undefined)
    return json({ error: 'ops_failed', detail: String(e) }, 502)
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
