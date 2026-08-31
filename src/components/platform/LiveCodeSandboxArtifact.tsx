import { useMemo, useState } from 'react'
import { Check, Code2, Download, FileCode2, MonitorPlay, TerminalSquare } from 'lucide-react'
import { strToU8, zipSync } from 'fflate'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

type SandboxTab = 'preview' | 'code' | 'console'

function safeBrief(value: string) {
  return (value.trim() || 'Build a focused product experience').replace(/[<>{}]/g, '').slice(0, 240)
}

function generatedProject(value: string) {
  const brief = safeBrief(value)
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nemo Sandbox</title><style>__CSS__</style></head>
<body><main><p class="eyebrow">NEMO LIVE BUILD</p><h1>${brief}</h1><p class="body">Editable starter generated inside the team conversation.</p><button id="action">Start project</button></main><script>__JS__</script></body></html>`
  const css = `:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#07101d;color:#f8fafc}main{min-height:100vh;padding:clamp(4rem,10vw,8rem) clamp(1.5rem,7vw,6rem);background:radial-gradient(circle at 82% 5%,#22d3ee22,transparent 34%)}.eyebrow{color:#67e8f9;font-size:.72rem;letter-spacing:.16em}h1{max-width:52rem;margin:1.2rem 0;font-size:clamp(2.3rem,7vw,5rem);line-height:.98;letter-spacing:-.055em}.body{max-width:34rem;color:#94a3b8;line-height:1.7}button{margin-top:1.5rem;border:0;border-radius:.8rem;padding:.9rem 1.2rem;background:#67e8f9;color:#07101d;font-weight:800;cursor:pointer}`
  const js = `document.querySelector('#action').addEventListener('click',(event)=>{event.currentTarget.textContent='Ready to iterate';event.currentTarget.style.background='#5eead4'})`
  return {
    files: {
      'index.html': html.replace('<style>__CSS__</style>', '<link rel="stylesheet" href="styles.css">').replace('<script>__JS__</script>', '<script src="app.js"></script>'),
      'styles.css': css,
      'app.js': js,
      'README.md': `# Nemo Live Sandbox\n\n${brief}\n\nReview generated code and dependencies before publishing.`,
    },
    srcDoc: html.replace('__CSS__', css).replace('__JS__', js),
  }
}

export function LiveCodeSandboxArtifact({ prompt, compact = false }: { prompt: string; compact?: boolean }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<SandboxTab>('preview')
  const [selectedFile, setSelectedFile] = useState('index.html')
  const [copied, setCopied] = useState(false)
  const project = useMemo(() => generatedProject(prompt), [prompt])

  const copyCli = async () => {
    try { await navigator.clipboard.writeText('nemo'); setCopied(true); window.setTimeout(() => setCopied(false), 1_500) } catch { setCopied(false) }
  }
  const downloadZip = () => {
    const archive = zipSync(Object.fromEntries(Object.entries(project.files).map(([name, body]) => [name, strToU8(body)])))
    const url = URL.createObjectURL(new Blob([Uint8Array.from(archive)], { type: 'application/zip' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'nemo-sandbox-project.zip'; anchor.click(); URL.revokeObjectURL(url)
  }

  return <section className="mt-3 overflow-hidden rounded-2xl border border-accent-cyan/20 bg-[#080f1c] shadow-[0_22px_70px_-48px_rgba(34,211,238,.75)]" aria-label={t('liveSandbox.title')}>
    <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.08] px-3 py-3 sm:px-4"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan/15 to-violet/15 text-accent-cyan"><Code2 size={16} /></span><div className="min-w-0 flex-1"><p className="text-[9px] font-bold uppercase tracking-[0.16em] text-accent-cyan">{t('liveSandbox.eyebrow')}</p><h3 className="truncate text-sm font-bold text-text">{t('liveSandbox.title')}</h3></div><button type="button" onClick={downloadZip} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[10px] font-semibold text-muted transition hover:text-text"><Download size={13} />{t('liveSandbox.downloadZip')}</button><button type="button" onClick={() => void copyCli()} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-2 text-[10px] font-semibold text-muted transition hover:text-text">{copied ? <Check size={13} className="text-teal" /> : <TerminalSquare size={13} />}{copied ? t('liveSandbox.copied') : t('liveSandbox.cli')}</button></header>
    <nav className="flex items-center gap-1 overflow-x-auto border-b border-white/[0.08] p-2" aria-label={t('liveSandbox.views')}>{([{ id: 'preview', icon: MonitorPlay, key: 'preview' }, { id: 'code', icon: FileCode2, key: 'code' }, { id: 'console', icon: TerminalSquare, key: 'console' }] as const).map((item) => <button key={item.id} type="button" onClick={() => setTab(item.id)} aria-pressed={tab === item.id} className={cn('inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[11px] font-semibold transition', tab === item.id ? 'bg-white/[0.08] text-text' : 'text-muted hover:text-text')}><item.icon size={13} />{t(`liveSandbox.${item.key}`)}</button>)}</nav>
    <div className={cn('grid min-w-0', compact ? 'min-h-[340px]' : 'min-h-[430px]', tab === 'code' && 'md:grid-cols-[170px_minmax(0,1fr)]')}>
      {tab === 'preview' && <iframe title={t('liveSandbox.previewFrame')} sandbox="allow-scripts" srcDoc={project.srcDoc} className={cn('w-full border-0 bg-[#07101d]', compact ? 'h-[340px]' : 'h-[430px]')} />}
      {tab === 'code' && <><aside className="border-b border-white/[0.08] p-2 md:border-b-0 md:border-r"><p className="px-2 py-2 text-[9px] font-bold uppercase tracking-[0.14em] text-fog">{t('liveSandbox.files')}</p>{Object.keys(project.files).map((name) => <button key={name} type="button" onClick={() => setSelectedFile(name)} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left font-mono text-[10px]', selectedFile === name ? 'bg-accent-cyan/10 text-text' : 'text-muted hover:text-text')}><FileCode2 size={12} />{name}</button>)}</aside><pre className={cn('overflow-auto p-4 font-mono text-[11px] leading-6 text-slate-300', compact ? 'max-h-[340px]' : 'max-h-[430px]')}><code>{project.files[selectedFile as keyof typeof project.files]}</code></pre></>}
      {tab === 'console' && <div className="space-y-2 p-4 font-mono text-[11px] leading-6 text-muted"><p><span className="text-teal">✓</span> {t('liveSandbox.consoleGenerated', { count: Object.keys(project.files).length })}</p><p><span className="text-teal">✓</span> {t('liveSandbox.consolePreview')}</p><p><span className="text-amber">!</span> {t('liveSandbox.consoleGuard')}</p></div>}
    </div>
  </section>
}
