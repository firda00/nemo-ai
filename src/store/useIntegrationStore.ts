import { create } from 'zustand'

// UI cache for account-level integrations. It is hydrated from the backend on every
// Integrations page mount; never seed a demo connection because that looks like a real key.
export type IntegrationStatus = 'connected' | 'error' | 'disconnected'

interface IntegrationStore {
  status: Record<string, IntegrationStatus>
  connect: (id: string) => void
  disconnect: (id: string) => void
  setError: (id: string) => void
}

const seed: Record<string, IntegrationStatus> = {
  telegram: 'disconnected',
  widget: 'disconnected',
  amocrm: 'disconnected',
  whatsapp: 'disconnected',
  instagram: 'disconnected',
  bitrix24: 'disconnected',
  google: 'disconnected',
}

export const useIntegrationStore = create<IntegrationStore>((set) => ({
  status: seed,
  connect: (id) => set((s) => ({ status: { ...s.status, [id]: 'connected' } })),
  disconnect: (id) => set((s) => ({ status: { ...s.status, [id]: 'disconnected' } })),
  setError: (id) => set((s) => ({ status: { ...s.status, [id]: 'error' } })),
}))
