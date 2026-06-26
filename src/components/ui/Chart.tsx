/** SVG area+line chart — violet on dark glass (spec §3). */
export function AreaChart({ data, height = 120 }: { data: number[]; height?: number }) {
  const w = 600
  const h = height
  const pad = 6
  // Guard: empty/short input (e.g. live data still loading or no dialogues yet)
  // must never produce undefined points — default to a flat baseline.
  const series = data && data.length >= 2 ? data : [...(data ?? []), 0, 0].slice(0, Math.max((data ?? []).length, 2))
  const max = Math.max(...series, 1)
  const min = Math.min(...series, 0)
  const range = max - min || 1
  const step = (w - pad * 2) / Math.max(series.length - 1, 1)
  const pts = series.map((v, i) => {
    const x = pad + i * step
    const y = pad + (1 - (v - min) / range) * (h - pad * 2)
    return [x, y] as const
  })
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h - pad} L${pts[0][0].toFixed(1)},${h - pad} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="overflow-visible">
      <path d={area} fill="#8B7CF8" fillOpacity="0.14" />
      <path d={line} fill="none" stroke="#8B7CF8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.5" fill="#22D3EE" />
      ))}
    </svg>
  )
}

const barColors = ['bg-indigo', 'bg-forest', 'bg-ember', 'bg-blossom']

export function BarList({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <ul className="space-y-3">
      {items.map((it, i) => (
        <li key={it.label}>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">{it.label}</span>
            <span className="font-medium text-ink">{it.value}</span>
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-pill bg-white/10">
            <div className={`h-full rounded-pill ${barColors[i % barColors.length]}`} style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
