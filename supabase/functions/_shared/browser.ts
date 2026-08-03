// Browser agent via Hyperbrowser's browser-use task API. The agent is given a
// natural-language task ("go to X, fill the form with …") and drives a real hosted
// browser itself. Runs on the account's OWN Hyperbrowser key. Async: create → poll.
//
// GUARDRAILS: this is for tasks the USER authorized, with the user's OWN data
// (fill a form, submit an application, post a listing, gather info). It must NOT be
// used for mass account creation, CAPTCHA bypass, or anything against a site's ToS —
// callers reject such tasks before calling here.
const BASE = Deno.env.get('HYPERBROWSER_BASE') ?? 'https://api.hyperbrowser.ai/api'
// the browser-use agent needs a strong model to emit valid action JSON; the provider's
// default is flaky ("Could not parse response"), so we pin a capable one.
const BROWSER_LLM = Deno.env.get('BROWSER_LLM') ?? 'gpt-4o'
const READ_ONLY_MARKETPLACE_HOSTS = new Set(['uzum.uz', 'seller.uzum.uz'])

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function createBrowserTask(key: string, task: string): Promise<{ jobId?: string; error?: string }> {
  try {
    const r = await fetch(`${BASE}/task/browser-use`, {
      method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: `${task}\nSafety contract: read data only. Do not log in, enter credentials, fill or submit forms, publish, change listings, buy, pay, delete, or create accounts.`, maxSteps: 20, llm: BROWSER_LLM }),
    })
    const d = await r.json()
    const jobId = d?.jobId ?? d?.id ?? d?.data?.jobId
    if (!jobId) return { error: d?.message ?? d?.error ?? `Hyperbrowser ${r.status}` }
    return { jobId: String(jobId) }
  } catch (e) { return { error: String(e).slice(0, 160) } }
}

export async function pollBrowserTask(key: string, jobId: string): Promise<{ status: string; result?: string; error?: string }> {
  try {
    const r = await fetch(`${BASE}/task/browser-use/${jobId}`, { headers: { 'x-api-key': key } })
    const d = await r.json()
    const status = String(d?.status ?? 'unknown')
    const result = d?.data?.finalResult ?? d?.data?.result ?? (typeof d?.data === 'string' ? d.data : '')
    return { status, result: result ? String(result) : undefined, error: d?.error ?? d?.data?.error }
  } catch (e) { return { status: 'error', error: String(e).slice(0, 160) } }
}

// Create + poll up to maxMs. Returns the result, or pending+jobId if it's still running.
export async function runBrowserTask(key: string, task: string, maxMs = 90000): Promise<{ ok: boolean; result?: string; jobId?: string; pending?: boolean; error?: string }> {
  const c = await createBrowserTask(key, task)
  if (!c.jobId) return { ok: false, error: c.error }
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 6000))
    const s = await pollBrowserTask(key, c.jobId)
    if (s.status === 'completed') return { ok: true, result: s.result ?? 'Готово', jobId: c.jobId }
    if (s.status === 'failed' || s.status === 'error') return { ok: false, error: s.error ?? 'Задача не выполнена', jobId: c.jobId }
  }
  return { ok: true, pending: true, jobId: c.jobId }
}

// light abuse filter — reject obviously ToS-violating tasks before spending a browser run
export function looksAbusive(task: string): boolean {
  return /(масс\w*|множеств\w*|\b\d{2,}\b[^.]{0,25}(аккаунт|регистрац))|обойти\s*капч|bypass\s*captcha|captcha\s*solv|накрут\w*|(scrap\w*|спарс\w*)[^.]{0,30}(email|почт)[^.]{0,30}(спам|рассыл)|credential\s*stuff/i.test(task)
}

/**
 * Browser automation begins as a marketplace audit tool. External writes are
 * held until the owner-facing approval queue exists, so prompts cannot turn a
 * "research" task into a listing, payment, or account action.
 */
export function validateReadOnlyMarketplaceBrowserTask(url: string, task: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'Укажите полный HTTPS URL marketplace-сайта.' }
  if (parsed.protocol !== 'https:' || !READ_ONLY_MARKETPLACE_HOSTS.has(parsed.hostname)) {
    return 'Browser audit сейчас доступен только для uzum.uz и seller.uzum.uz.'
  }
  if (looksAbusive(task)) return 'Задача нарушает правила сайтов (массовая регистрация, обход защит или сбор контактов) — не выполняем.'
  if (/(войти|логин|авториз|парол|credential|log\s*in|sign\s*in|submit|отправ|заполн|опубли|размест|созда|измен|обнов|удал|куп|заказ|оплат|payment|checkout|upload|загруз)/i.test(task)) {
    return 'Это действие требует owner approval. Пока approval queue не внедрён, Browser Agent выполняет только read-only аудит.'
  }
  return null
}
/* eslint-enable @typescript-eslint/no-explicit-any */
