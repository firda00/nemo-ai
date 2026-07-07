// Index a knowledge document into semantic chunks (real RAG).
// Chunks the doc, embeds each chunk with gte-small, stores vectors in knowledge_chunks.
//   POST /functions/v1/knowledge-index  (Bearer jwt)
//     { action:'index',  doc_id }                    -> { ok, chunks }
//     { action:'search', agent_id, query, k? }       -> { ok, results:[{content,similarity}] }  (for testing)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chunkText, embedText } from '../_shared/knowledge.ts'
import { corsHeaders, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/* eslint-disable @typescript-eslint/no-explicit-any */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? 'index')

  // helper: verify an agent belongs to this account
  const ownsAgent = async (agentId: string): Promise<boolean> => {
    if (!agentId) return false
    const { data: ag } = await admin.from('agents').select('account_id').eq('id', agentId).maybeSingle()
    return ag?.account_id === accountId
  }

  if (action === 'index') {
    const docId = String(body?.doc_id ?? '')
    const { data: doc } = await admin.from('knowledge_docs').select('id, owner_id, owner_type, content').eq('id', docId).maybeSingle()
    if (!doc) return json({ ok: false, error: 'Документ не найден.' }, 200)
    if (!(await ownsAgent(doc.owner_id))) return json({ error: 'forbidden' }, 403)

    const chunks = chunkText(String(doc.content ?? ''))
    // replace any previous chunks for this doc
    await admin.from('knowledge_chunks').delete().eq('doc_id', doc.id)
    if (!chunks.length) { await admin.from('knowledge_docs').update({ status: 'empty' }).eq('id', doc.id); return json({ ok: true, chunks: 0 }) }

    let stored = 0
    for (const c of chunks) {
      try {
        const emb = await embedText(c)
        const { error } = await admin.from('knowledge_chunks').insert({ doc_id: doc.id, owner_id: doc.owner_id, owner_type: doc.owner_type ?? 'agent', content: c, embedding: emb })
        if (!error) stored++
      } catch (_e) { /* skip a bad chunk, keep going */ }
    }
    await admin.from('knowledge_docs').update({ status: stored ? 'indexed' : 'error' }).eq('id', doc.id)
    return json({ ok: true, chunks: stored })
  }

  if (action === 'search') {
    const agentId = String(body?.agent_id ?? '')
    if (!(await ownsAgent(agentId))) return json({ error: 'forbidden' }, 403)
    const query = String(body?.query ?? '').trim()
    const k = Math.max(1, Math.min(12, Number(body?.k) || 6))
    if (query.length < 2) return json({ ok: false, error: 'Пустой запрос.' }, 200)
    try {
      const emb = await embedText(query.slice(0, 1600))
      const { data } = await admin.rpc('match_knowledge', { p_owner_id: agentId, p_query: emb, p_k: k })
      return json({ ok: true, results: data ?? [] })
    } catch (e) {
      return json({ ok: false, error: `Ошибка поиска: ${String(e).slice(0, 200)}` }, 200)
    }
  }

  return json({ error: 'unknown action' }, 400)
})
/* eslint-enable @typescript-eslint/no-explicit-any */
