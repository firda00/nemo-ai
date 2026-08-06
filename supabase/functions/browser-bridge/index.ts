// The extension submits only bounded read-only Uzum snapshots with an opaque pairing secret.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { json } from '../_shared/cors.ts'
import { redactText } from '../_shared/redact.ts'

// NOT named URL: that shadowed the global URL constructor with a string, so every
// `new URL(sourceUrl)` threw and each observation was rejected as 'invalid source url'.
// The extension could never submit anything at all.
const PROJECT_URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const HOSTS = new Set(['uzum.uz', 'seller.uzum.uz'])
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } })
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))).map((v) => v.toString(16).padStart(2, '0')).join('')

async function owner(req: Request) {
  const authorization = req.headers.get('Authorization')
  if (!authorization) return null
  const db = createClient(PROJECT_URL, ANON, { global: { headers: { Authorization: authorization } } })
  const { data: { user } } = await db.auth.getUser()
  if (!user) return null
  const { data: profile } = await db.from('users').select('account_id').eq('id', user.id).maybeSingle()
  return profile?.account_id ? { id: user.id, accountId: profile.account_id } : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')
  const admin = createClient(PROJECT_URL, SERVICE)
  if (action === 'observe') {
    const secret = String(body.secret ?? '')
    const sourceUrl = String(body.observation?.url ?? '')
    let parsed: URL
    try { parsed = new URL(sourceUrl) } catch { return reply({ ok: false, error: 'invalid source url' }, 400) }
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname) || secret.length < 32) return reply({ ok: false, error: 'invalid observation' }, 403)
    const { data: pairing } = await admin.from('browser_pairings').select('id, account_id').eq('secret_hash', await hash(secret)).eq('active', true).gt('expires_at', new Date().toISOString()).maybeSingle()
    if (!pairing) return reply({ ok: false, error: 'pairing expired or revoked' }, 401)
    parsed.search = ''
    parsed.hash = ''
    const text = redactText(String(body.observation?.bodyText ?? '').replace(/\s+/g, ' ').trim()).slice(0, 8000)
    if (!text) return reply({ ok: false, error: 'empty observation' }, 400)
    // The extension reports what the page actually held. Say so when the stored copy is short of
    // it: a snapshot that quietly dropped the half the owner needed reads as a complete one, and
    // the last such capture cost a day of reasoning about a tariff that was never in it.
    const totalLength = Number(body.observation?.totalLength)
    const truncated = Number.isFinite(totalLength) && totalLength > text.length
    const now = new Date()
    const { error } = await admin.from('browser_observations').insert({ account_id: pairing.account_id, pairing_id: pairing.id, source_url: parsed.toString().slice(0, 2000), page_title: redactText(String(body.observation?.title ?? '')).slice(0, 300), body_text: text, total_length: Number.isFinite(totalLength) ? Math.max(totalLength, text.length) : text.length, observed_at: now.toISOString(), expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() })
    if (error) return reply({ ok: false, error: 'could not store observation' }, 500)
    await admin.from('browser_pairings').update({ last_seen_at: new Date().toISOString() }).eq('id', pairing.id)
    return reply({ ok: true, stored_characters: text.length, truncated })
  }
  const current = await owner(req)
  if (!current) return json({ error: 'unauthorized' }, 401)
  if (action === 'create') {
    const secret = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
    // Short-lived capability: the code is entered manually into the extension and is never stored by Nemo.
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    const { data, error } = await admin.from('browser_pairings').insert({ account_id: current.accountId, created_by: current.id, secret_hash: await hash(secret), expires_at: expiresAt }).select('id, expires_at').single()
    return error ? json({ error: 'could not create pairing' }, 500) : json({ ok: true, pairing: data, secret })
  }
  if (action === 'revoke') {
    const { error } = await admin.from('browser_pairings').update({ active: false }).eq('id', String(body.pairing_id ?? '')).eq('account_id', current.accountId)
    return error ? json({ error: 'could not revoke pairing' }, 500) : json({ ok: true })
  }
  if (action === 'clear_observations') {
    const { error } = await admin.from('browser_observations').delete().eq('account_id', current.accountId)
    return error ? json({ error: 'could not clear observations' }, 500) : json({ ok: true })
  }
  return json({ error: 'unknown action' }, 400)
})
