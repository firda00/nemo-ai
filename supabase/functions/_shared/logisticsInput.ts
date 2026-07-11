// Pure, deterministic logistics input parsing. Kept free of Deno/Supabase imports
// so the same behavior can be exercised by the local release tests.
export type ShipmentStatus = 'unknown' | 'pending' | 'shipped' | 'delayed' | 'delivered' | 'problem'

export interface SourceShipment {
  order_id: string
  customer: string | null
  carrier: string | null
  status: ShipmentStatus
  shipped_at: string | null
  promised_date: string | null
  last_event_at: string | null
  owner: string | null
  current_location: string | null
  eta: string | null
  exception_type: string | null
  reason: string | null
}

const HEADER_ALIASES: Record<string, keyof SourceShipment> = {
  order_id: 'order_id', orderid: 'order_id', order: 'order_id', id: 'order_id', shipment_id: 'order_id', tracking_id: 'order_id', заказ: 'order_id', номер_заказа: 'order_id', zakaz: 'order_id',
  customer: 'customer', client: 'customer', клиент: 'customer', покупатель: 'customer', mijoz: 'customer',
  carrier: 'carrier', courier: 'carrier', перевозчик: 'carrier', курьер: 'carrier', tashuvchi: 'carrier',
  status: 'status', статус: 'status', holat: 'status',
  shipped_at: 'shipped_at', shipped: 'shipped_at', дата_отправки: 'shipped_at', отправлен: 'shipped_at', jonatilgan_sana: 'shipped_at',
  promised_date: 'promised_date', promised: 'promised_date', deadline: 'promised_date', срок_доставки: 'promised_date', обещанная_дата: 'promised_date', yetkazish_sanasi: 'promised_date',
  last_event_at: 'last_event_at', last_event: 'last_event_at', last_scan: 'last_event_at', последнее_событие: 'last_event_at', последний_скан: 'last_event_at', songgi_hodisa: 'last_event_at',
  owner: 'owner', responsible: 'owner', assignee: 'owner', ответственный: 'owner', владелец: 'owner', masul: 'owner',
  current_location: 'current_location', location: 'current_location', местоположение: 'current_location', joylashuv: 'current_location',
  eta: 'eta', expected_at: 'eta', ожидается: 'eta',
  exception_type: 'exception_type', exception: 'exception_type', проблема: 'exception_type', tip: 'exception_type',
  reason: 'reason', причина: 'reason', sabab: 'reason',
}

const normalizeHeader = (value: string) => value.trim().toLowerCase().replace(/^['"]|['"]$/g, '').replace(/[\s-]+/g, '_')
const safeText = (value: unknown, max: number): string | null => {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, max) : null
}

function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let value = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++ } else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      cells.push(value.trim()); value = ''
    } else value += char
  }
  cells.push(value.trim())
  return cells
}

function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t', '|']
  let best = ',', bestCount = -1
  for (const delimiter of candidates) {
    const count = splitDelimited(line, delimiter).length - 1
    if (count > bestCount) { best = delimiter; bestCount = count }
  }
  return best
}

export function strictDateOnly(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(raw)
  if (!match) return null
  const iso = `${match[1]}-${match[2]}-${match[3]}`
  const check = new Date(`${iso}T00:00:00.000Z`)
  return Number.isFinite(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : null
}

function strictDateTime(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}(?:$|[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$)/i.test(raw)) return null
  const date = strictDateOnly(raw)
  if (!date) return null
  let normalized = raw.includes(' ') ? raw.replace(' ', 'T') : raw
  if (normalized.length === 10) normalized += 'T00:00:00+05:00'
  else if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) normalized += '+05:00'
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function normalizeStatus(value: unknown): ShipmentStatus {
  const status = String(value ?? '').trim().toLowerCase()
  if (!status) return 'unknown'
  if (/delivered|доставлен|доставлено|вручен|получен|yetkazib|topshir/.test(status)) return 'delivered'
  if (/delay|задерж|просроч|kechik/.test(status)) return 'delayed'
  if (/problem|exception|lost|повреж|утер|ошиб|muammo|yo.qol/.test(status)) return 'problem'
  if (/shipped|in transit|отправ|в пути|jo.nat|yolda/.test(status)) return 'shipped'
  if (/pending|new|created|ожида|создан|tayyor|kutil/.test(status)) return 'pending'
  return 'unknown'
}

