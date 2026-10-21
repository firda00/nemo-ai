export { classifyChatEntityIntent } from '../../src/lib/chatEntityFactory.ts'
export async function createEntityFromChat(prompt: string) {
  const g = globalThis as unknown as { __creationPrompts?: string[] }
  ;(g.__creationPrompts ??= []).push(prompt)
  return { kind: 'team', id: 'synthetic-team', name: 'Synthetic team', goal: prompt, members: [] }
}
