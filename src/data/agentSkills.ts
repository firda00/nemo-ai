import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BookOpenCheck,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  FileSearch,
  FileText,
  Headphones,
  ListChecks,
  Megaphone,
  PackageSearch,
  Route,
  Search,
  Send,
  ShoppingBasket,
  Store,
  Users,
} from 'lucide-react'

export interface AgentSkillDefinition {
  id: string
  icon: LucideIcon
  color: string
}

// Keep ids in sync with supabase/functions/_shared/capabilitySkills.ts.
// The contract test fails if either side drifts.
export const AGENT_SKILLS: AgentSkillDefinition[] = [
  { id: 'data-analysis', icon: BarChart3, color: '#8B7CF8' },
  { id: 'web-research', icon: Search, color: '#22D3EE' },
  { id: 'scheduling', icon: CalendarClock, color: '#F4A640' },
  { id: 'grounded-knowledge', icon: BookOpenCheck, color: '#13C5B4' },
  { id: 'structured-intake', icon: ClipboardList, color: '#5B7CF6' },
  { id: 'lead-crm-handoff', icon: Users, color: '#EC6CB0' },
  { id: 'follow-up-drafting', icon: Send, color: '#38BDF8' },
  { id: 'meeting-to-tasks-text', icon: ListChecks, color: '#A78BFA' },
  { id: 'task-sla-control', icon: ClipboardCheck, color: '#FB923C' },
  { id: 'document-evidence-review', icon: FileSearch, color: '#60A5FA' },
  { id: 'commercial-comparison', icon: FileText, color: '#34D399' },
  { id: 'catalog-inventory-analysis', icon: PackageSearch, color: '#F59E0B' },
  { id: 'store-assortment-customer-care', icon: Store, color: '#EC4899' },
  { id: 'marketplace-growth-manager', icon: ShoppingBasket, color: '#F97316' },
  { id: 'logistics-exception-control', icon: Route, color: '#2DD4BF' },
  { id: 'executive-reporting', icon: Headphones, color: '#818CF8' },
  { id: 'content-production-review', icon: Megaphone, color: '#FB7185' },
]

// Too many simultaneous methods dilute instructions and make outputs less predictable.
export const MAX_AGENT_SKILLS = 6
