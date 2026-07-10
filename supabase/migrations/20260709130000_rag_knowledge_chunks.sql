-- RAG: semantic knowledge base. The chunk/embed/retrieve pipeline was already coded
-- (_shared/knowledge.ts + knowledge-index function) but was dead because this DB side never
-- existed. This adds pgvector, the chunk store, a cosine-match RPC, and the indexes.
create extension if not exists vector;

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid references public.knowledge_docs(id) on delete cascade,
  owner_id uuid not null,           -- the agent id
  owner_type text not null default 'agent',
  content text not null,
  embedding vector(384),            -- gte-small dimensions
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_owner_idx on public.knowledge_chunks (owner_id);
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- Chunks are written by service_role (knowledge-index) and read ONLY through the SECURITY DEFINER
-- RPC below (never directly by the browser). RLS on + no anon/auth policies = locked; service_role
-- bypasses RLS, the definer RPC bypasses RLS.
alter table public.knowledge_chunks enable row level security;

-- Top-k chunks for one owner by cosine similarity. SECURITY DEFINER so it can read the locked
-- table; only service_role may execute it (an authenticated user must NOT be able to pass an
-- arbitrary owner_id and read another account's chunks).
create or replace function public.match_knowledge(p_owner_id uuid, p_query vector(384), p_k int default 6)
returns table(content text, similarity double precision)
language sql stable security definer set search_path = public as $$
  select c.content, 1 - (c.embedding <=> p_query) as similarity
  from public.knowledge_chunks c
  where c.owner_id = p_owner_id and c.embedding is not null
  order by c.embedding <=> p_query
  limit greatest(1, least(p_k, 20))
$$;

revoke all on function public.match_knowledge(uuid, vector, int) from public, anon, authenticated;
grant execute on function public.match_knowledge(uuid, vector, int) to service_role;
