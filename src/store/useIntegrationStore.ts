import { create } from 'zustand'

// Connection state for account-level integrations (channels + CRM/ERP).
// Frontend prototype: status is simulated in-memory (no real webhooks/OAuth).
export type IntegrationStatus = 'connected' | 'error' | 'disconnected'

interface IntegrationStore {
  status: Record<string, IntegrationStatus>
  connect: (id: string) => void
  disconnect: (id: string) => void
  setError: (id: string) => void
}

// Seed a realistic mix so the page shows connected + available states.
const seed: Record<string, IntegrationStatus> = {
  telegram: 'connected',
  widget: 'connected',
  amocrm: 'connected',
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
