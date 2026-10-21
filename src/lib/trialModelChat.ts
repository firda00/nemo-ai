import { supabase } from './supabase'
import { createTrialSessionTokenProvider, type TrialOperation } from './trialBookingClient'

export type TrialChatView = {
  chatId: string; accountId: string; operationKey: string; operation: TrialOperation | null
  mode: string; error?: string; messages: { role: 'user' | 'assistant'; content: string }[]
  acknowledgedMessageIds?: string[]
}
const key = (userId: string) => `nemo:trial-chat:v1:${userId}`
export function hasTrialModelChat(userId: string) { return !!localStorage.getItem(key(userId)) }
export async function trialModelChat(userId: string, text?: string): Promise<TrialChatView> {
  if (!supabase || !import.meta.env.DEV || import.meta.env.VITE_TRIAL_MODEL_CHAT !== '1') throw new Error('LOCAL_MODEL_CHAT_ONLY')
  const token = await createTrialSessionTokenProvider(supabase.auth, userId)()
  const saved = JSON.parse(localStorage.getItem(key(userId)) ?? '{}') as { chatId?: string; pending?: { id: string; text: string } }
  if (!saved.chatId) saved.chatId = crypto.randomUUID()
  // A lost reply retains the same message id and content. Never silently allocate another operation.
  if (text && !saved.pending) saved.pending = { id: crypto.randomUUID(), text }
  localStorage.setItem(key(userId), JSON.stringify(saved))
  const response = await fetch(`/__trial_chat?chatId=${saved.chatId}`, { method: text ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: text ? JSON.stringify({ chatId: saved.chatId, messageId: saved.pending!.id, text: saved.pending!.text }) : undefined,
  })
  const result = await response.json() as TrialChatView
  if (!response.ok) throw new Error('TRIAL_CHAT_RECOVER_REQUIRED')
  const session = (await supabase.auth.getSession()).data.session
  if (session?.user.id !== userId) throw new Error('TRIAL_SESSION_CHANGED')
  if (!result.error && saved.pending && result.acknowledgedMessageIds?.includes(saved.pending.id)) { delete saved.pending; localStorage.setItem(key(userId), JSON.stringify(saved)) }
  if (result.operation) {
    localStorage.setItem(`nemo:trial:v1:${import.meta.env.VITE_SUPABASE_URL}:${result.accountId}:${userId}`, JSON.stringify({ key: result.operationKey, operationId: result.operation.operation_id, slotId: result.operation.payload.session_id }))
  }
  return result
}
