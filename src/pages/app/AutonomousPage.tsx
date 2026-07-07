import { Sparkles, Wand2, Users, ListChecks } from 'lucide-react'
import { AutonomousRunner } from '../../components/platform/AutonomousRunner'

const EXAMPLES = [
  'Find 5 IT academies in Tashkent and draft a short outreach message for each.',
  'Create a one-week Telegram content plan for an IELTS course and write the first post.',
  'Analyze our unpaid students list, write reminders and an escalation plan for the admin.',
  'Research the EdTech market in Uzbekistan and give 3 growth ideas with next steps.',
]

export default function AutonomousPage() {
  return (
    <div className="container-page max-w-4xl py-8">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand text-white shadow-glow"><Wand2 size={20} /></span>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-text">Autonomous agent</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Describe a goal. The manager agent designs the specialist sub-agents it needs on the fly, they each do their part, and the manager delivers the result. Save the team to reuse it.
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-ice/10 bg-white/[0.03] px-3 py-1.5"><Sparkles size={13} className="text-violet" /> Creates sub-agents per goal</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-ice/10 bg-white/[0.03] px-3 py-1.5"><Users size={13} className="text-cyan" /> They execute together</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-ice/10 bg-white/[0.03] px-3 py-1.5"><ListChecks size={13} className="text-teal" /> One deliverable</span>
      </div>

      <div className="mt-6">
        <AutonomousRunner />
      </div>

      <div className="mt-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted">Try a goal</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {EXAMPLES.map((e) => (
            <div key={e} className="rounded-2xl border border-ice/10 bg-white/[0.02] p-3 text-sm leading-relaxed text-muted">{e}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
