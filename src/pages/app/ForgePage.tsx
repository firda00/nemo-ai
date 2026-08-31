import {
  AlertCircle, Bot, Check, CheckCircle2, ChevronDown, Clipboard,
  Code2, Download, ExternalLink, FileCode2, FileText, Folder, FolderOpen,
  Globe2, Loader2, MonitorPlay, PackageOpen, Play, Send,
  ShieldCheck, Sparkles, TerminalSquare, X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { zipSync, strToU8 } from 'fflate'
import { Button } from '../../components/ui/Button'
import { cn } from '../../lib/cn'
import { useI18n } from '../../i18n'
import { useForgeExecution } from '../../hooks/useForgeExecution'

type StudioTab = 'preview' | 'code' | 'console'

const INSTALL_COMMAND = 'curl -fsSL https://nemo-ai-swart.vercel.app/install.sh | bash'

function projectFiles(prompt: string, stack: string): Record<string, string> {
  const brief = prompt.trim() || 'Build a focused product page with one clear action.'
  if (stack === 'html-css') return {
    'index.html': `<!doctype html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"><title>Nemo Forge</title></head>\n<body><main><p class="eyebrow">Product preview</p><h1>${brief.replace(/[<>&]/g, '')}</h1><button id="start">Start project</button></main><script src="app.js"></script></body>\n</html>\n`,
    'styles.css': `:root { color-scheme: dark; font-family: system-ui, sans-serif; }\nbody { margin: 0; background: #07101d; color: #f8fafc; }\nmain { max-width: 64rem; margin: auto; padding: 8rem 2rem; }\n.eyebrow { color: #67e8f9; }\nh1 { max-width: 50rem; font-size: clamp(2.5rem, 7vw, 5rem); letter-spacing: -.05em; }\nbutton { border: 0; border-radius: .75rem; padding: .9rem 1.2rem; background: #67e8f9; color: #07101d; font-weight: 700; }\n`,
    'app.js': `document.querySelector('#start').addEventListener('click', (event) => { event.currentTarget.textContent = 'Request received' })\n`,
    'README.md': `# Nemo Forge HTML export\n\n${brief}\n`,
  }
  if (stack === 'next-tailwind') return {
    'app/page.tsx': `export default function Page() {\n  return <main className="min-h-screen bg-slate-950 px-8 py-28 text-white"><p className="text-cyan-300">Product preview</p><h1 className="mt-4 max-w-4xl text-6xl font-semibold tracking-tight">${brief.replace(/[{}<>]/g, '')}</h1></main>\n}\n`,
    'app/layout.tsx': `import './globals.css'\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html lang="en"><body>{children}</body></html> }\n`,
    'app/globals.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\nbody { margin: 0; }\n`,
    'README.md': `# Nemo Forge Next.js export\n\n${brief}\n`,
  }
  return {
    'src/App.tsx': `import { useState } from 'react'\nimport { Hero } from './components/Hero'\nimport { RequestForm } from './components/RequestForm'\n\nexport default function App() {\n  const [sent, setSent] = useState(false)\n  return (\n    <main className="min-h-screen bg-slate-950 text-white">\n      <Hero brief={${JSON.stringify(brief)}} />\n      <RequestForm sent={sent} onSubmit={() => setSent(true)} />\n    </main>\n  )\n}\n`,
    'src/components/Hero.tsx': `export function Hero({ brief }: { brief: string }) {\n  return (\n    <section className="mx-auto max-w-5xl px-6 pb-16 pt-24">\n      <p className="text-cyan-300">Product preview</p>\n      <h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-tight">{brief}</h1>\n    </section>\n  )\n}\n`,
    'src/components/RequestForm.tsx': `type Props = { sent: boolean; onSubmit(): void }\n\nexport function RequestForm({ sent, onSubmit }: Props) {\n  return (\n    <section className="mx-auto max-w-5xl px-6 pb-24">\n      <button onClick={onSubmit} className="rounded-xl bg-cyan-300 px-5 py-3 text-slate-950">\n        {sent ? 'Request received' : 'Start project'}\n      </button>\n    </section>\n  )\n}\n`,
    'src/styles.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root { color-scheme: dark; font-family: Geist, sans-serif; }\n`,
    'README.md': `# Nemo Forge export\n\n## Brief\n\n${brief}\n\nGenerated as an editable starter. Review dependencies and tests before publishing.\n`,
  }
}

export default function ForgePage() {
  const { t, lang } = useI18n()
  const forge = useForgeExecution()
  const [studioTab, setStudioTab] = useState<StudioTab>('preview')
  const [selectedFile, setSelectedFile] = useState('src/App.tsx')
  const [stack, setStack] = useState('react-tailwind')
  const [copied, setCopied] = useState('')
  const [previewSent, setPreviewSent] = useState(false)
  const [publishMessage, setPublishMessage] = useState('')
  const [tweak, setTweak] = useState('')
  const [chatNotes, setChatNotes] = useState<string[]>([])
  const files = useMemo(() => projectFiles(forge.prompt, stack), [forge.prompt, stack])
  const hasDraft = Boolean(forge.plan)

  const generate = () => {
    forge.compile()
    setStudioTab('preview')
    setPublishMessage('')
  }

  const copy = async (value: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      window.setTimeout(() => setCopied(''), 1_600)
    } catch {
      setCopied('failed')
    }
  }

  const downloadZip = () => {
    const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])))
    const url = URL.createObjectURL(new Blob([Uint8Array.from(archive)], { type: 'application/zip' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'nemo-forge-project.zip'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const preparePublish = () => {
    setStudioTab('console')
    setPublishMessage(t('forgePage.publishGuard'))
  }

  const submitTweak = () => {
    const next = tweak.trim()
    if (!next) return
    setChatNotes((current) => [...current, next].slice(-4))
    forge.setPrompt(`${forge.prompt.trim()}\n\n${next}`.trim())
    setTweak('')
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-5.5rem)] w-full max-w-[1680px] flex-col px-3 py-4 sm:px-5">
      <header className="flex flex-col gap-4 border-b border-ice/[0.08] pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-accent-cyan"><Sparkles size={15} /><span className="text-[11px] font-semibold tracking-[0.12em]">Nemo Forge</span></div>
          <h1 className="mt-1 text-2xl font-black tracking-[-0.04em] text-text sm:text-3xl">{t('forgePage.studioTitle')}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{t('forgePage.studioBody')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={downloadZip} leftIcon={<Download size={14} />}>{t('forgePage.downloadZip')}</Button>
          <Button variant="secondary" size="sm" onClick={() => void copy('nemo', 'cli')} leftIcon={<TerminalSquare size={14} />}>{copied === 'cli' ? t('forgePage.copied') : t('forgePage.openCli')}</Button>
          <Button size="sm" onClick={preparePublish} disabled={!hasDraft} leftIcon={<Globe2 size={14} />}>{t('forgePage.publishWeb')}</Button>
        </div>
      </header>

      <main className="mt-4 grid min-h-0 flex-1 overflow-hidden rounded-[1.4rem] border border-ice/[0.09] bg-panel/35 shadow-[0_28px_80px_rgba(2,8,23,.18)] xl:grid-cols-[390px_minmax(0,1fr)]">
        <section className="flex min-h-[620px] min-w-0 flex-col border-b border-ice/[0.08] bg-bg/35 xl:border-b-0 xl:border-r" aria-label={t('forgePage.builderAria')}>
          <div className="border-b border-ice/[0.08] p-4">
            <label htmlFor="forge-prompt" className="text-xs font-semibold text-text">{t('forgePage.describe')}</label>
            <textarea id="forge-prompt" value={forge.prompt} onChange={(event) => forge.setPrompt(event.target.value)} rows={5} maxLength={16_384} placeholder={t('forgePage.studioPlaceholder')} className="mt-2 w-full resize-none rounded-2xl border border-ice/10 bg-black/15 px-3.5 py-3 text-sm leading-6 text-text outline-none transition placeholder:text-fog focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/10" />
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] xl:grid-cols-[1fr_auto]">
              <label className="relative"><span className="sr-only">{t('forgePage.stack')}</span><select value={stack} onChange={(event) => { const next = event.target.value; setStack(next); setSelectedFile(Object.keys(projectFiles(forge.prompt, next))[0]) }} className="h-10 w-full appearance-none rounded-xl border border-ice/10 bg-panel px-3 pr-9 text-xs font-medium text-text outline-none focus:border-accent-cyan/50"><option value="react-tailwind">React + Tailwind</option><option value="html-css">HTML + CSS</option><option value="next-tailwind">Next.js + Tailwind</option></select><ChevronDown size={14} className="pointer-events-none absolute right-3 top-3 text-muted" /></label>
              <Button onClick={generate} disabled={forge.prompt.trim().length < 3} leftIcon={<Play size={14} />}>{t('forgePage.generate')}</Button>
            </div>
            {forge.compileError && <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-danger/20 bg-danger/[0.08] p-3 text-xs leading-5 text-danger"><AlertCircle size={14} className="mt-0.5 shrink-0" />{forge.compileError}</div>}
          </div>

          <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
            <section className="border-b border-ice/[0.08] p-4" aria-labelledby="forge-files-title">
              <div className="flex items-center justify-between"><h2 id="forge-files-title" className="text-xs font-semibold text-text">{t('forgePage.files')}</h2><span className="font-mono text-[10px] text-fog">{Object.keys(files).length}</span></div>
              <div className="mt-3 space-y-0.5 text-xs"><div className="flex items-center gap-2 px-2 py-1.5 text-muted"><FolderOpen size={14} className="text-accent-cyan" /><span>{t('forgePage.projectRoot')}</span></div>{Object.keys(files).map((name) => <FileRow key={name} name={name} active={selectedFile === name} onSelect={() => { setSelectedFile(name); setStudioTab('code') }} />)}</div>
            </section>

            <section className="flex min-h-0 flex-col p-4" aria-labelledby="forge-chat-title">
              <div className="flex items-center justify-between"><h2 id="forge-chat-title" className="text-xs font-semibold text-text">{t('forgePage.coderChat')}</h2><span className="flex items-center gap-1 text-[10px] text-teal"><span className="h-1.5 w-1.5 rounded-full bg-teal" />{t('forgePage.ready')}</span></div>
              <div className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1"><div className="flex gap-2.5"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-cyan/10 text-accent-cyan"><Bot size={14} /></span><p className="rounded-2xl rounded-tl-sm bg-white/[0.04] px-3 py-2.5 text-xs leading-5 text-muted">{hasDraft ? t('forgePage.agentDraftReady', { n: Object.keys(files).length }) : t('forgePage.agentWelcome')}</p></div>{forge.prompt.trim() && <div className="flex justify-end"><p className="max-w-[88%] whitespace-pre-line rounded-2xl rounded-tr-sm bg-accent-cyan/[0.09] px-3 py-2.5 text-xs leading-5 text-text">{forge.prompt}</p></div>}{chatNotes.map((note, index) => <div key={`${note}-${index}`} className="flex gap-2.5"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-cyan/10 text-accent-cyan"><Bot size={14} /></span><p className="rounded-2xl rounded-tl-sm bg-white/[0.04] px-3 py-2.5 text-xs leading-5 text-muted">{t('forgePage.changeApplied', { text: note })}</p></div>)}{hasDraft && <div className="flex gap-2.5"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-cyan/10 text-accent-cyan"><Bot size={14} /></span><p className="rounded-2xl rounded-tl-sm bg-white/[0.04] px-3 py-2.5 text-xs leading-5 text-muted">{t('forgePage.agentNext')}</p></div>}</div>
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-ice/10 bg-black/10 px-3 py-2"><input value={tweak} onChange={(event) => setTweak(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submitTweak() }} aria-label={t('forgePage.tweakAria')} placeholder={t('forgePage.tweakPlaceholder')} className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-fog" /><button type="button" onClick={submitTweak} disabled={!tweak.trim()} aria-label={t('forgePage.send')} className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.05] text-muted transition hover:bg-accent-cyan/10 hover:text-accent-cyan disabled:cursor-not-allowed disabled:opacity-40"><Send size={13} /></button></div>
            </section>
          </div>
        </section>

        <section className="flex min-h-[620px] min-w-0 flex-col bg-[#090f1c]/40" aria-label={t('forgePage.workspaceAria')}>
          <nav className="flex items-center gap-1 overflow-x-auto border-b border-ice/[0.08] px-3 py-2" aria-label={t('forgePage.viewTabs')}>
            <StudioTabButton active={studioTab === 'preview'} onClick={() => setStudioTab('preview')} icon={MonitorPlay} label={t('forgePage.livePreview')} />
            <StudioTabButton active={studioTab === 'code'} onClick={() => setStudioTab('code')} icon={Code2} label={t('forgePage.fileCode')} />
            <StudioTabButton active={studioTab === 'console'} onClick={() => setStudioTab('console')} icon={TerminalSquare} label={t('forgePage.console')} />
            <span className="ml-auto hidden items-center gap-1.5 pr-2 text-[10px] text-muted sm:flex"><span className={cn('h-1.5 w-1.5 rounded-full', forge.live ? 'bg-teal' : 'bg-amber')} />{forge.live ? t('forgePage.connected') : t('forgePage.localPreview')}</span>
          </nav>
          <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">{studioTab === 'preview' && <LivePreview prompt={forge.prompt} ready={hasDraft} submitted={previewSent} onSubmit={() => setPreviewSent(true)} />}{studioTab === 'code' && <CodeViewer name={selectedFile} code={files[selectedFile] ?? ''} onCopy={() => void copy(files[selectedFile] ?? '', 'code')} copied={copied === 'code'} />}{studioTab === 'console' && <ConsoleView forge={forge} publishMessage={publishMessage} lang={lang} />}</div>
        </section>
      </main>

      <section className="mt-4 grid gap-3 rounded-2xl border border-ice/[0.08] bg-panel/35 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center" aria-labelledby="forge-cli-title">
        <div className="min-w-0"><div className="flex items-center gap-2"><TerminalSquare size={15} className="text-accent-cyan" /><h2 id="forge-cli-title" className="text-xs font-semibold text-text">{t('forgePage.cliTitle')}</h2></div><div className="mt-2 flex min-w-0 items-center gap-2 rounded-xl bg-black/20 px-3 py-2"><code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-muted">{INSTALL_COMMAND}</code><button type="button" onClick={() => void copy(INSTALL_COMMAND, 'install')} aria-label={t('forgePage.copyInstall')} className="shrink-0 rounded-lg p-1.5 text-muted transition hover:bg-white/[0.05] hover:text-text">{copied === 'install' ? <Check size={14} className="text-teal" /> : <Clipboard size={14} />}</button></div></div>
        <div className="flex flex-wrap gap-2 sm:justify-end"><Button href="/download/cli" size="sm" variant="secondary" leftIcon={<PackageOpen size={14} />}>{t('forgePage.downloadCli')}</Button><Button href="/docs/cli" size="sm" variant="ghost" rightIcon={<ExternalLink size={13} />}>{t('forgePage.cliDocs')}</Button></div>
      </section>
    </div>
  )
}

function FileRow({ name, active, onSelect }: { name: string; active: boolean; onSelect(): void }) {
  const shortName = name.startsWith('src/') ? name.slice(4) : name
  const nested = shortName.includes('/')
  return <button type="button" onClick={onSelect} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition', nested && 'pl-7', active ? 'bg-accent-cyan/[0.09] text-text' : 'text-muted hover:bg-white/[0.035] hover:text-text')}>{nested ? <Folder size={13} className="text-fog" /> : name.endsWith('.css') ? <FileText size={13} className="text-violet" /> : <FileCode2 size={13} className="text-accent-cyan" />}<span className="truncate">{shortName}</span></button>
}

function StudioTabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick(): void; icon: typeof Globe2; label: string }) {
  return <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={cn('flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition', active ? 'bg-white/[0.07] text-text' : 'text-muted hover:bg-white/[0.035] hover:text-text')}><Icon size={14} />{label}</button>
}

