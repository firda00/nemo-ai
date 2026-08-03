const TABLE_SEPARATOR = /^:?-{3,}:?$/

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 — $2')
    .trim()
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cleanMarkdown(cell))
}

function iconFor(label: string): string {
  if (/sku|артикул|код/i.test(label)) return '🏷'
  if (/цен|price|narx/i.test(label)) return '💰'
  if (/остат|stock|qoldiq|fbo|fbs/i.test(label)) return '📦'
  return '•'
}

function tableBlocks(headers: string[], rows: string[][]): string[] {
  const nameIndex = headers.findIndex((header) => /назван|товар|name|nomi|mahsulot/i.test(header))
  return rows.map((row) => {
    const titleIndex = nameIndex >= 0 ? nameIndex : Math.min(1, Math.max(row.length - 1, 0))
    const title = row[titleIndex] || 'Товар'
    const details = headers.flatMap((header, index) => {
      if (index === titleIndex || !row[index]) return []
      return [`${iconFor(header)} <b>${escapeHtml(header)}:</b> ${escapeHtml(row[index])}`]
    })
    return [`<b>• ${escapeHtml(title)}</b>`, ...details].join('\n')
  })
}

/** Convert the small Markdown subset used by agents into Telegram-safe, mobile-friendly HTML. */
export function formatTelegramHtml(input: string): string {
  const lines = String(input ?? '').replace(/\r\n/g, '\n').split('\n')
  const output: string[] = []

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const next = lines[index + 1]
    if (line.includes('|') && next?.includes('|')) {
      const headers = cells(line)
      const separator = cells(next)
      if (headers.length > 1 && separator.length === headers.length && separator.every((cell) => TABLE_SEPARATOR.test(cell))) {
        const rows: string[][] = []
        index += 2
        while (index < lines.length && lines[index].includes('|')) {
          const row = cells(lines[index])
          if (row.some(Boolean)) rows.push(row)
          index += 1
        }
        output.push(...tableBlocks(headers, rows))
        continue
      }
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      const title = cleanMarkdown(heading[1])
      const icon = /магазин|shop|do.?kon/i.test(title) ? '🏪 ' : ''
      output.push(`<b>${icon}${escapeHtml(title)}</b>`)
    } else if (/^\s*[-*]\s+/.test(line)) {
      output.push(`• ${escapeHtml(cleanMarkdown(line.replace(/^\s*[-*]\s+/, '')))}`)
    } else {
      output.push(escapeHtml(cleanMarkdown(line)))
    }
    index += 1
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Keep every Bot API call comfortably below Telegram's 4096-character message limit. */
export function splitTelegramText(input: string, maxLength = 2400): string[] {
  const lines = String(input ?? '').replace(/\r\n/g, '\n').split('\n')
  const chunks: string[] = []
  let current = ''
  for (const originalLine of lines) {
    let line = originalLine
    while (line.length > maxLength) {
      if (current) { chunks.push(current); current = '' }
      chunks.push(line.slice(0, maxLength))
      line = line.slice(maxLength)
    }
    const candidate = current ? `${current}\n${line}` : line
    if (candidate.length > maxLength && current) {
      chunks.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : ['']
}
