import { Building2, GraduationCap, HeartPulse, Home, ShoppingBag } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '../../components/ui/Button'

const demos: [string, LucideIcon, string][] = [
  ['Online school', GraduationCap, 'Admissions, course FAQ, lead capture, CRM handoff'],
  ['Real estate agency', Home, 'Buyer qualification, property matching, booking'],
  ['Clinic', HeartPulse, 'Reception, doctor matching, appointment intake'],
  ['E-commerce', ShoppingBag, 'Orders, refunds, delivery, product matching'],
  ['B2B SaaS', Building2, 'Inbound sales, demo booking, onboarding'],
]

export default function DemoDatasetsPage() {
  return <div className="container-page max-w-7xl py-8"><p className="mono-label">Founder demo data</p><h1 className="mt-2 text-3xl font-extrabold text-text">Demo Datasets</h1><p className="mt-2 max-w-2xl text-sm text-muted">Switch industries during investor demos and show a different AI team instantly.</p><div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-3">{demos.map(([name, Icon, desc]) => <div key={name} className="card rounded-3xl p-6"><Icon className="text-violet" /><h2 className="mt-4 text-xl font-bold text-text">{name}</h2><p className="mt-2 text-sm text-muted">{desc}</p><Button to={`/onboarding?team=${name}`} size="sm" className="mt-5">Load demo</Button></div>)}</div></div>
}
