import { Activity, Cpu, Server, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const nodes = [
  ['shared-us-east-1', '99.98%', '42%', '3.1GB', '$18/mo'],
  ['dedicated-sales-01', '99.99%', '61%', '7.8GB', '$60/mo'],
  ['opensource-lab-01', '99.95%', '68%', '11.2GB', '$120/mo'],
]

export default function RuntimePage() {
  return (
    <div className="container-page max-w-7xl py-8">
      <div className="gradient-ring rounded-3xl p-px">
        <div className="rounded-[1.45rem] bg-panel/90 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="mono-label">Runtime monetization</p>
              <h1 className="mt-2 text-3xl font-extrabold text-text">Runtime Monitoring</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">Customers pay separately for the server where agents run. This screen proves uptime, resource usage and the value of managed runtime.</p>
            </div>
            <div className="rounded-3xl border border-teal/20 bg-teal/10 px-6 py-4 text-center">
              <p className="text-4xl font-black text-teal">$198</p>
              <p className="text-xs text-teal/80">runtime MRR sample</p>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-8 grid gap-4 sm:grid-cols-4">
        <Metric icon={Server} label="Runtime nodes" value="3" />
        <Metric icon={Activity} label="Uptime" value="99.98%" />
        <Metric icon={Zap} label="Active agents" value="24" />
        <Metric icon={Cpu} label="Avg latency" value="0.8s" />
      </div>
      <div className="card mt-6 overflow-hidden rounded-3xl">
        <div className="border-b border-white/10 px-5 py-4"><h2 className="text-xl font-bold text-text">Runtime nodes</h2></div>
        <div className="divide-y divide-white/10">
          {nodes.map(([name, uptime, cpu, ram, cost]) => (
            <div key={name} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-center">
              <span className="font-medium text-text">{name}</span>
              <span className="text-sm text-muted">Uptime <b className="text-teal">{uptime}</b></span>
              <span className="text-sm text-muted">CPU <b className="text-text">{cpu}</b></span>
              <span className="text-sm text-muted">RAM <b className="text-text">{ram}</b></span>
              <span className="rounded-pill border border-violet/20 bg-violet/10 px-3 py-1 text-sm text-violet">{cost}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return <div className="card rounded-2xl p-5"><Icon className="text-violet" /><p className="mt-4 text-2xl font-bold text-text">{value}</p><p className="text-xs text-muted">{label}</p></div>
}
