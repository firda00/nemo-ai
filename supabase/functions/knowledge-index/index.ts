// Index a knowledge document into semantic chunks (real RAG).
// Chunks the doc, embeds each chunk with gte-small, stores vectors in knowledge_chunks.
//   POST /functions/v1/knowledge-index  (Bearer jwt)
//     { action:'index',  doc_id }                    -> { ok, chunks }
//     { action:'search', agent_id, query, k? }       -> { ok, results:[{content,similarity}] }  (for testing)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { chunkText, embedText } from '../_shared/knowledge.ts'
import { corsPreflight, json } from '../_shared/cors.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

/* eslint-disable @typescript-eslint/no-explicit-any */
Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? 'index')

  // Service-role backfill: (re)index every doc that has no chunks yet. Gated by the cron secret —
  // no user JWT — used to light up docs that were indexed before the vector schema existed.
  if (action === 'reindex_missing') {
    if (req.headers.get('x-cron-secret') !== (Deno.env.get('CRON_SECRET') ?? '')) return json({ error: 'forbidden' }, 403)
    const { data: docs } = await admin.from('knowledge_docs').select('id, owner_id, owner_type, content')
    let reindexed = 0, chunksTotal = 0
    for (const doc of (docs ?? [])) {
      const { count } = await admin.from('knowledge_chunks').select('id', { count: 'exact', head: true }).eq('doc_id', doc.id)
      if (count && count > 0) continue
      const chunks = chunkText(String(doc.content ?? ''))
      if (!chunks.length) { await admin.from('knowledge_docs').update({ status: 'empty' }).eq('id', doc.id); continue }
      let stored = 0
      for (const c of chunks) { try { const emb = await embedText(c); const { error } = await admin.from('knowledge_chunks').insert({ doc_id: doc.id, owner_id: doc.owner_id, owner_type: doc.owner_type ?? 'agent', content: c, embedding: emb }); if (!error) stored++ } catch { /* skip a bad chunk */ } }
      await admin.from('knowledge_docs').update({ status: stored ? 'indexed' : 'error' }).eq('id', doc.id)
      reindexed++; chunksTotal += stored
    }
    return json({ ok: true, reindexed, chunks: chunksTotal })
  }

  // Service-role retrieval test: embed a question and run match_knowledge for an agent (cron-gated).
  if (action === 'search_admin') {
    if (req.headers.get('x-cron-secret') !== (Deno.env.get('CRON_SECRET') ?? '')) return json({ error: 'forbidden' }, 403)
    const agentId = String(body?.agent_id ?? '')
    const query = String(body?.query ?? '').trim()
    if (!agentId || query.length < 2) return json({ ok: false, error: 'agent_id + query required' }, 200)
    const emb = await embedText(query.slice(0, 1600))
    const { data } = await admin.rpc('match_knowledge', { p_owner_id: agentId, p_query: emb, p_k: 5 })
    return json({ ok: true, results: data ?? [] })
  }

  // --- user-authed actions (index / search) ---
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  // helper: verify an agent belongs to this account
  const ownsAgent = async (agentId: string): Promise<boolean> => {
    if (!agentId) return false
    const { data: ag } = await admin.from('agents').select('account_id').eq('id', agentId).maybeSingle()
    return ag?.account_id === accountId
  }
  // helper: verify a department (team knowledge owner) belongs to this account
  const ownsDepartment = async (departmentId: string): Promise<boolean> => {
    if (!departmentId) return false
    const { data: dep } = await admin.from('departments').select('account_id').eq('id', departmentId).maybeSingle()
    return dep?.account_id === accountId
  }

  if (action === 'index') {
    const docId = String(body?.doc_id ?? '')
    const { data: doc } = await admin.from('knowledge_docs').select('id, owner_id, owner_type, content').eq('id', docId).maybeSingle()
    if (!doc) return json({ ok: false, error: 'Документ не найден.' }, 200)
    const owned = doc.owner_type === 'team' ? await ownsDepartment(doc.owner_id) : await ownsAgent(doc.owner_id)
    if (!owned) return json({ error: 'forbidden' }, 403)

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
