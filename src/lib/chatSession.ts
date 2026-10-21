import type { DiscoveryState } from './chatDiscovery'

export const CHAT_HISTORY_LIMIT = 40
const MAX_BYTES = 2_160_000
export type SavedChatTurn = { id: number; role: 'user' | 'assistant'; text: string; direct: true; model?: string }
export type SavedChat = { turns: SavedChatTurn[]; discovery: DiscoveryState | null; model: string; effort: string; historyFrom: number; continuation?: string }
const empty = (): SavedChat => ({ turns: [], discovery: null, model: 'fast', effort: 'low', historyFrom: 0 })
const key = (userId: string) => `nemo:desk:v1:${userId}`

// This tab's plain conversation only. Never serialize files, tool cards, provider
// API keys, operation identities, or objects capable of starting work. The optional
// frontier continuation is server-encrypted conversation data, bound by authenticated
// encryption to user + account + model + effort and expiry; it grants no API access.
export function readChatSession(userId: string, storage: Pick<Storage, 'getItem'>): SavedChat {
  if (!userId) return empty()
  try {
    const text = storage.getItem(key(userId))
    if (!text || text.length > MAX_BYTES) return empty()
    const data = JSON.parse(text)
    if (data.version !== 1 || data.userId !== userId || !Array.isArray(data.turns) || data.turns.length > CHAT_HISTORY_LIMIT) return empty()
    const turns: SavedChatTurn[] = []
    for (const turn of data.turns) {
      if (!Number.isSafeInteger(turn.id) || turn.id <= 0 || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string' || turn.text.length > 20_000) return empty()
      turns.push({ id: turn.id, role: turn.role, text: turn.text, direct: true, ...(typeof turn.model === 'string' ? { model: turn.model.slice(0, 100) } : {}) })
    }
    const d = data.discovery
    let discovery: DiscoveryState | null = null
    if (d && ['goal', 'channels', 'format'].includes(d.step) && [null, 'team', 'agent'].includes(d.requestedKind) && typeof d.initialRequest === 'string'
      && [d.initialRequest, d.goal ?? '', d.channels ?? ''].every(value => typeof value === 'string' && value.length <= 20_000)) {
      discovery = { step: d.step, requestedKind: d.requestedKind, initialRequest: d.initialRequest, ...(d.goal ? { goal: d.goal } : {}), ...(d.channels ? { channels: d.channels } : {}) }
    }
    const model = ['fast', 'gpt-6-astra', 'claude-fable-5-1'].includes(data.model) ? data.model : 'fast'
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(data.effort) ? data.effort : 'low'
    return { turns, discovery, model, effort, historyFrom: Number.isSafeInteger(data.historyFrom) && data.historyFrom >= 0 ? data.historyFrom : 0,
      ...(model !== 'fast' && typeof data.continuation === 'string' && data.continuation.length <= 2_000_000 ? { continuation: data.continuation } : {}) }
  } catch { return empty() }
}

export function writeChatSession(userId: string, value: SavedChat, storage: Pick<Storage, 'setItem'>): boolean {
  if (!userId) return false
  try {
    if (value.turns.some(turn => !Number.isSafeInteger(turn.id) || turn.id <= 0 || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string' || turn.text.length > 20_000)) return false
    if (value.continuation && value.continuation.length > 2_000_000) return false
    if (value.discovery && [value.discovery.initialRequest, value.discovery.goal ?? '', value.discovery.channels ?? ''].some(text => text.length > 20_000)) return false
    const text = JSON.stringify({ version: 1, userId, ...value })
    if (text.length > MAX_BYTES || value.turns.length > CHAT_HISTORY_LIMIT) return false
    storage.setItem(key(userId), text)
    return true
  } catch { return false }
}
