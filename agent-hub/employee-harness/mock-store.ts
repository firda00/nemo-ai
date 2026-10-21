// This UI probe mocks the store boundary. Actual Supabase insert/retry behavior is
// verified by the employee-catalog owner's separate store tests, not this fixture.
import type { PlatformAgent } from '../../src/types/platform'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__employeeCalls = []
g.__employeePending = []
g.__employeeSaveMode = 'error'
export const blankAgent = () => ({ id: 'unsaved', status: 'active', channels: ['must-be-cleared'], actionPolicy: 'read_only' }) as unknown as PlatformAgent
async function addAgent(draft: PlatformAgent) {
  g.__employeeCalls.push(JSON.parse(JSON.stringify(draft)))
  if (g.__employeeSaveMode === 'hold') return new Promise<{ id: string; error?: string }>(resolve => { g.__employeePending.push(resolve) })
  if (g.__employeeSaveMode === 'throw') throw new Error('Synthetic save failure')
  return g.__employeeSaveMode === 'success' ? { id: 'returned-persisted-id' } : { id: '', error: 'Synthetic ambiguous save' }
}
export const useAgentStore = <T,>(selector: (state: { addAgent: typeof addAgent }) => T): T => selector({ addAgent })
