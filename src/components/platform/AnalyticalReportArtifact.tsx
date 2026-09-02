import { useMemo, useState } from 'react'
import { BarChart3, ChevronDown, Lightbulb, ListChecks, Sparkles } from 'lucide-react'
import { Markdown } from '../ui/Markdown'

type Metric = { label: string; value: string }

function clean(value: string) {
  return value.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
}

function parseReport(report: string) {
  const lines = report.replace(/```[\s\S]*?```/g, '').split(/\r?\n/)
  const metrics: Metric[] = []
  const highlights: string[] = []
  const actions: string[] = []
  let actionSection = false

  for (const raw of lines) {
    const line = clean(raw.replace(/^#{1,6}\s+/, ''))
    if (!line) continue
    if (/^#{1,6}\s+/.test(raw)) {
      actionSection = /улучш|рекоменд|следующ|действ|приоритет|риск|recommend|next|action|priority|risk|yaxshila|tavsiya/i.test(line)
      continue
    }
    const item = clean(line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    const pair = item.match(/^([^:]{2,48}):\s*(.{1,42})$/)
    if (pair && /\d|%|₽|\$|€|сум|sum|шт|дн|час/i.test(pair[2]) && metrics.length < 4) {
      metrics.push({ label: clean(pair[1]), value: clean(pair[2]) })
      continue
    }
    if (item.length < 12 || item.length > 240) continue
    if (actionSection && actions.length < 4) actions.push(item)
    else if (/^[-*•]\s+|^\d+[.)]\s+/.test(raw.trim()) && highlights.length < 4) highlights.push(item)
  }

  if (!actions.length) actions.push(...highlights.slice(-3))
  return { metrics, highlights: highlights.slice(0, 4), actions }
}

export function AnalyticalReportArtifact({ task, report, lang }: { task: string; report: string; lang: 'ru' | 'uz' | 'en' }) {
  const [details, setDetails] = useState(false)
  const parsed = useMemo(() => parseReport(report), [report])
  const copy = lang === 'uz' ? {
    eyebrow: 'NEMO DASHBOARD', title: 'Natijalar paneli', insights: 'Asosiy xulosalar', actions: 'Nimani yaxshilash kerak', details: 'To‘liq hisobot', source: 'Manba: jamoaning tekshirilgan natijasi', empty: 'Batafsil xulosalar to‘liq hisobotda ko‘rsatilgan.',
  } : lang === 'en' ? {
    eyebrow: 'NEMO DASHBOARD', title: 'Results dashboard', insights: 'Key insights', actions: 'What to improve', details: 'Full report', source: 'Source: verified team result', empty: 'Detailed findings are available in the full report.',
  } : {
    eyebrow: 'NEMO DASHBOARD', title: 'Дашборд результата', insights: 'Главные выводы', actions: 'Что улучшить', details: 'Полный отчёт', source: 'Источник: проверенный результат команды', empty: 'Подробные выводы доступны в полном отчёте.',
  }
  const insights = parsed.highlights.length ? parsed.highlights : [copy.empty]
  const actions = parsed.actions.length ? parsed.actions : [copy.empty]

  return (
    <section className="store-artifact-in overflow-hidden rounded-3xl border border-cyan/20 bg-gradient-to-br from-cyan/[0.06] via-card/[0.035] to-violet/[0.055] p-4 sm:p-5" aria-label={copy.title}>
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-cyan/10 text-cyan"><BarChart3 size={18} /></span>
        <div className="min-w-0 flex-1"><p className="text-[10px] font-bold tracking-[0.18em] text-cyan">{copy.eyebrow}</p><h3 className="mt-1 text-base font-bold text-text">{copy.title}</h3><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">{task}</p></div>
      </header>

      {parsed.metrics.length > 0 && <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{parsed.metrics.map((metric) => <div key={`${metric.label}-${metric.value}`} className="rounded-2xl border border-ice/[0.07] bg-bg/35 p-3"><p className="break-words text-lg font-extrabold tracking-tight text-text">{metric.value}</p><p className="mt-1 break-words text-[10px] leading-4 text-muted">{metric.label}</p></div>)}</div>}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-ice/[0.07] bg-bg/30 p-3.5"><p className="flex items-center gap-2 text-[11px] font-bold text-text"><Sparkles size={13} className="text-cyan" />{copy.insights}</p><ul className="mt-3 space-y-2">{insights.map((item, index) => <li key={`${item}-${index}`} className="flex gap-2 text-xs leading-5 text-muted"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan" /><span>{item}</span></li>)}</ul></div>
        <div className="rounded-2xl border border-ice/[0.07] bg-bg/30 p-3.5"><p className="flex items-center gap-2 text-[11px] font-bold text-text"><Lightbulb size={13} className="text-amber" />{copy.actions}</p><ol className="mt-3 space-y-2">{actions.slice(0, 4).map((item, index) => <li key={`${item}-${index}`} className="flex gap-2 text-xs leading-5 text-muted"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-lg bg-amber/10 text-[10px] font-bold text-amber">{index + 1}</span><span>{item}</span></li>)}</ol></div>
      </div>

      <button type="button" onClick={() => setDetails((value) => !value)} className="mt-3 flex w-full items-center gap-2 border-t border-ice/[0.06] pt-3 text-left text-[11px] font-semibold text-muted transition hover:text-text"><ListChecks size={13} /><span>{copy.details}</span><ChevronDown size={13} className={`ml-auto transition ${details ? 'rotate-180' : ''}`} /></button>
      {details && <div className="mt-3 max-h-96 overflow-y-auto rounded-2xl border border-ice/[0.07] bg-bg/35 p-4 text-sm leading-6"><Markdown content={report} /></div>}
      <p className="mt-3 text-[9px] text-fog">{copy.source}</p>
    </section>
  )
}
