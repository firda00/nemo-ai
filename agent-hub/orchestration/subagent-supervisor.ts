import { z } from 'zod'
import { AgencyRoleIdSchema, type AgencyRoleId } from '../skills/agency-roles.ts'

const MAX_BRANCHES = 16
const MAX_RESULT_BYTES = 64 * 1024
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const BoundedRecordSchema = z.record(z.unknown()).superRefine((value, context) => {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RESULT_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'subagent input exceeds 64 KiB' })
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'subagent input must be JSON-serializable' })
  }
})

export const SubagentTaskSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  role: AgencyRoleIdSchema,
  input: BoundedRecordSchema,
  timeoutMs: z.number().int().min(10).max(120_000).default(30_000),
  dependsOn: z.array(z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/)).max(MAX_BRANCHES).default([]),
  dependencyPolicy: z.enum(['all_completed', 'all_settled']).default('all_completed'),
}).strict()

export type SubagentTask = z.infer<typeof SubagentTaskSchema>

export type SubagentExecutor = (
  task: Readonly<{ id: string; role: AgencyRoleId; input: Readonly<Record<string, unknown>>; dependencies: Readonly<Record<string, SubagentBranchResult>> }>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>

export interface SubagentBranchResult {
  taskId: string
  role: AgencyRoleId
  status: 'completed' | 'failed' | 'timed_out' | 'skipped'
  output?: Record<string, unknown>
  errorCode?: 'SUBAGENT_FAILED' | 'SUBAGENT_TIMEOUT' | 'SUBAGENT_RESULT_INVALID' | 'SUBAGENT_DEPENDENCY_FAILED'
}

export interface SupervisorArtifact {
  merged: Record<string, unknown>
  branches: SubagentBranchResult[]
}

function safeResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SUBAGENT_RESULT_INVALID')
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error('SUBAGENT_RESULT_INVALID')
    output[key] = entry
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_RESULT_BYTES) throw new Error('SUBAGENT_RESULT_INVALID')
  } catch {
    throw new Error('SUBAGENT_RESULT_INVALID')
  }
  return output
}

async function executeBranch(task: SubagentTask, dependencies: Record<string, SubagentBranchResult>, executor: SubagentExecutor): Promise<SubagentBranchResult> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('SUBAGENT_TIMEOUT'))
    }, task.timeoutMs)
  })
  try {
    const output = safeResult(await Promise.race([
      executor(Object.freeze({ id: task.id, role: task.role, input: Object.freeze({ ...task.input }), dependencies: Object.freeze({ ...dependencies }) }), controller.signal),
      timeout,
    ]))
    return { taskId: task.id, role: task.role, status: 'completed', output }
  } catch (error) {
    const code = timedOut || (error instanceof Error && error.message === 'SUBAGENT_TIMEOUT')
      ? 'SUBAGENT_TIMEOUT'
      : error instanceof Error && error.message === 'SUBAGENT_RESULT_INVALID'
        ? 'SUBAGENT_RESULT_INVALID'
        : 'SUBAGENT_FAILED'
    return { taskId: task.id, role: task.role, status: code === 'SUBAGENT_TIMEOUT' ? 'timed_out' : 'failed', errorCode: code }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class SubagentSupervisor {
  private readonly executor: SubagentExecutor

  constructor(executor: SubagentExecutor) {
    this.executor = executor
  }

  async run(rawTasks: readonly SubagentTask[]): Promise<SupervisorArtifact> {
    const tasks = z.array(SubagentTaskSchema).min(1).max(MAX_BRANCHES).parse(rawTasks)
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error('SUBAGENT_TASK_ID_DUPLICATE')
    const ids = new Set(tasks.map((task) => task.id))
    for (const task of tasks) {
      if (new Set(task.dependsOn).size !== task.dependsOn.length || task.dependsOn.includes(task.id)) throw new Error('SUBAGENT_DAG_INVALID')
      if (task.dependsOn.some((dependency) => !ids.has(dependency))) throw new Error('SUBAGENT_DAG_UNKNOWN_DEPENDENCY')
    }
    const pending = new Set(tasks.map((task) => task.id))
    const results = new Map<string, SubagentBranchResult>()
    while (pending.size) {
      const ready = tasks.filter((task) => pending.has(task.id) && task.dependsOn.every((dependency) => results.has(dependency)))
      if (!ready.length) throw new Error('SUBAGENT_DAG_CYCLE')
      const wave = await Promise.all(ready.map(async (task) => {
        const dependencies = Object.fromEntries(task.dependsOn.map((id) => [id, results.get(id)!]))
        if (task.dependencyPolicy === 'all_completed' && Object.values(dependencies).some((dependency) => dependency.status !== 'completed')) {
          return { taskId: task.id, role: task.role, status: 'skipped', errorCode: 'SUBAGENT_DEPENDENCY_FAILED' } as SubagentBranchResult
        }
        return await executeBranch(task, dependencies, this.executor)
      }))
      for (const branch of wave) { results.set(branch.taskId, branch); pending.delete(branch.taskId) }
    }
    const branches = tasks.map((task) => results.get(task.id)!)
    // Merge only after every branch settles, in caller-defined order. Completion timing cannot
    // change the winner for a shallow-key collision.
    const merged: Record<string, unknown> = {}
    for (const branch of branches) {
      if (branch.status !== 'completed' || !branch.output) continue
      Object.assign(merged, branch.output)
    }
    return { merged, branches }
  }
}