function LivePreview({ prompt, ready, submitted, onSubmit }: { prompt: string; ready: boolean; submitted: boolean; onSubmit(): void }) {
  const { t } = useI18n()
  return <div className="mx-auto min-h-full max-w-5xl overflow-hidden rounded-2xl border border-slate-700/70 bg-[#07101d] shadow-[0_24px_80px_rgba(0,0,0,.28)]"><div className="flex items-center gap-1.5 border-b border-white/10 bg-[#0d1725] px-3 py-2"><span className="h-2.5 w-2.5 rounded-full bg-[#f07878]" /><span className="h-2.5 w-2.5 rounded-full bg-[#e8bd68]" /><span className="h-2.5 w-2.5 rounded-full bg-[#69c58f]" /><span className="ml-3 rounded-md bg-white/[0.05] px-3 py-1 font-mono text-[9px] text-slate-400">localhost:4173</span></div>{ready ? <div className="relative isolate overflow-hidden px-6 pb-16 pt-16 sm:px-12 sm:pt-24"><div className="pointer-events-none absolute -right-28 -top-28 -z-10 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl" /><p className="text-xs font-medium tracking-[0.12em] text-cyan-300">NEMO FORGE PREVIEW</p><h2 className="mt-5 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">{prompt || t('forgePage.previewFallback')}</h2><p className="mt-5 max-w-xl text-sm leading-6 text-slate-400">{t('forgePage.previewBody')}</p><button type="button" onClick={onSubmit} className="mt-8 rounded-xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 active:scale-[.98]">{submitted ? t('forgePage.previewDone') : t('forgePage.previewAction')}</button></div> : <div className="grid min-h-[430px] place-items-center px-6 text-center"><div><MonitorPlay size={32} className="mx-auto text-slate-600" /><p className="mt-4 text-sm font-semibold text-slate-200">{t('forgePage.previewEmpty')}</p><p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-slate-500">{t('forgePage.previewEmptyBody')}</p></div></div>}</div>
}

function CodeViewer({ name, code, onCopy, copied }: { name: string; code: string; onCopy(): void; copied: boolean }) {
  const { t } = useI18n()
  return <div className="overflow-hidden rounded-2xl border border-ice/[0.08] bg-[#07101b]"><div className="flex items-center justify-between border-b border-ice/[0.08] px-4 py-3"><div className="flex min-w-0 items-center gap-2"><FileCode2 size={14} className="shrink-0 text-accent-cyan" /><span className="truncate font-mono text-xs text-text">{name}</span></div><button type="button" onClick={onCopy} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] text-muted transition hover:bg-white/[0.05] hover:text-text">{copied ? <Check size={12} className="text-teal" /> : <Clipboard size={12} />}{copied ? t('forgePage.copied') : t('forgePage.copyCode')}</button></div><pre className="max-h-[660px] overflow-auto p-4 font-mono text-[11px] leading-6 text-slate-300"><code>{code}</code></pre></div>
}

