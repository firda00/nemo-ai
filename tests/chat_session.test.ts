import { expect, test } from 'vitest'
import { readChatSession, writeChatSession, type SavedChat } from '../src/lib/chatSession'

const sample = (): SavedChat => ({ turns: [{ id: 2, role: 'user', text: 'Synthetic name', direct: true }, { id: 3, role: 'assistant', text: 'Synthetic reply', direct: true }], discovery: null, model: 'fast', effort: 'low', historyFrom: 0 })
function storage() {
  const map = new Map<string, string>()
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, map }
}
test('round trip retains plain conversation, selection and intake', () => {
  const store = storage(), value = sample()
  value.discovery = { step: 'channels', goal: 'Synthetic task', initialRequest: 'Synthetic request', requestedKind: 'team' }
  value.model = 'gpt-6-astra'; value.effort = 'max'; value.continuation = 'synthetic-encrypted-context'
  expect(writeChatSession('origin:account-a:user-a', value, store)).toBe(true)
  expect(readChatSession('origin:account-a:user-a', store)).toEqual(value)
})
test('both organization and user are part of the storage identity', () => {
  const store = storage()
  writeChatSession('origin:account-a:user-a', sample(), store)
  expect(readChatSession('origin:account-b:user-a', store).turns).toEqual([])
  expect(readChatSession('origin:account-a:user-b', store).turns).toEqual([])
})
test('oversized text cannot be reported as successfully saved', () => {
  const store = storage(), value = sample()
  value.turns[1].text = 'x'.repeat(20_001)
  expect(writeChatSession('scope', value, store)).toBe(false)
  expect(store.map.size).toBe(0)
})
test('maximum allowed text restores intact', () => {
  const store = storage(), value = sample()
  value.turns[1].text = 'x'.repeat(20_000)
  expect(writeChatSession('scope', value, store)).toBe(true)
  expect(readChatSession('scope', store)).toEqual(value)
})
test('quota failure is explicit', () => {
  expect(writeChatSession('scope', sample(), { setItem() { throw new Error('quota') } })).toBe(false)
})
test('corrupt or foreign storage never restores', () => {
  expect(readChatSession('scope', { getItem: () => '{' }).turns).toEqual([])
  const store = storage(); writeChatSession('scope', sample(), store)
  expect(readChatSession('other', { getItem: () => [...store.map.values()][0] }).turns).toEqual([])
})
test('recovery only returns safe text fields even if stored data contains action objects', () => {
  const value = { version: 1, userId: 'scope', ...sample() }
  Object.assign(value.turns[0], { artifact: 'browser', trialBooking: true, documentJob: { submissionId: 'injected' }, attachments: ['file'] })
  const restored = readChatSession('scope', { getItem: () => JSON.stringify(value) })
  expect(Object.keys(restored.turns[0]).sort()).toEqual(['direct', 'id', 'role', 'text'])
})
