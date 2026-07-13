// Logistics Control: manual/CSV shipment rows -> deterministic SLA checks ->
// specialist triage -> durable tasks, alerts, approval-only message drafts and report.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL, type ChatMsg } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { cleanTitle } from '../_shared/planerkaSheet.ts'
import { parseShipmentRows } from '../_shared/logisticsInput.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const LANG_NAME: Record<string, string> = { uz: 'Uzbek', ru: 'Russian', en: 'English' }
const SHARED_CREDIT_RESERVATION = 50

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractJson(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s < 0 || e < s) return null
  try { return JSON.parse(text.slice(s, e + 1)) } catch { return null }
}

const oneOf = (value: unknown, allowed: string[], fallback: string) => allowed.includes(String(value)) ? String(value) : fallback

function savedSystem(sa: any, fallback: string): string {
  if (!sa) return fallback
  const p = sa.prompt ?? {}
  return [`You are "${sa.name}", a ${sa.role}.`, p.role, p.tasks, p.rules].filter(Boolean).join('\n')
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id').eq('id', user.id).maybeSingle()
  const accountId = profile?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const body = await req.json().catch(() => ({}))
  if (String(body?.action ?? 'logistics_control') !== 'logistics_control') return json({ error: 'unknown action' }, 400)
  const source = String(body?.source ?? 'manual')
  if (source !== 'manual') return json({ ok: false, code: 'SOURCE_NOT_CONNECTED', message: 'This version accepts pasted CSV/text rows. Carrier and store sync must be connected separately.' }, 200)
  const departmentId = String(body?.department_id ?? '')
  if (!departmentId) return json({ error: 'department_id required' }, 400)
  const { data: department } = await userDb.from('departments').select('id, name').eq('id', departmentId).maybeSingle()
  if (!department) return json({ error: 'department not found' }, 404)

  const input = String(body?.input ?? '').trim().slice(0, 12000)
  if (input.length < 4) return json({ error: 'input required' }, 400)
  const parsedInput = parseShipmentRows(input)
  if (!parsedInput.rows.length) return json({ ok: false, code: 'INPUT_FORMAT', message: parsedInput.error ?? 'Add one shipment per line and put order_id in the first column.' }, 200)
  const sourceRows = parsedInput.rows

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: account } = await admin.from('accounts').select('token_balance, blocked').eq('id', accountId).single()
  if (account?.blocked) return json({ error: 'blocked' }, 403)
  const apiKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
  if (!apiKey) return json({ ok: false, code: 'MISSING_PROVIDER_SECRET', message: 'OpenRouter key is not configured.' }, 503)
  const sharedKey = OPENROUTER_API_KEY.trim()
  const usingSharedKey = Boolean(sharedKey) && apiKey === sharedKey
  let creditReserved = false
  if (usingSharedKey) {
    const { data: reserved, error: reserveError } = await admin.rpc('reserve_logistics_credits', { p_account: accountId, p_credits: SHARED_CREDIT_RESERVATION })
    if (reserveError) return json({ ok: false, code: 'BILLING_UNAVAILABLE', message: 'Could not reserve a Nemo credit for this run. Please retry.' }, 503)
    if (!reserved) return json({ ok: false, code: 'INSUFFICIENT_CREDITS', message: 'This run needs 50 available Nemo credits as a safety reservation; unused credits are returned after the run.' }, 200)
    creditReserved = true
  }
  const { data: subRows } = await userDb.from('sub_agents').select('*').eq('department_id', departmentId).eq('status', 'active')
  const subs = subRows ?? []
  const find = (part: string) => subs.find((s: any) => `${s.name} ${s.role}`.toLowerCase().includes(part.toLowerCase()))
  const lang = String(body?.lang ?? '')
  const langRule = LANG_NAME[lang] ? `Write human-facing text in ${LANG_NAME[lang]}.` : 'Use the input language.'
  const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10)
  let totalTokens = 0
  const trace: { query: string; findings: string }[] = []

  const runStep = async (sa: any, name: string, fallback: string, content: string, jsonMode = false) => {
    const messages: ChatMsg[] = [
      { role: 'system', content: `${savedSystem(sa, fallback)}\n${langRule}` },
      { role: 'user', content },
    ]
    const r = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, messages, temperature: 0.2, maxTokens: 1800, ...(jsonMode ? { responseFormat: { type: 'json_object' } } : {}) })
    totalTokens += r.tokens
    trace.push({ query: name, findings: r.content })
    return r.content
  }

  try {
    const now = Date.now()
    const dayMs = 86400000
    trace.push({ query: 'Shipment parser', findings: `Parsed ${sourceRows.length} unique shipment rows from the manual source. ${parsedInput.warnings.length ? `Warnings: ${parsedInput.warnings.join(' ')}` : 'No rows were rejected.'}` })
    const shipments = sourceRows.map((x) => {
      const status = x.status
      const promised = x.promised_date
      const lastEvent = x.last_event_at
      const promisedMs = promised ? Date.parse(`${promised}T23:59:59+05:00`) : NaN
      const lastMs = lastEvent ? Date.parse(lastEvent) : NaN
      const shippedMs = x.shipped_at ? Date.parse(x.shipped_at) : NaN
      const futureFacts = [Number.isFinite(lastMs) && lastMs > now + 5 * 60000 ? 'last_event_at is in the future' : '', Number.isFinite(shippedMs) && shippedMs > now + 5 * 60000 ? 'shipped_at is in the future' : ''].filter(Boolean)
      const missingFacts = [status === 'unknown' ? 'status' : '', !promised ? 'promised_date' : '', !lastEvent ? 'last_event_at' : ''].filter(Boolean)
      let sla_status: 'on_track' | 'at_risk' | 'breached' | 'needs_data' = futureFacts.length || (status !== 'delivered' && missingFacts.length) ? 'needs_data' : 'on_track'
      if (!futureFacts.length && status !== 'delivered' && Number.isFinite(promisedMs)) {
        if (promisedMs < now) sla_status = 'breached'
        else if (promisedMs - now <= dayMs) sla_status = 'at_risk'
      }
      if (!futureFacts.length && status !== 'delivered' && Number.isFinite(lastMs) && now - lastMs > 48 * 3600000 && sla_status !== 'breached') sla_status = 'at_risk'
      if (!futureFacts.length && (status === 'delayed' || status === 'problem')) sla_status = sla_status === 'breached' ? 'breached' : 'at_risk'
      const delay_hours = sla_status === 'breached' && Number.isFinite(promisedMs) ? Math.max(1, Math.round((now - promisedMs) / 3600000)) : 0
      const dataQualityReason = futureFacts.length ? futureFacts.join('; ') : sla_status === 'needs_data' ? `Missing required fields: ${missingFacts.join(', ')}` : null
      return {
        ...x,
        sla_status, delay_hours, severity: sla_status === 'breached' ? 'high' : sla_status === 'on_track' ? 'low' : 'medium',
        exception_type: x.exception_type ?? (sla_status === 'breached' ? 'delay' : sla_status === 'at_risk' ? 'sla_risk' : sla_status === 'needs_data' ? 'data_quality' : null),
        reason: dataQualityReason ?? x.reason,
        recommended_action: null,
      }
    })

    const exceptions = shipments.filter((x) => x.sla_status !== 'on_track')
    const exceptionSet = new Set(exceptions.map((x) => x.order_id.toLowerCase()))
    trace.push({ query: 'SLA rules engine', findings: JSON.stringify({ timezone: 'Asia/Tashkent', total: shipments.length, on_track: shipments.filter((x) => x.sla_status === 'on_track').length, at_risk: exceptions.filter((x) => x.sla_status === 'at_risk').length, breached: exceptions.filter((x) => x.sla_status === 'breached').length, needs_data: exceptions.filter((x) => x.sla_status === 'needs_data').length }) })
    const triageRaw = await runStep(
      find('Exception'),
      'Exception Triage Agent',
      'You turn verified logistics exceptions into owner/deadline tasks and truthful message drafts. External actions always require human approval.',
      `Today is ${today}. Allowed risk order IDs: ${exceptions.map((x) => x.order_id).join(', ')}.\nVerified shipment state (facts, owner and SLA are locked; do not change them):\n${JSON.stringify(shipments)}\n\nReturn ONLY JSON: {"tasks":[{"order_id":string,"title":string,"details":string}],"client_messages":[{"order_id":string,"draft":string}],"carrier_cases":[{"order_id":string,"draft":string}]}. Create messages only for actual risks. Never promise a refund, reshipment, carrier change, address change or claim approval.`,
      true,
    )
    const triageParsed = extractJson(triageRaw)
    const triage = triageParsed ?? {}
    const rawTasks = Array.isArray(triage.tasks) ? triage.tasks as any[] : []
    const modelTaskByOrder = new Map<string, any>()
    for (const task of rawTasks) {
      const orderId = String(task?.order_id ?? '').toLowerCase()
      if (exceptionSet.has(orderId) && task?.title && !modelTaskByOrder.has(orderId)) modelTaskByOrder.set(orderId, task)
    }
    const candidateTasks = exceptions.map((shipment) => {
      const modelTask = modelTaskByOrder.get(shipment.order_id.toLowerCase())
      return {
        order_id: shipment.order_id,
        title: cleanTitle(modelTask?.title) || `Resolve ${shipment.exception_type ?? 'shipment exception'}: ${shipment.order_id}`,
        details: String(modelTask?.details ?? shipment.reason ?? 'Verify the shipment facts and record the next checkpoint.').slice(0, 800),
        priority: shipment.severity,
      }
    })
    if (!triageParsed || modelTaskByOrder.size < exceptions.length) {
      trace[trace.length - 1].findings += `\n[validator] Deterministic fallback tasks added for ${exceptions.length - modelTaskByOrder.size} uncovered exception(s).`
    }
    const draftRows = (values: unknown): { order_id: string; draft: string; requires_approval: true }[] => {
      const seen = new Set<string>()
      return (Array.isArray(values) ? values as any[] : []).filter((x) => {
        const id = String(x?.order_id ?? '').toLowerCase()
        if (!exceptionSet.has(id) || !x?.draft || seen.has(id)) return false
        seen.add(id); return true
      }).slice(0, 40).map((x) => ({ order_id: String(x.order_id).slice(0, 80), draft: String(x.draft).slice(0, 1200), requires_approval: true }))
    }
    const client_messages = draftRows(triage.client_messages)
    const carrier_cases = draftRows(triage.carrier_cases)

    const summary = await runStep(
      find('Report'),
      'Logistics Report Agent',
      'You write a concise logistics control-tower report. Separate verified facts from recommendations.',
      `Write a short Markdown report for the owner. Verified shipments: ${JSON.stringify(shipments)}. Validated task candidates: ${JSON.stringify(candidateTasks)}. Include counts for on-track/at-risk/breached/needs-data, critical exceptions, owner actions and drafts waiting for manual review.`,
    )
    const { data: run, error: runError } = await admin.from('research_runs').insert({ account_id: accountId, task: 'Logistics Control', kind: 'logistics_control', department_id: departmentId, status: 'done', report: summary, sources: [], steps: trace, tokens: totalTokens }).select('id').single()
    if (runError) {
      console.error('logistics run persistence failed', runError.message)
      return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'The analysis finished, but the run could not be saved. Please retry.' }, 500)
    }
    const runId = run?.id ?? null
    const markRunFailed = async (message: string) => {
      if (runId) await admin.from('research_runs').update({ status: 'error', report: message }).eq('id', runId).eq('account_id', accountId)
    }

    const shipmentById = new Map(shipments.map((x) => [x.order_id.toLowerCase(), x]))
    const taskSelect = 'id, title, owner, deadline, due_at, priority, status, source, details, subject_key'
    const { data: existing, error: existingError } = await admin.from('tasks').select(taskSelect).eq('account_id', accountId).eq('department_id', departmentId).eq('source', 'logistics').neq('status', 'done').limit(500)
    if (existingError) {
      await markRunFailed('Analysis completed, but existing logistics tasks could not be checked.')
      return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'Could not verify existing logistics tasks. No new tasks were reported as saved.' }, 500)
    }
    const taskOrderId = (row: any): string => {
      try { return String(JSON.parse(row?.details ?? '{}')?.order_id ?? '').toLowerCase() } catch { return '' }
    }
    const recoveredIds = (existing ?? []).filter((row: any) => {
      const shipment = shipmentById.get(taskOrderId(row))
      return shipment?.status === 'delivered' && shipment.sla_status === 'on_track'
    }).map((row: any) => row.id)
    if (recoveredIds.length) {
      const { error: recoveryError } = await admin.from('tasks').update({ status: 'done', progress: 100, completed_at: new Date().toISOString(), completed_by: `Logistics recovery rule · ${runId}` }).in('id', recoveredIds).eq('account_id', accountId)
      if (recoveryError) {
        console.error('logistics recovery persistence failed', recoveryError.message)
        await markRunFailed('Delivered shipments were detected, but old logistics tasks could not be closed.')
        return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'Delivered shipments were detected, but their old tasks could not be closed.' }, 500)
      }
    }
    const activeExisting = (existing ?? []).filter((row: any) => !recoveredIds.includes(row.id))
    const existingByOrder = new Map<string, any[]>()
    for (const row of activeExisting) {
      const orderId = taskOrderId(row)
      if (orderId) existingByOrder.set(orderId, [...(existingByOrder.get(orderId) ?? []), row])
    }
    const taskRows: any[] = []
    const persistedTasks: any[] = []
    const supersededIds: string[] = []
    const reconciledIds: string[] = []
    for (const x of candidateTasks) {
      const orderId = String(x?.order_id ?? '').toLowerCase()
      const shipment = shipmentById.get(orderId)
      if (!shipment || !exceptionSet.has(orderId) || !x?.title) continue
      const exceptionType = String(shipment.exception_type ?? 'sla_risk').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60)
      const exceptionKey = `${orderId}|${exceptionType}`
      const deadline = shipment.sla_status === 'at_risk' && shipment.promised_date && shipment.promised_date >= today ? shipment.promised_date : today
      const taskPatch = {
        run_id: runId, title: cleanTitle(x.title) || `Resolve shipment ${shipment.order_id}`,
        owner: shipment.owner ?? 'Logistics operator', deadline,
        due_at: new Date(`${deadline}T09:00:00+05:00`).toISOString(), priority: oneOf(x.priority, ['low', 'medium', 'high'], 'medium'),
        subject_key: exceptionKey,
        details: JSON.stringify({ order_id: shipment.order_id, exception_type: shipment.exception_type, exception_key: exceptionKey, context: String(x.details ?? '').slice(0, 800) }),
      }
      const priorRows = existingByOrder.get(orderId) ?? []
      const exact = priorRows.find((row: any) => String(row.subject_key ?? '').toLowerCase() === exceptionKey)
      const primary = exact ?? priorRows[0]
      if (primary) {
        const extras = priorRows.filter((row: any) => row.id !== primary.id)
        supersededIds.push(...extras.map((row: any) => row.id))
        const { data: updated, error: updateError } = await admin.from('tasks').update({ ...taskPatch, status: exact ? primary.status : 'todo' }).eq('id', primary.id).eq('account_id', accountId).select(taskSelect).single()
        if (updateError?.code === '23505') {
          const { data: concurrent } = await admin.from('tasks').select(taskSelect).eq('account_id', accountId).eq('department_id', departmentId).eq('source', 'logistics').eq('subject_key', exceptionKey).neq('status', 'done').maybeSingle()
          if (!concurrent) {
            await markRunFailed('A concurrent exception transition could not be reconciled.')
            return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'A concurrent exception transition could not be reconciled. Refresh the page.' }, 500)
          }
          supersededIds.push(primary.id)
          persistedTasks.push(concurrent)
        } else if (updateError || !updated) {
          console.error('logistics task reconciliation failed', updateError?.message ?? 'missing updated row')
          await markRunFailed('An existing logistics task could not be reconciled with the new exception state.')
          return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'An existing task could not be updated to the new shipment state.' }, 500)
        } else {
          persistedTasks.push(updated)
          reconciledIds.push(updated.id)
        }
      } else {
        taskRows.push({ account_id: accountId, department_id: departmentId, status: 'todo', source: 'logistics', ...taskPatch })
      }
      if (taskRows.length >= 40) break
    }
    if (supersededIds.length) {
      const uniqueSuperseded = [...new Set(supersededIds)]
      const { error: supersedeError } = await admin.from('tasks').update({ status: 'done', progress: 100, completed_at: new Date().toISOString(), completed_by: `Superseded by logistics state transition · ${runId}` }).in('id', uniqueSuperseded).eq('account_id', accountId)
      if (supersedeError) {
        console.error('logistics stale task cleanup failed', supersedeError.message)
        await markRunFailed('The current exception task was saved, but a stale task could not be closed.')
        return json({ ok: false, code: 'PARTIAL_SUCCESS', message: 'The current task is safe, but a stale task could not be closed.' }, 500)
      }
    }
    for (const row of taskRows) {
      const { data, error } = await admin.from('tasks').insert(row).select(taskSelect).single()
      if (error?.code === '23505') {
        const { data: concurrent, error: concurrentError } = await admin.from('tasks').select(taskSelect).eq('account_id', accountId).eq('department_id', departmentId).eq('source', 'logistics').eq('subject_key', row.subject_key).neq('status', 'done').maybeSingle()
        if (!concurrentError && concurrent) persistedTasks.push(concurrent)
        else {
          console.error('logistics task conflict recovery failed', concurrentError?.message ?? error.message)
          await markRunFailed('A concurrent logistics task was detected but could not be loaded.')
          return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'A concurrent run created the task, but it could not be loaded. Refresh the page.' }, 500)
        }
      } else if (error) {
        console.error('logistics task persistence failed', error.message)
        await markRunFailed('Analysis completed, but a logistics task could not be saved.')
        return json({ ok: false, code: 'PARTIAL_SUCCESS', message: `${persistedTasks.length} task(s) are safe; another task could not be saved. Refresh before retrying.` }, 500)
      } else if (data) {
        persistedTasks.push(data)
      }
    }
    const task_ids = [...new Set(persistedTasks.map((x: any) => x.id).filter(Boolean))]

    const since = new Date(`${today}T00:00:00+05:00`).toISOString()
    const { data: priorNotifs, error: priorNotifError } = await admin.from('notifications').select('kind, target').eq('account_id', accountId).eq('department_id', departmentId).gte('created_at', since)
    if (priorNotifError) {
      await markRunFailed('Analysis and tasks completed, but notifications could not be checked.')
      return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'Tasks were saved, but notifications could not be verified.' }, 500)
    }
    const seenNotif = new Set((priorNotifs ?? []).map((x: any) => `${String(x.kind).toLowerCase()}|${String(x.target ?? '').toLowerCase()}`))
    const notifRows: any[] = []
    for (const x of exceptions) {
      const key = `delay_alert|${x.order_id.toLowerCase()}`
      if (!seenNotif.has(key)) {
        const label = x.sla_status === 'breached' ? 'SLA breached' : x.sla_status === 'needs_data' ? 'Shipment data required' : 'Shipment at risk'
        notifRows.push({ account_id: accountId, department_id: departmentId, run_id: runId, kind: 'delay_alert', title: `${label}: ${x.order_id}`, body: x.reason ?? 'Check the shipment and carrier status.', risk: x.severity, target: x.order_id })
        seenNotif.add(key)
      }
    }
    for (const m of carrier_cases) {
      const target = `carrier:${m.order_id}`
      const key = `approval_request|${target.toLowerCase()}`
      if (!seenNotif.has(key)) {
        notifRows.push({ account_id: accountId, department_id: departmentId, run_id: runId, kind: 'approval_request', title: `Review carrier case draft: ${m.order_id}`, body: m.draft, risk: 'medium', target })
        seenNotif.add(key)
      }
    }
    for (const m of client_messages) {
      const key = `approval_request|${m.order_id.toLowerCase()}`
      if (!seenNotif.has(key)) {
        notifRows.push({ account_id: accountId, department_id: departmentId, run_id: runId, kind: 'approval_request', title: `Review customer message draft: ${m.order_id}`, body: m.draft, risk: 'medium', target: m.order_id })
        seenNotif.add(key)
      }
    }
    let notification_ids: string[] = []
    if (notifRows.length) {
      const { data, error } = await admin.from('notifications').insert(notifRows).select('id')
      if (error) {
        console.error('logistics notification persistence failed', error.message)
        await markRunFailed('Analysis and tasks completed, but notifications could not be saved.')
        return json({ ok: false, code: 'PERSISTENCE_FAILED', message: 'Tasks were saved, but notifications could not be saved.' }, 500)
      }
      notification_ids = (data ?? []).map((x: any) => x.id)
    }

    return json({ ok: true, run_id: runId, shipments, exceptions, tasks: persistedTasks, task_ids, recovered_task_ids: recoveredIds, reconciled_task_ids: reconciledIds, warnings: parsedInput.warnings, client_messages, carrier_cases, summary, steps: trace, notification_ids, capabilities: { source: 'manual', mode: 'analysis_beta', timezone: 'Asia/Tashkent', max_rows: 40, carrier_tracking: false, external_messages_sent: false } })
  } catch (e) {
    console.error('logistics workflow failed', String(e).slice(0, 300))
    return json({ ok: false, code: 'WORKFLOW_FAILED', message: 'Logistics analysis failed before completion. No external message was sent.' }, 502)
  } finally {
    if (totalTokens) {
      const { error: usageError } = await admin.from('usage').insert({ account_id: accountId, tokens: totalTokens, model: 'logistics-workflow' })
      if (usageError) console.error('logistics usage accounting failed', usageError.message)
    }
    if (creditReserved) {
      const { error: finalizeError } = await admin.rpc('finalize_logistics_credits', { p_account: accountId, p_reserved: SHARED_CREDIT_RESERVATION, p_tokens: totalTokens })
      if (finalizeError) console.error('logistics credit finalization failed', finalizeError.message)
    }
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
