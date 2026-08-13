export interface DagNode {
  status?: string
  depends_on?: number[]
}

export function validateDependencies(value: unknown, index: number): number[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) < index)) return null
  const result = value.map(Number)
  return new Set(result).size === result.length ? result.sort((a, b) => a - b) : null
}

export function dependenciesFor(node: DagNode, index: number): number[] {
  const validated = validateDependencies(node.depends_on, index)
  if (validated) return validated
  return index > 0 ? [index - 1] : []
}

export function readyNodeIndexes(nodes: DagNode[], limit = 3): number[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node, index }) => node.status === 'pending' && dependenciesFor(node, index).every((dependency) => nodes[dependency]?.status === 'done'))
    .slice(0, Math.max(1, limit))
    .map(({ index }) => index)
}

export function blockedByFailedDependencies(nodes: DagNode[]): Map<number, number[]> {
  const blocked = new Map<number, number[]>()
  let changed = true
  while (changed) {
    changed = false
    nodes.forEach((node, index) => {
      if (node.status !== 'pending' || blocked.has(index)) return
      const causes = dependenciesFor(node, index).filter((dependency) => nodes[dependency]?.status === 'failed' || blocked.has(dependency))
      if (causes.length) { blocked.set(index, causes); changed = true }
    })
  }
  return blocked
}
