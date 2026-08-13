// Browser agent — the agent visits a website and performs a task the USER authorized
// (fill a form, submit an application, post a listing, gather info) on the account's OWN
// Hyperbrowser key. Async: `run` creates + polls; `status` checks a running job.
//   POST /functions/v1/browser-task  (Bearer jwt)
//     { action:'run', task, url? }      -> { ok, result } | { ok, pending, job_id }
//     { action:'status', job_id }       -> { status, result? }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { runBrowserTask, pollBrowserTask, looksAbusive } from '../_shared/browser.ts'
import { planOf, monthlyBrowser } from '../_shared/plans.ts'
import { corsPreflight, json } from '../_shared/cors.ts'
import { redactText, redactValue } from '../_shared/redact.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NEMO_HB_KEY = Deno.env.get('HYPERBROWSER_API_KEY') ?? ''

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id, is_admin').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  if (await blocksExternalActions(admin, accountId)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
  const { data: acc } = await admin.from('accounts').select('plan, blocked').eq('id', accountId).single()
  if (acc?.blocked) return json({ error: 'blocked' }, 403)
  const plan = planOf(acc?.plan)
  // browser agent is INCLUDED in the subscription — runs on Nemo's key; a customer key overrides.
  const { data: keyRow } = await admin.from('provider_keys').select('api_key').eq('account_id', accountId).eq('provider', 'hyperbrowser').maybeSingle()
  const key = (await openSecret(keyRow?.api_key, providerSecretContext(accountId, 'hyperbrowser'))) || NEMO_HB_KEY
  if (!key) return json({ ok: false, code: 'NO_KEY', message: 'Браузер-агент временно недоступен (провайдер не настроен).' }, 200)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? 'run')

  if (action === 'status') {
    const jobId = String(body?.job_id ?? '')
    if (!jobId) return json({ ok: false, error: 'job_id required' }, 200)
    const s = await pollBrowserTask(key, jobId)
    return json({ ok: s.status !== 'error', status: s.status, result: s.result, error: s.error })
  }

  // run
  const url = String(body?.url ?? '').trim()
  const rawTask = String(body?.task ?? '').trim()
  if (rawTask.length < 5) return json({ ok: false, error: 'Опишите задачу для агента (что сделать на сайте).' }, 200)
  if (looksAbusive(rawTask)) return json({ ok: false, error: 'Задача похожа на нарушение правил сайтов (массовая регистрация / обход защит). Такое не выполняем.' }, 200)
  // included in subscription, fair-use gated (admins exempt)
  if (!prof?.is_admin) {
    if (!plan.media) return json({ ok: false, code: 'PLAN', message: 'Браузер-агент входит в тариф Starter и выше.' }, 200)
    const used = await monthlyBrowser(admin, accountId)
    if (used >= plan.browserMonthly) return json({ ok: false, code: 'LIMIT', message: `Лимит браузер-задач по тарифу (${plan.browserMonthly}/мес) исчерпан.` }, 200)
  }

  const task = (url ? `Open ${url}. ` : '') + rawTask +
    '\nRules: act only within this single task, use only the data provided by the user, do not create extra accounts, do not attempt to bypass CAPTCHAs or security. If a CAPTCHA or login you cannot pass appears, stop and report what is needed.'

  const out = await runBrowserTask(key, task, 100000)
  await admin.from('tool_runs').insert({ account_id: accountId, tool: 'browser_task', args: redactValue({ url, task: rawTask.slice(0, 500) }), result: redactText(out.result ?? out.error ?? (out.pending ? 'running' : '')).slice(0, 1000), ok: out.ok })
  if (out.pending) return json({ ok: true, pending: true, job_id: out.jobId, message: 'Агент ещё работает в браузере — проверьте статус позже.' })
  return out.ok ? json({ ok: true, result: out.result, job_id: out.jobId }) : json({ ok: false, error: out.error }, 200)
})
