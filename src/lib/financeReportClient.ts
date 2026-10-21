import { z } from 'zod'
import { supabase } from './supabase'
import { CashFlowAnalyticsOutputSchema, FinanceTransactionSchema } from '../../supabase/functions/_shared/financeCashFlow'
import { FinanceSelectionSchema } from '../../supabase/functions/_shared/financeSelection'
import { calculateCashFlow } from '../../supabase/functions/_shared/financeAnalyzer'
import { FinanceAnalyzeApiInputSchema } from '../../supabase/functions/_shared/financeIngestion'
import { readBytesBounded } from '../../supabase/functions/_shared/boundedBody'

const ResultSchema = z.object({ analysis: CashFlowAnalyticsOutputSchema, transactions: z.array(FinanceTransactionSchema).min(1).max(10_000), selection: FinanceSelectionSchema })
export type FinanceReportResult = z.infer<typeof ResultSchema>
export class FinanceReportError extends Error {
  readonly code: string
  readonly details: string[]
  constructor(code: string, details: string[] = []) { super(code); this.code = code; this.details = details }
}
interface Scope { userId: string; signal: AbortSignal; alive: () => boolean }
interface Deps {
  session: () => Promise<{ userId: string; token: string } | null>
  fetch: typeof fetch
  timeoutMs: number
}
export async function requestFinanceReport(raw: unknown, scope: Scope, overrides: Partial<Deps> = {}): Promise<FinanceReportResult> {
  const request = FinanceAnalyzeApiInputSchema.parse(raw)
  const deps: Deps = { session: async () => {
    const session = (await supabase?.auth.getSession())?.data.session
    return session ? { userId: session.user.id, token: session.access_token } : null
  }, fetch: (...args) => fetch(...args), timeoutMs: 90_000, ...overrides }
  const controller = new AbortController()
  let failureCode: 'CANCELLED' | 'TIMEOUT' | null = null
  const check = () => { if (!scope.alive() || scope.signal.aborted || controller.signal.aborted) throw new FinanceReportError('CANCELLED') }
  let expire: (error: Error) => void = () => {}
  const cancelled = new Promise<never>((_, reject) => { expire = reject })
  cancelled.catch(() => {})
  const cancel = () => { failureCode = 'CANCELLED'; expire(new FinanceReportError('CANCELLED')); controller.abort() }
  scope.signal.addEventListener('abort', cancel, { once: true })
  const deadlineAt = Date.now() + deps.timeoutMs
  const timer = setTimeout(() => { failureCode = 'TIMEOUT'; expire(new FinanceReportError('TIMEOUT')); controller.abort() }, deps.timeoutMs)
  try {
    check()
    const session = await Promise.race([deps.session(), cancelled])
    check()
    if (!session || session.userId !== scope.userId) throw new FinanceReportError('UNAUTHORIZED')
    const response = await Promise.race([deps.fetch('/api/finance/analyze-cashflow', {
      method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: controller.signal,
    }), cancelled])
    check()
    const read = await Promise.race([readBytesBounded(response, { maxBytes: 32 * 1024 * 1024, deadlineAt, now: Date.now }), cancelled])
    check()
    if (!read.ok) throw new FinanceReportError('INVALID_RESPONSE')
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes))
    if (!response.ok) {
      const details = Array.isArray(body?.ingestion?.rejected) ? body.ingestion.rejected.slice(0, 20).map((issue: { source_id?: string; location?: string; code?: string }) => `${issue.source_id ?? ''} · ${issue.location ?? ''} · ${issue.code ?? ''}`) : []
      throw new FinanceReportError(typeof body?.code === 'string' ? body.code : 'ANALYSIS_FAILED', details)
    }
    const result = ResultSchema.parse(body)
    if (Date.parse(result.analysis.period.from) !== Date.parse(request.period.from) || Date.parse(result.analysis.period.to) !== Date.parse(request.period.to) || result.analysis.currency !== request.base_currency || result.selection.included_count !== result.transactions.length) throw new FinanceReportError('INVALID_RESPONSE')
    const includedIds = result.selection.audit.filter(r => r.decision === 'included').map(r => r.transaction_id).sort()
    if (JSON.stringify(includedIds) !== JSON.stringify(result.transactions.map(t => t.transaction_id).sort()) || result.transactions.some(t => t.status !== 'posted' || Date.parse(t.occurred_at) < Date.parse(request.period.from) || Date.parse(t.occurred_at) >= Date.parse(request.period.to))) throw new FinanceReportError('INVALID_RESPONSE')
    const expected = calculateCashFlow({ workspace_id: request.workspace_id, period: request.period, base_currency: request.base_currency, opening_balance_minor: request.opening_balance_minor, transactions: result.transactions, business_objectives: request.business_objectives })
    if (JSON.stringify(expected.summary) !== JSON.stringify(result.analysis.summary)) throw new FinanceReportError('INVALID_RESPONSE')
    check()
    return result
  } catch (error) {
    if (failureCode) throw new FinanceReportError(failureCode)
    if (error instanceof FinanceReportError) throw error
    throw new FinanceReportError('INVALID_RESPONSE')
  } finally { clearTimeout(timer); scope.signal.removeEventListener('abort', cancel) }
}
