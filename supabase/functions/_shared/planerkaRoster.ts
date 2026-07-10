// Reads a company's OWN Google Sheet as the planerka team roster: name + Telegram chat_id +
// username + department. Columns are auto-detected by header keyword (uz/ru/en) but the account
// can override them (business_profiles.planerka_members_map = { name, chatId, username, dept } as
// 0-based column indexes). Used to DM each person their tasks directly by their sheet chat_id.
import { googleAccessToken, readSheetValues } from './google.ts'

export interface RosterMember { name: string; username: string; chatId: string; dept: string }

const KW = {
  name: ['имя', 'ф.и.о', 'фио', 'сотрудник', 'ism', 'xodim', 'name', 'employee', 'full name'],
  chatId: ['chat_id', 'chatid', 'chat id', 'телеграм id', 'tg id', 'айди', 'id чата'],
  username: ['username', 'юзернейм', 'ник', 'login', 'логин', 'telegram', 'телеграм'],
  dept: ['отдел', 'должность', 'позиция', 'department', 'position', 'role', 'lavozim', "bo'lim", 'bolim'],
}

// header index by keyword; -1 if not found (so we don't grab a wrong column by accident)
function headerIndex(headers: string[], keywords: string[]): number {
  const lower = headers.map((h) => String(h ?? '').toLowerCase().trim())
  for (let i = 0; i < lower.length; i++) if (keywords.some((k) => lower[i].includes(k))) return i
  return -1
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRoster(rows: string[][], map?: Record<string, number> | null): RosterMember[] {
  if (!rows || rows.length < 2) return []
  const headers = (rows[0] ?? []).map((h) => String(h ?? ''))
  const m = map ?? {}
  const pick = (key: keyof typeof KW): number => (Number.isInteger(m[key]) && m[key] >= 0 ? m[key] : headerIndex(headers, KW[key]))
  const ni = pick('name'), ci = pick('chatId'), ui = pick('username'), di = pick('dept')
  const out: RosterMember[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] ?? []
    const name = ni >= 0 ? String(row[ni] ?? '').replace(/\s+/g, ' ').trim() : ''
    const chatId = ci >= 0 ? String(row[ci] ?? '').replace(/[^\d-]/g, '').trim() : '' // numeric chat_id only
    const username = ui >= 0 ? String(row[ui] ?? '').trim().replace(/^@/, '') : ''
    const dept = di >= 0 ? String(row[di] ?? '').replace(/\s+/g, ' ').trim() : ''
    if (name || chatId || username) out.push({ name, username, chatId, dept })
  }
  return out
}

// Load + parse the account's connected members sheet. Returns [] if none connected / unreadable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPlanerkaRoster(db: any, accountId: string): Promise<RosterMember[]> {
  const { data: bp } = await db.from('business_profiles')
    .select('planerka_members_sheet_id, planerka_members_tab, planerka_members_map')
    .eq('account_id', accountId).maybeSingle()
  const sheetId = bp?.planerka_members_sheet_id
  if (!sheetId) return []
  try {
    const g = await googleAccessToken(db, accountId)
    if (!g?.token) return []
    const tab = String(bp?.planerka_members_tab ?? '').trim()
    const range = tab ? `${tab}!A1:Z3000` : 'A1:Z3000'
    const rows = await readSheetValues(g.token, sheetId, range)
    return parseRoster(rows, bp?.planerka_members_map)
  } catch { return [] }
}

// Match a task owner string (a name / @username the LLM extracted) against the sheet roster.
export function matchRoster(roster: RosterMember[], owner: string): RosterMember | null {
  const o = String(owner ?? '').toLowerCase().replace(/^@/, '').trim()
  if (!o) return null
  for (const m of roster) {
    const un = m.username.toLowerCase(), nm = m.name.toLowerCase()
    if (un && (o === un || o.includes(un) || un.includes(o))) return m
    if (nm && (o === nm || nm.includes(o) || o.includes(nm))) return m
  }
  return null
}
