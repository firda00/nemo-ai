import { z } from 'zod'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const CodebaseNodeSchema = z.object({
  id: z.string().min(1).max(240).regex(/^[A-Za-z0-9_./:-]+$/),
  type: z.enum(['File', 'Migration', 'Table', 'RPC', 'Policy', 'Contract', 'Worker']),
  name: z.string().min(1).max(240),
  summary: z.string().max(2_000).default(''),
  path: z.string().max(512).optional(),
  tags: z.array(z.string().min(1).max(80)).max(32).default([]),
}).strict()

export const CodebaseEdgeSchema = z.object({
  source: z.string().min(1).max(240),
  target: z.string().min(1).max(240),
  type: z.enum(['imports', 'depends_on', 'queries', 'defines', 'calls', 'enforces']),
}).strict()

export type CodebaseNode = z.infer<typeof CodebaseNodeSchema>
export type CodebaseEdge = z.infer<typeof CodebaseEdgeSchema>

export interface RelevantCodebaseContext {
  nodes: CodebaseNode[]
  edges: CodebaseEdge[]
}

export interface DependencyPath { nodes: CodebaseNode[]; edges: CodebaseEdge[] }

function terms(value: string): string[] {
  return [...new Set(value.slice(0, 16_384).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((term) => term.length >= 2))]
}

export class CodebaseKnowledgeGraph {
  readonly nodes: readonly CodebaseNode[]
  readonly edges: readonly CodebaseEdge[]
  private readonly byId: Map<string, CodebaseNode>
  private readonly related = new Map<string, Set<string>>()

  constructor(rawNodes: readonly CodebaseNode[], rawEdges: readonly CodebaseEdge[]) {
    const nodes = z.array(CodebaseNodeSchema).max(100_000).parse(rawNodes)
    const edges = z.array(CodebaseEdgeSchema).max(500_000).parse(rawEdges)
    this.byId = new Map(nodes.map((node) => [node.id, node]))
    if (this.byId.size !== nodes.length) throw new Error('CODEBASE_GRAPH_DUPLICATE_NODE')
    for (const edge of edges) {
      if (!this.byId.has(edge.source) || !this.byId.has(edge.target)) throw new Error('CODEBASE_GRAPH_DANGLING_EDGE')
      const forward = this.related.get(edge.source) ?? new Set<string>()
      const reverse = this.related.get(edge.target) ?? new Set<string>()
      forward.add(edge.target)
      reverse.add(edge.source)
      this.related.set(edge.source, forward)
      this.related.set(edge.target, reverse)
    }
    this.nodes = Object.freeze(nodes.map((node) => Object.freeze({ ...node, tags: Object.freeze([...node.tags]) }) as CodebaseNode))
    this.edges = Object.freeze(edges.map((edge) => Object.freeze({ ...edge })))
  }

  findRelevantContext(query: string, maxNodes = 12): RelevantCodebaseContext {
    const boundedMax = Number.isFinite(maxNodes) ? Math.min(100, Math.max(1, Math.trunc(maxNodes))) : 12
    const queryTerms = terms(query).slice(0, 64)
    if (!queryTerms.length) return { nodes: [], edges: [] }
    const scored = this.nodes.map((node) => {
      const name = `${node.id} ${node.name} ${node.tags.join(' ')}`.toLowerCase()
      const body = `${node.summary} ${node.path ?? ''}`.toLowerCase()
      const score = queryTerms.reduce((sum, term) => sum + (name.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0)
      return { node, score }
    }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))

    const selected = new Set(scored.slice(0, boundedMax).map(({ node }) => node.id))
    const queue = [...selected]
    while (queue.length && selected.size < boundedMax) {
      const current = queue.shift()!
      for (const neighbor of [...(this.related.get(current) ?? [])].sort()) {
        if (selected.has(neighbor)) continue
        selected.add(neighbor)
        queue.push(neighbor)
        if (selected.size >= boundedMax) break
      }
    }
    const nodes = this.nodes.filter((node) => selected.has(node.id)).slice(0, boundedMax)
    const finalIds = new Set(nodes.map((node) => node.id))
    return {
      nodes,
      edges: this.edges.filter((edge) => finalIds.has(edge.source) && finalIds.has(edge.target)),
    }
  }

