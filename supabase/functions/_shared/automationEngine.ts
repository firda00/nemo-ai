// Shared automation executor — runs an ordered chain of steps (agent / http / notify), threading
// data between them. Used by the panel (manual run) and the public webhook trigger.
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from './llm.ts'
import { safeFetch } from './net.ts'
import { tgSend } from './telegram.ts'
import { blocksExternalActions } from './productionE2E.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
// {{name}} templating against a flat vars map (input + step outputs by name/index)
const interp = (tpl: unknown, vars: Record<string, string>) => String(tpl ?? '').replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : ''))

export async function runAutomation(db: any, accountId: string, apiKey: string, steps: any[], input: string, tgToken?: string, notifyChat?: string) {
  const vars: Record<string, string> = { input: String(input ?? '') }
  const log: { step: string; type: string; ok: boolean; output: string }[] = []
  const externalBlocked = await blocksExternalActions(db, accountId)
  let i = 0
  for (const st of (Array.isArray(steps) ? steps : []).slice(0, 8)) {
    i++
    const name = String(st?.name || `step${i}`)
    const type = String(st?.type || 'agent')
    let ok = true, output = ''
    try {
      if (externalBlocked && (type === 'http' || type === 'notify')) {
        ok = false
        output = 'External automation steps are disabled for the isolated production test account.'
      } else
      if (type === 'http') {
        const url = interp(st.url, vars)
        const method = String(st.method || 'GET').toUpperCase()
        const headers: Record<string, string> = { 'User-Agent': 'NemoAutomation/1.0' }
        for (const [k, v] of Object.entries(st.headers ?? {})) headers[k] = interp(v, vars)
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? interp(typeof st.body === 'string' ? st.body : JSON.stringify(st.body ?? {}), vars) : undefined
        if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
        const { res, body: text } = await safeFetch(url, { method, headers, body }, { maxBytes: 200_000, timeoutMs: 15_000 })
        ok = res.status < 400
        output = String(text).replace(/\s+/g, ' ').trim().slice(0, 1200)
      } else if (type === 'notify') {
        output = interp(st.text ?? st.message ?? '', vars)
        const chat = interp(st.chat ?? '', vars) || notifyChat
        if (tgToken && chat) { ok = await tgSend(tgToken, String(chat), output); output = ok ? `sent → ${chat}` : 'telegram rejected' }
      } else {
        const r = await callOpenRouter({
          apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.5, maxTokens: 800,
          messages: [
            { role: 'system', content: 'You are one step in an automation. Do EXACTLY the instruction using the provided context. Output only the result (no preamble).' },
            { role: 'user', content: `Instruction: ${interp(st.instruction ?? st.prompt ?? '', vars)}\n\nContext:\n${JSON.stringify(vars).slice(0, 3000)}` },
          ],
        })
        output = String(r.content ?? '').trim()
      }
    } catch (e) { ok = false; output = `error: ${String(e).slice(0, 200)}` }
    vars[name] = output
    vars[`step${i}`] = output
    log.push({ step: name, type, ok, output: output.slice(0, 600) })
  }
  return log
}
