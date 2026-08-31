export interface TeamRegistryChange {
  agentId: string
  departmentId: string
  changedAt: number
}

const EVENT_NAME = 'nemo:team-registry-changed'
const STORAGE_KEY = 'nemo.team-registry.revision'
const CHANNEL_NAME = 'nemo-team-registry'

export function notifyTeamRegistryChanged(change: Omit<TeamRegistryChange, 'changedAt'>): void {
  if (typeof window === 'undefined') return
  const detail: TeamRegistryChange = { ...change, changedAt: Date.now() }
  window.dispatchEvent(new CustomEvent<TeamRegistryChange>(EVENT_NAME, { detail }))
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(detail))
  } catch {
    // Storage may be disabled. The same-tab event and Realtime still refresh the registry.
  }
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage(detail)
    channel.close()
  }
}

export function subscribeTeamRegistryChanged(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onLocal = () => onChange()
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && event.newValue) onChange()
  }
  window.addEventListener(EVENT_NAME, onLocal)
  window.addEventListener('storage', onStorage)
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null
  if (channel) channel.onmessage = () => onChange()
  return () => {
    window.removeEventListener(EVENT_NAME, onLocal)
    window.removeEventListener('storage', onStorage)
    channel?.close()
  }
}
