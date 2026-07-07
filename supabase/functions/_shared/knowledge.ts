// Real RAG for the per-agent knowledge base.
// Documents are chunked and embedded with Supabase's built-in `gte-small` model
// (384-dim, runs IN the Edge runtime — no external key, no extra cost). At query
// time we embed the user's message and pull the most semantically-relevant chunks
// via pgvector (match_knowledge RPC). Falls back to the old "dump raw docs" behavior
// for agents whose docs haven't been indexed yet, so nothing breaks mid-migration.

// `Supabase.ai` is a global provided by the Supabase Edge runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Supabase: any

/** Embed a piece of text into a 384-dim vector using the built-in gte-small model. */
export async function embedText(text: string): Promise<number[]> {
  const session = new Supabase.ai.Session('gte-small')
  const out = await session.run(text, { mean_pool: true, normalize: true })
  return out as number[]
}

/** Split long text into overlapping chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, size = 900, overlap = 150, maxChunks = 80): string[] {
  const clean = (text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (clean.length <= size) return clean ? [clean] : []
  const paras = clean.split(/\n\n+/)
  const chunks: string[] = []
  let buf = ''
  const push = () => { if (buf.trim()) chunks.push(buf.trim()); }
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > size) {
      push()
      // keep an overlap tail for context continuity
      buf = buf.length > overlap ? buf.slice(buf.length - overlap) + '\n\n' + p : p
      // a single giant paragraph: hard-split it
      while (buf.length > size) { chunks.push(buf.slice(0, size)); buf = buf.slice(size - overlap) }
    } else {
      buf = buf ? buf + '\n\n' + p : p
    }
    if (chunks.length >= maxChunks) break
  }
  push()
  return chunks.slice(0, maxChunks)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function naiveDump(db: any, ownerId: string): Promise<string> {
  const { data: docs } = await db.from('knowledge_docs').select('name, content').eq('owner_id', ownerId).limit(10)
  return (docs ?? []).map((d: any) => `- ${d.name ?? ''}: ${d.content ?? ''}`).join('\n').slice(0, 4000)
}

/**
 * Retrieve the knowledge most relevant to `query` for an agent. Semantic (pgvector)
 * when chunks exist; naive raw-dump fallback otherwise. Never throws.
 */
export async function retrieveKnowledge(db: any, ownerId: string, query: string, k = 6): Promise<string> {
  try {
    const q = (query || '').trim()
    if (q.length < 2) return await naiveDump(db, ownerId)
    const emb = await embedText(q.slice(0, 1600))
    const { data } = await db.rpc('match_knowledge', { p_owner_id: ownerId, p_query: emb, p_k: k })
    if (Array.isArray(data) && data.length) {
      return data.map((r: any) => `- ${String(r.content ?? '').trim()}`).join('\n').slice(0, 4000)
    }
    return await naiveDump(db, ownerId) // no embedded chunks yet
  } catch (_e) {
    return await naiveDump(db, ownerId)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
