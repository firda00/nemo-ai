import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n'
import { FinanceCashFlowDashboard } from '../../src/components/finance/FinanceCashFlowDashboard'
import { FinanceAnalyzeApiInputSchema } from '../../supabase/functions/_shared/financeIngestion'
import { prepareFinanceAnalysis } from '../../supabase/functions/_shared/financePreparation'
import { assembleCashFlowAnalysis } from '../../supabase/functions/_shared/financeAnalyzer'
import '../../src/index.css'

const g = globalThis as any
g.__financeCalls = []
g.__financeHeld = []
g.__financeMode = 'normal'
g.fetch = async (url: string, init: RequestInit) => {
  if (url !== '/api/finance/analyze-cashflow') throw new Error('Unexpected network: ' + url)
  const input = FinanceAnalyzeApiInputSchema.parse(JSON.parse(String(init.body)))
  const call = { input, headers: init.headers, signal: init.signal }
  g.__financeCalls.push(call)
  const prepared = prepareFinanceAnalysis(input, input.workspace_id)
  const response = prepared.ok ? new Response(JSON.stringify({ analysis: assembleCashFlowAnalysis(prepared.request, { impact_assessments: [], inefficiencies: [], recommendations: [] }), transactions: prepared.transactions, selection: prepared.selection }))
    : new Response(JSON.stringify({ code: prepared.code, ingestion: prepared.ingestion }), { status: prepared.status })
  if (g.__financeMode === 'hold') return new Promise(resolve => g.__financeHeld.push(() => resolve(response)))
  return response
}
const originalText = File.prototype.text
g.__financeHeldReads = []
File.prototype.text = function () {
  if (g.__holdFinanceRead) return new Promise(resolve => g.__financeHeldReads.push(async () => resolve(await originalText.call(this))))
  return originalText.call(this)
}
const root = createRoot(document.getElementById('root')!)
g.__mountFinance = () => root.render(<I18nProvider key={Date.now()}><FinanceCashFlowDashboard /></I18nProvider>)
g.__financeReady = true
