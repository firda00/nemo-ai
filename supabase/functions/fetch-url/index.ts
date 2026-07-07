// Ingest a public URL's text for the knowledge base (RAG). Authenticated.
// Handles plain pages (HTML → stripped text) and shared Google Docs/Sheets/Drive
// links by rewriting them to their export endpoints. NOT a full Drive OAuth sync —
// the doc must be shared "anyone with the link".
//
//   POST /functions/v1/fetch-url   (Authorization: Bearer <user jwt>)
//   body { "url": "https://..." }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { safeFetch } from '../_shared/net.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const MAX = 100_000

// Rewrite common Google share links to a plain-text/CSV export endpoint.
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const host = u.hostname
    if (host === 'docs.google.com') {
      const doc = u.pathname.match(/\/document\/d\/([^/]+)/)
      if (doc) return `https://docs.google.com/document/d/${doc[1]}/export?format=txt`
      const sheet = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
      if (sheet) return `https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv`
      const slide = u.pathname.match(/\/presentation\/d\/([^/]+)/)
      if (slide) return `https://docs.google.com/presentation/d/${slide[1]}/export/txt`
    }
    if (host === 'drive.google.com') {
      const file = u.pathname.match(/\/file\/d\/([^/]+)/) || [null, u.searchParams.get('id')]
      if (file[1]) return `https://drive.google.com/uc?export=download&id=${file[1]}`
    }
    return raw
  } catch {
    return raw
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const db = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const { url } = await req.json().catch(() => ({}))
  const normalized = normalizeUrl(String(url ?? ''))

  try {
    // SSRF-safe: rejects loopback/link-local/private/metadata hosts, re-validates
    // every redirect hop, times out, and caps how much body is read into memory.
    const { res, body } = await safeFetch(
      normalized,
      { headers: { 'User-Agent': 'NemoAI-KnowledgeBot/1.0' } },
      { maxBytes: MAX * 3, timeoutMs: 10_000, maxRedirects: 4 },
    )
    if (!res.ok) return json({ error: `fetch ${res.status}` }, 502)
    const ctype = res.headers.get('content-type') ?? ''
    const content = ctype.includes('text/html') ? htmlToText(body) : body.trim()
    if (!content) return json({ error: 'empty' }, 422)
    return json({ ok: true, content: content.slice(0, MAX) })
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    if (msg === 'invalid_url' || msg === 'invalid_protocol') return json({ error: 'invalid url' }, 400)
    if (msg === 'blocked_host') return json({ error: 'blocked host' }, 403)
    console.error('fetch-url error:', e)
    return json({ error: 'fetch_failed' }, 502)
  }
})