export function parseShipmentRows(input: string): { rows: SourceShipment[]; warnings: string[]; error?: string } {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return { rows: [], warnings: [], error: 'No shipment rows found.' }
  const delimiter = detectDelimiter(lines[0])
  const first = splitDelimited(lines[0], delimiter)
  const normalized = first.map(normalizeHeader)
  const hasHeader = normalized.some((name) => Boolean(HEADER_ALIASES[name]))
  const defaultColumns: (keyof SourceShipment)[] = ['order_id', 'customer', 'carrier', 'status', 'shipped_at', 'promised_date', 'last_event_at', 'owner']
  const columns = hasHeader ? normalized.map((name) => HEADER_ALIASES[name] ?? null) : defaultColumns
  if (!columns.includes('order_id')) return { rows: [], warnings: [], error: 'The header must include order_id (or order / shipment_id).' }
  const seen = new Set<string>()
  const rows: SourceShipment[] = []
  const warnings: string[] = []
  const dataLines = lines.slice(hasHeader ? 1 : 0)
  for (let rowIndex = 0; rowIndex < dataLines.length; rowIndex++) {
    const line = dataLines[rowIndex]
    const lineNumber = rowIndex + (hasHeader ? 2 : 1)
    const cells = splitDelimited(line, delimiter)
    const values: Partial<Record<keyof SourceShipment, string>> = {}
    columns.forEach((column, index) => { if (column) values[column] = cells[index]?.trim() ?? '' })
    const orderId = String(values.order_id ?? '').replace(/^['"]|['"]$/g, '').trim()
    const normalizedId = orderId.toLowerCase()
    if (!/^[\p{L}\p{N}._/#-]{2,80}$/u.test(orderId)) { warnings.push(`Line ${lineNumber}: invalid order_id was skipped.`); continue }
    if (seen.has(normalizedId)) { warnings.push(`Line ${lineNumber}: duplicate order_id ${orderId} was skipped.`); continue }
    seen.add(normalizedId)
    const shippedAt = strictDateTime(values.shipped_at)
    const promisedDate = strictDateOnly(values.promised_date)
    const lastEventAt = strictDateTime(values.last_event_at)
    const eta = strictDateTime(values.eta)
    if (values.shipped_at && !shippedAt) warnings.push(`Line ${lineNumber}: shipped_at is not valid ISO and was ignored.`)
    if (values.promised_date && !promisedDate) warnings.push(`Line ${lineNumber}: promised_date is not valid ISO and was ignored.`)
    if (values.last_event_at && !lastEventAt) warnings.push(`Line ${lineNumber}: last_event_at is not valid ISO and was ignored.`)
    if (values.eta && !eta) warnings.push(`Line ${lineNumber}: eta is not valid ISO and was ignored.`)
    rows.push({
      order_id: orderId.slice(0, 80), customer: safeText(values.customer, 120), carrier: safeText(values.carrier, 120),
      status: normalizeStatus(values.status), shipped_at: shippedAt, promised_date: promisedDate,
      last_event_at: lastEventAt, owner: safeText(values.owner, 120), current_location: safeText(values.current_location, 180),
      eta, exception_type: safeText(values.exception_type, 80), reason: safeText(values.reason, 500),
    })
    if (rows.length > 40) return { rows: [], warnings, error: 'Maximum 40 unique shipment rows per run. Split larger files into batches.' }
  }
  return rows.length ? { rows, warnings } : { rows: [], warnings, error: 'No valid rows. Put order_id in the first column and use ISO dates such as 2026-07-11.' }
}
