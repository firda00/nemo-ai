// Planerka spreadsheet template + import. The bot doesn't just log to a plain sheet — it can
// CREATE a structured task-management sheet (task · department · assignee · deadline · status ·
// days-left · penalty · type, like the client's own Planyorka sheet) and READ a sheet the user
// sends to import its tasks. All Google-side calls live in google.ts; this file is the template
// + localized copy + row mapping.
import { createSpreadsheet, readSheetValues, updateSheetValues } from './google.ts'
import type { Lang } from './planerkaLocale.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// 9-column headers, matching the client's "Planyorka | Task management" sheet (+ a Notes column
// so the task title itself stays short and any detail goes here, not into the title cell).
export const SHEET_HEADERS: Record<Lang, string[]> = {
  uz: ['Vazifa nomi', 'Maʼsul boʻlim', 'Maʼsul shaxs', 'Deadline sanasi', 'Status', 'Qolgan kunlar', 'Zarar summa (soʻm)', 'Vazifa turi', 'Koʻrsatma'],
  ru: ['Задача', 'Отдел', 'Ответственный', 'Дедлайн', 'Статус', 'Осталось дней', 'Штраф (сум)', 'Тип задачи', 'Примечание'],
  en: ['Task', 'Department', 'Assignee', 'Deadline', 'Status', 'Days left', 'Penalty (sum)', 'Task type', 'Notes'],
}

export const STATUS: Record<Lang, { new: string; inProgress: string; done: string }> = {
  uz: { new: 'Boshlanmadi', inProgress: 'Jarayonda', done: 'Bajarildi' },
  ru: { new: 'Не начато', inProgress: 'В процессе', done: 'Готово' },
  en: { new: 'Not started', inProgress: 'In progress', done: 'Done' },
}

// Live "days left" formula pointing at its own row's deadline (col D) — but BLANK once the task is
// finished/cancelled/paused (so a done task doesn't show a huge negative "-34"). Language-agnostic:
// it regex-matches the Status cell (col E) against terminal states across uz/ru/en.
const daysLeftFormula = (): string =>
  '=IF(OR(INDIRECT("D"&ROW())="",REGEXMATCH(LOWER(INDIRECT("E"&ROW())&""),"bajarildi|tayyor|готов|done|bekor|отмен|cancel|pauza|пауз|paused")),"",INDIRECT("D"&ROW())-TODAY())'

// Formula/CSV-injection guard: task text comes (via the LLM) from untrusted chat, and cells are
// written with valueInputOption=USER_ENTERED — a value starting with = + - @ would run as a live
// formula in the owner's sheet. Prefix such user cells with an apostrophe so they stay literal.
const escCell = (s: unknown): string => { const t = String(s ?? ''); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t }

// Normalize a task title: collapse whitespace, strip trailing source-line enumeration artifacts
// ("… tayyorlash 1, 2.", "… tizimlashtirish 12-15.", "… tayyorlash 20."), drop a dangling
// separator, and cap length. Keeps the title short and clean for the sheet + reminders.
export function cleanTitle(s: unknown): string {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim()
  t = t.replace(/\s+\d+(\s*[,\-–—]\s*\d+)*\.?$/g, '').trim() // trailing "1, 2." / "12-15." / "20."
  t = t.replace(/[\s:;,.\-–—]+$/g, '').trim()                 // dangling trailing punctuation
  return t.slice(0, 200)
}

// One cell = one person, one consistent shape: "Name · @handle" (or just the handle / name).
// Never a multi-line cell with two handles.
export function unifyPerson(name?: string | null, uname?: string | null): string {
  const n = String(name ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const u = String(uname ?? '').replace(/^@/, '').replace(/[^a-zA-Z0-9_].*$/, '').trim()
  if (n && u) return `${n} · @${u}`
  if (u) return `@${u}`
  return n
}

// Build one task row in the 9-column planerka shape (title cleaned, days-left hidden when done).
export function buildTaskRow(lang: Lang, r: { title: string; department?: string; person?: string; deadline?: string; taskType?: string; status?: string; details?: string }): string[] {
  return [
    escCell(cleanTitle(r.title)),
    escCell(r.department),
    escCell(r.person),
    escCell(r.deadline),
    escCell(r.status ?? STATUS[lang].new),
    daysLeftFormula(),
    '',
    escCell(r.taskType),
    escCell(r.details),
  ]
}

// Create a fresh structured planerka sheet (bold header + status dropdown). Returns id + url.
export async function createPlanerkaSheet(token: string, lang: Lang, title: string): Promise<{ id: string; url: string } | null> {
  const s = STATUS[lang]
  return await createSpreadsheet(token, title, SHEET_HEADERS[lang], { statusColIndex: 4, statusOptions: [s.new, s.inProgress, s.done] })
}

// Flip a task's Status cell (column E) to a new value by finding the LAST row whose title
// (column A) matches. Optionally drop a proof link into the Penalty/notes column. Best-effort.
export async function setSheetTaskStatus(token: string, sheetId: string, title: string, status: string, proofUrl?: string): Promise<boolean> {
  // Match the task title against column A of the FIRST tab (works with the client's own sheet
  // whatever its tab is named), then write to the SAME first tab — status → E, proof → I (Notes),
  // never the Penalty column. Unprefixed A1-notation targets the first sheet.
  const rows = await readSheetValues(token, sheetId, 'A1:A2000')
  const want = cleanTitle(title).toLowerCase()
  let rowNum = 0
  for (let i = rows.length - 1; i >= 1; i--) { if (cleanTitle(rows[i]?.[0]).toLowerCase() === want) { rowNum = i + 1; break } }
  if (!rowNum) return false
  const ok = await updateSheetValues(token, sheetId, `E${rowNum}`, [[status]])
  if (ok && proofUrl && /^https?:\/\//.test(proofUrl)) await updateSheetValues(token, sheetId, `I${rowNum}`, [[proofUrl]])
  return ok
}

// Localized bot replies for the sheet actions.
export function sheetMsg(lang: Lang, kind: 'created' | 'needGoogle' | 'imported' | 'empty' | 'understood', arg?: any): string {
  const M = {
    uz: {
      created: (url: string) => `📊 Planerka jadvali tayyor: ${url}\nEndi men bu yerga vazifalarni avtomatik yozib boraman.`,
      needGoogle: 'Jadval yaratish uchun avval Google hisobingizni ulang (Integratsiyalar → Google). Keyin «planerka jadval yarat» deb yozing.',
      imported: (n: number) => `✅ Jadvaldan ${n} ta vazifa import qilindi. Endi eslatmalar va hisobotlar shular boʻyicha ishlaydi.`,
      empty: 'Jadvalda import qiladigan vazifa topilmadi.',
      understood: (info: string) => `📄 Jadvalni oʻqidim: ${info}\n«import qil» desangiz — vazifalarni Nemoʼga koʻchiraman.`,
    },
    ru: {
      created: (url: string) => `📊 Таблица планёрки готова: ${url}\nТеперь я буду сам записывать сюда задачи.`,
      needGoogle: 'Чтобы создать таблицу, сначала подключите Google-аккаунт (Интеграции → Google). Потом напишите «создай таблицу планёрки».',
      imported: (n: number) => `✅ Импортировал ${n} задач из таблицы. Теперь напоминания и отчёты идут по ним.`,
      empty: 'В таблице не нашёл задач для импорта.',
      understood: (info: string) => `📄 Прочитал таблицу: ${info}\nНапишите «импортируй» — перенесу задачи в Nemo.`,
    },
    en: {
      created: (url: string) => `📊 Planerka sheet is ready: ${url}\nI'll now log tasks here automatically.`,
      needGoogle: 'To create a sheet, connect your Google account first (Integrations → Google). Then say “create a planerka sheet”.',
      imported: (n: number) => `✅ Imported ${n} tasks from the sheet. Reminders and reports now run on them.`,
      empty: 'No importable tasks found in the sheet.',
      understood: (info: string) => `📄 I read the sheet: ${info}\nSay “import” and I'll bring the tasks into Nemo.`,
    },
  }[lang]
  const fn = (M as any)[kind]
  return typeof fn === 'function' ? fn(arg) : String(fn)
}

// Find a column index whose header matches any of the given keywords (case-insensitive).
function colIndex(headers: string[], keywords: string[], fallback: number): number {
  const lower = headers.map((h) => String(h ?? '').toLowerCase())
  for (let i = 0; i < lower.length; i++) if (keywords.some((k) => lower[i].includes(k))) return i
  return fallback
}

// Read a Google Sheet the user shared and import its rows as tasks (title/assignee/deadline/status).
// Maps columns by header keywords across uz/ru/en, tolerating the client's own layout. Skips
// duplicates (same title already open in this chat). Returns how many tasks were imported.
export async function importTasksFromSheet(
  db: any, token: string, accountId: string, channelId: string, chatId: string, sheetId: string,
): Promise<{ imported: number; total: number }> {
  const rows = await readSheetValues(token, sheetId)
  if (rows.length < 2) return { imported: 0, total: 0 }
  const headers = rows[0]
  const iTitle = colIndex(headers, ['vazifa nomi', 'задача', 'task'], 0)
  const iPerson = colIndex(headers, ['shaxs', 'ответствен', 'assignee'], 2)
  const iDue = colIndex(headers, ['deadline', 'дедлайн', 'muddat'], 3)
  const iStatus = colIndex(headers, ['status', 'статус', 'holat'], 4)

  // don't re-create tasks that already exist open in this chat
  const { data: existing } = await db.from('tasks').select('title').eq('channel_id', channelId).eq('telegram_chat_id', chatId).neq('status', 'done').limit(500)
  const seen = new Set<string>((existing ?? []).map((t: any) => String(t.title).trim().toLowerCase()))

  const toInsert: any[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    const title = cleanTitle(row?.[iTitle])
    if (!title || seen.has(title.toLowerCase())) continue
    const personCell = String(row?.[iPerson] ?? '').replace(/[\r\n]+/g, ' ').trim()
    const um = personCell.match(/@([a-zA-Z0-9_]{3,})/)
    const assigneeTg = um ? '@' + um[1] : null
    const assigneeName = personCell.replace(/@[a-zA-Z0-9_]+/g, '').replace(/[,·|]/g, ' ').replace(/[-–—]\s*$/, '').replace(/\s+/g, ' ').trim() || null
    const dueRaw = String(row?.[iDue] ?? '').trim()
    const dueMs = Date.parse(dueRaw)
    const dueAt = !isNaN(dueMs) ? new Date(dueMs).toISOString() : null
    const statusCell = String(row?.[iStatus] ?? '').toLowerCase()
    const done = /bajarildi|готово|done|tayyor/.test(statusCell)
    toInsert.push({
      account_id: accountId, channel_id: channelId, telegram_chat_id: chatId,
      title: title.slice(0, 300), assignee_tg: assigneeTg, assignee_name: assigneeName,
      created_by: 'sheet-import', source: 'sheet', status: done ? 'done' : 'todo',
      due_at: dueAt, deadline: dueAt ? dueAt.slice(0, 10) : null,
      ...(done ? { progress: 100, completed_at: new Date().toISOString() } : {}),
    })
    seen.add(title.toLowerCase())
  }
  if (!toInsert.length) return { imported: 0, total: rows.length - 1 }
  await db.from('tasks').insert(toInsert)
  return { imported: toInsert.length, total: rows.length - 1 }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