function ConsoleView({ forge, publishMessage, lang }: { forge: ReturnType<typeof useForgeExecution>; publishMessage: string; lang: string }) {
  const { t } = useI18n()
  return <div className="space-y-4"><section className="rounded-2xl border border-ice/[0.08] bg-black/20 p-4"><div className="flex items-center justify-between"><h2 className="text-xs font-semibold text-text">{t('forgePage.buildTrace')}</h2>{forge.plan && <span className="font-mono text-[10px] text-muted">${forge.plan.estimatedCostUsd.toFixed(2)}</span>}</div>{forge.plan ? <ol className="mt-4 space-y-2">{forge.plan.steps.map((step, index) => <li key={step.stepId} className="flex items-center gap-3 rounded-xl bg-white/[0.025] px-3 py-2.5"><span className="font-mono text-[10px] text-fog">{String(index + 1).padStart(2, '0')}</span><CheckCircle2 size={14} className={step.status === 'waiting_approval' ? 'text-amber' : 'text-teal'} /><span className="min-w-0 flex-1 truncate text-xs text-muted">{t(`forgePage.step_${step.type}`)}</span><span className="text-[10px] text-fog">{step.status === 'waiting_approval' ? t('forgePage.needsReview') : t('forgePage.ready')}</span></li>)}</ol> : <p className="mt-3 text-xs leading-5 text-muted">{t('forgePage.consoleEmpty')}</p>}</section>{publishMessage && <div role="status" className="flex items-start gap-2 rounded-2xl border border-amber/20 bg-amber/[0.07] p-4 text-xs leading-5 text-amber"><ShieldCheck size={15} className="mt-0.5 shrink-0" />{publishMessage}</div>}<section className="rounded-2xl border border-ice/[0.08] bg-black/20 p-4"><h2 className="text-xs font-semibold text-text">{t('forgePage.approvalsTitle')}</h2>{forge.loadingOperations ? <p className="mt-3 flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t('common.loading')}</p> : forge.approvals.length ? <div className="mt-3 space-y-2">{forge.approvals.slice(0, 3).map((approval) => <article key={approval.id} className="rounded-xl bg-white/[0.025] p-3"><p className="text-xs leading-5 text-text">{approval.summary}</p><p className="mt-1 text-[10px] text-fog">{new Date(approval.createdAt).toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'en' ? 'en-US' : 'uz-UZ')}</p><div className="mt-2 flex gap-2"><button type="button" disabled={forge.approvalBusy === approval.id} onClick={() => void forge.decideApproval(approval.id, 'approved')} className="rounded-lg bg-teal/10 px-2.5 py-1.5 text-[10px] font-semibold text-teal"><Check size={12} className="mr-1 inline" />{t('forgePage.approve')}</button><button type="button" disabled={forge.approvalBusy === approval.id} onClick={() => void forge.decideApproval(approval.id, 'rejected')} className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-[10px] font-semibold text-danger"><X size={12} className="mr-1 inline" />{t('forgePage.reject')}</button></div></article>)}</div> : <p className="mt-3 text-xs leading-5 text-muted">{t('forgePage.noApprovals')}</p>}</section>{forge.operationsError && <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/[0.07] p-3 text-xs text-danger"><AlertCircle size={14} className="mt-0.5 shrink-0" />{forge.operationsError}</div>}</div>
}