  findDependencyPath(source: string, target: string, maxDepth = 8): DependencyPath | null {
    if (!this.byId.has(source) || !this.byId.has(target)) return null
    const queue: Array<{ id: string; path: string[] }> = [{ id: source, path: [source] }]
    const visited = new Set([source])
    while (queue.length) {
      const current = queue.shift()!
      if (current.id === target) {
        const ids = new Set(current.path)
        return { nodes: current.path.map((id) => this.byId.get(id)!), edges: this.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }
      }
      if (current.path.length > Math.min(32, Math.max(1, maxDepth))) continue
      for (const neighbor of [...(this.related.get(current.id) ?? [])].sort()) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor); queue.push({ id: neighbor, path: [...current.path, neighbor] })
      }
    }
    return null
  }
}

function sqlName(raw: string): string { return raw.replace(/"/g, '').toLowerCase() }
function addNode(nodes: Map<string, CodebaseNode>, node: CodebaseNode): void { if (!nodes.has(node.id)) nodes.set(node.id, node) }

/** Build the repository graph from migrations plus workers without executing or importing either. */
export async function indexCodebaseGraph(repoRoot: string): Promise<CodebaseKnowledgeGraph> {
  const nodes = new Map<string, CodebaseNode>()
  const edgeKeys = new Set<string>()
  const edges: CodebaseEdge[] = []
  const addEdge = (edge: CodebaseEdge) => { const key = `${edge.source}|${edge.type}|${edge.target}`; if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push(edge) } }
  const migrationDir = path.join(repoRoot, 'supabase', 'migrations')
  const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort()
  for (const filename of migrations) {
    const sql = await readFile(path.join(migrationDir, filename), 'utf8')
    const migrationId = `migration:${filename.replace(/\.sql$/, '')}`
    addNode(nodes, { id: migrationId, type: 'Migration', name: filename, summary: 'Supabase SQL migration', path: `supabase/migrations/${filename}`, tags: ['migration'] })
    for (const match of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)/gi)) {
      const name = sqlName(match[1]); const id = `table:${name}`
      addNode(nodes, { id, type: 'Table', name, summary: `PostgreSQL table ${name}`, tags: name.split('.') })
      addEdge({ source: migrationId, target: id, type: 'defines' })
    }
    const functions: Array<{ id: string; start: number }> = []
    for (const match of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w".]+)/gi)) {
      const name = sqlName(match[1]); const id = `rpc:${name}`
      addNode(nodes, { id, type: 'RPC', name, summary: `PostgreSQL function ${name}`, tags: ['rpc', ...name.split('.')] })
      addEdge({ source: migrationId, target: id, type: 'defines' }); functions.push({ id, start: match.index ?? 0 })
    }
    for (const match of sql.matchAll(/create\s+policy\s+"?([^"\n]+?)"?\s+on\s+([\w".]+)/gi)) {
      const table = sqlName(match[2]); const tableId = `table:${table}`; const id = `policy:${filename}:${makeSafeId(match[1])}`
      addNode(nodes, { id, type: 'Policy', name: match[1].trim(), summary: `RLS policy on ${table}`, tags: ['rls', table] })
      addNode(nodes, { id: tableId, type: 'Table', name: table, summary: `Referenced PostgreSQL table ${table}`, tags: table.split('.') })
      addEdge({ source: migrationId, target: id, type: 'defines' }); addEdge({ source: id, target: tableId, type: 'enforces' })
    }
    for (let index = 0; index < functions.length; index += 1) {
      const section = sql.slice(functions[index].start, functions[index + 1]?.start ?? sql.length)
      for (const match of section.matchAll(/\b(?:from|into|update|join)\s+([\w".]+)/gi)) {
        const name = sqlName(match[1]); if (!name.includes('.')) continue
        const id = `table:${name}`; addNode(nodes, { id, type: 'Table', name, summary: `Referenced PostgreSQL table ${name}`, tags: name.split('.') })
        addEdge({ source: functions[index].id, target: id, type: 'queries' })
      }
    }
  }
  const workerDir = path.join(repoRoot, 'agent-hub', 'workers')
  for (const filename of (await readdir(workerDir)).filter((name) => name.endsWith('.ts')).sort()) {
    const source = await readFile(path.join(workerDir, filename), 'utf8'); const workerId = `worker:${filename.replace(/\.ts$/, '')}`
    addNode(nodes, { id: workerId, type: 'Worker', name: filename, summary: 'Durable compute worker', path: `agent-hub/workers/${filename}`, tags: ['worker'] })
    for (const match of source.matchAll(/runtime_[a-z0-9_]+/gi)) {
      const name = `public.${match[0].toLowerCase()}`; const rpcId = `rpc:${name}`
      if (nodes.has(rpcId)) addEdge({ source: workerId, target: rpcId, type: 'calls' })
    }
  }
  return new CodebaseKnowledgeGraph([...nodes.values()], edges)
}

function makeSafeId(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').slice(0, 120) }
