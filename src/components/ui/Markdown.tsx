import { type ReactNode } from 'react'

// Minimal Markdown renderer for LLM-generated reports — headings, bold/italic,
// inline code, links, bullet/numbered lists, rules, paragraphs. Not full CommonMark.
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const re = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(_([^_]+)_)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1]) nodes.push(<a key={key++} href={m[3]} target="_blank" rel="noreferrer" className="text-cyan hover:underline">{m[2]}</a>)
    else if (m[4]) nodes.push(<strong key={key++} className="font-semibold text-text">{m[5]}</strong>)
    else if (m[6]) nodes.push(<code key={key++} className="rounded bg-ice/[0.08] px-1 py-0.5 text-[0.85em] text-cyan">{m[7]}</code>)
    else if (m[8]) nodes.push(<em key={key++}>{m[9]}</em>)
    else if (m[10]) nodes.push(<em key={key++}>{m[11]}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let key = 0
  const flush = () => {
    if (!list) return
    const items = list.items
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="my-2 ml-5 list-decimal space-y-1 text-sm leading-relaxed text-muted">
          {items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key++} className="my-2 ml-5 list-disc space-y-1 text-sm leading-relaxed text-muted">
          {items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ul>
      ),
    )
    list = null
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flush()
      const level = h[1].length
      const cls =
        level === 1
          ? 'mt-5 mb-2 text-xl font-bold text-text'
          : level === 2
            ? 'mt-4 mb-1.5 text-lg font-semibold text-text'
            : 'mt-3 mb-1 text-base font-semibold text-text'
      blocks.push(
        <p key={key++} className={cls}>
          {inline(h[2])}
        </p>,
      )
      continue
    }
    const ul = line.match(/^[-*]\s+(.*)$/)
    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (ul) {
      if (!list || list.ordered) {
        flush()
        list = { ordered: false, items: [] }
      }
      list.items.push(ul[1])
      continue
    }
    if (ol) {
      if (!list || !list.ordered) {
        flush()
        list = { ordered: true, items: [] }
      }
      list.items.push(ol[1])
      continue
    }
    if (/^(-{3,}|={3,})$/.test(line)) {
      flush()
      blocks.push(<hr key={key++} className="my-4 border-ice/10" />)
      continue
    }
    flush()
    blocks.push(
      <p key={key++} className="my-2 text-sm leading-relaxed text-muted">
        {inline(line)}
      </p>,
    )
  }
  flush()
  return <div className="max-w-none">{blocks}</div>
}
