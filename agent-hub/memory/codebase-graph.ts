import { z } from 'zod'

export const CodebaseNodeSchema = z.object({
  id: z.string().min(1).max(240).regex(/^[A-Za-z0-9_./:-]+$/),
  type: z.enum(['File', 'Table', 'RPC', 'Contract']),
  name: z.string().min(1).max(240),
  summary: z.string().max(2_000).default(''),
  path: z.string().max(512).optional(),
  tags: z.array(z.string().min(1).max(80)).max(32).default([]),
}).strict()

export const CodebaseEdgeSchema = z.object({
  source: z.string().min(1).max(240),
  target: z.string().min(1).max(240),
  type: z.enum(['imports', 'depends_on', 'queries']),
}).strict()

export type CodebaseNode = z.infer<typeof CodebaseNodeSchema>
export type CodebaseEdge = z.infer<typeof CodebaseEdgeSchema>

export interface RelevantCodebaseContext {
  nodes: CodebaseNode[]
  edges: CodebaseEdge[]
}

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
}
