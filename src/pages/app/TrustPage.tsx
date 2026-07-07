import { FileCheck2, KeyRound, Lock, ShieldCheck, UserCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const items: [LucideIcon, string, string][] = [
  [Lock, 'Encryption', 'Secrets and provider keys stay server-side.'],
  [KeyRound, 'BYO keys', 'Customers can use their own API keys.'],
  [UserCheck, 'Human takeover', 'Operators can pause agents and reply manually.'],
  [FileCheck2, 'Audit logs', 'Agent Trace creates a reviewable history.'],
  [ShieldCheck, 'SOC2 planned', 'Security roadmap for US enterprise sales.'],
]

export default function TrustPage() {
  return <div className="container-page max-w-7xl py-8"><p className="mono-label">Trust for US market</p><h1 className="mt-2 text-3xl font-extrabold text-text">Security & Trust</h1><p className="mt-2 max-w-2xl text-sm text-muted">Trust is a product feature: data control, auditability, BYO keys, human override and compliance roadmap.</p><div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">{items.map(([Icon, title, desc]) => <div key={title} className="card rounded-3xl p-6"><Icon className="text-teal" /><h2 className="mt-4 text-xl font-bold text-text">{title}</h2><p className="mt-2 text-sm text-muted">{desc}</p></div>)}</div></div>
}
