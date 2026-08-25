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
}).strict()

export type SubagentTask = z.infer<typeof SubagentTaskSchema>

export type SubagentExecutor = (
  task: Readonly<{ id: string; role: AgencyRoleId; input: Readonly<Record<string, unknown>> }>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>

export interface SubagentBranchResult {
  taskId: string
  role: AgencyRoleId
  status: 'completed' | 'failed' | 'timed_out'
  output?: Record<string, unknown>
  errorCode?: 'SUBAGENT_FAILED' | 'SUBAGENT_TIMEOUT' | 'SUBAGENT_RESULT_INVALID'
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

async function executeBranch(task: SubagentTask, executor: SubagentExecutor): Promise<SubagentBranchResult> {
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
      executor(Object.freeze({ id: task.id, role: task.role, input: Object.freeze({ ...task.input }) }), controller.signal),
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
    const branches = await Promise.all(tasks.map((task) => executeBranch(task, this.executor)))
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
