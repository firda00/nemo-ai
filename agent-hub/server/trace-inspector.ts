import { z } from 'zod'

const UuidSchema = z.string().uuid()

export interface TraceRpcTransport {
  rpc<T = unknown>(name: string, args: Record<string, unknown>): PromiseLike<{
    data: T | null
    error: { code?: string; message?: string } | null
  }>
}

export interface WorkflowTrace {
  workflow: Record<string, unknown>
  transitions: Array<Record<string, unknown>>
  compute_jobs: Array<Record<string, unknown>>
  outbox_actions: Array<Record<string, unknown>>
  self_healing_iterations: Array<Record<string, unknown>>
}

const WorkflowTraceSchema = z.object({
  workflow: z.record(z.unknown()),
  transitions: z.array(z.record(z.unknown())).max(10_000),
  compute_jobs: z.array(z.record(z.unknown())).max(1_000),
  outbox_actions: z.array(z.record(z.unknown())).max(1_000),
  self_healing_iterations: z.array(z.record(z.unknown())).max(1_000),
}).strict()

export class WorkflowTraceInspector {
  private readonly rpc: TraceRpcTransport

  constructor(rpc: TraceRpcTransport) {
    this.rpc = rpc
  }

  async getWorkflowTrace(workflowId: string, accountId: string): Promise<WorkflowTrace> {
    const safeWorkflowId = UuidSchema.parse(workflowId)
    const safeAccountId = UuidSchema.parse(accountId)
    const { data, error } = await this.rpc.rpc('runtime_dashboard_workflow_trace', {
      p_account_id: safeAccountId,
      p_workflow_id: safeWorkflowId,
    })
    if (error || !data) throw new Error(`DASHBOARD_TRACE_UNAVAILABLE:${error?.code ?? 'NOT_FOUND'}`)
    return WorkflowTraceSchema.parse(data)
  }
}

export async function getWorkflowTrace(
  rpc: TraceRpcTransport,
  workflowId: string,
  accountId: string,
): Promise<WorkflowTrace> {
  return new WorkflowTraceInspector(rpc).getWorkflowTrace(workflowId, accountId)
}
