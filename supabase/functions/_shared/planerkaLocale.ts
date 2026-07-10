// Trilingual copy for the planerka (stand-up) agents: morning brief, weekly per-person
// scorecard, and completion/progress confirmations. The account picks the language via
// business_profiles.report_lang (uz | ru | en); we default to Russian.

export type Lang = 'uz' | 'ru' | 'en'
export function normLang(v: unknown): Lang {
  const s = String(v ?? '').toLowerCase()
  return s === 'uz' || s === 'en' ? s : 'ru'
}

const LOCALE: Record<Lang, string> = { uz: 'ru-RU', ru: 'ru-RU', en: 'en-GB' }
// Deno's ICU may lack full uz-UZ; ru-RU renders the same numeric date, so we reuse it for uz.

export function fmtDate(iso: string, lang: Lang): string {
  try { return new Date(iso).toLocaleString(LOCALE[lang], { dateStyle: 'short', timeStyle: 'short' }) } catch { return iso }
}

// Whole days a task is overdue (0 if not overdue / no due date). "Each missed day adds a day."
export function overdueDays(dueIso: string | null | undefined, nowMs: number): number {
  if (!dueIso) return 0
  const due = Date.parse(dueIso)
  if (isNaN(due) || due >= nowMs) return 0
  return Math.floor((nowMs - due) / 86_400_000)
}

interface Dict {
  briefHeader: string
  briefEmpty: string
  briefPersonHeader: (who: string) => string
  briefTaskLine: (title: string, due: string) => string
  overdueBadge: (days: number) => string
  briefFooter: string
  weeklyHeader: string
  weeklyPersonLine: (who: string, assigned: number, done: number, pct: number, overdue: number, maxDays: number) => string
  weeklyEmpty: string
  weeklyFooter: string
  accepted: (title: string) => string
  proofAttached: string
  proofMissing: string
  progress: (title: string, pct: number) => string
  markedInProgress: (title: string) => string
  askPercent: string
  discussCooldown: string
  verifiedNote: string
  proofRejected: (title: string, reason: string) => string
  noTaskToClose: string
  taskCreated: (title: string, who: string, due: string) => string
  sheetLogged: string
  tasksHeader: string
  noOpenTasks: string
  taskListLine: (i: number, title: string, who: string, due: string) => string
  poweredBy: (url: string) => string
}

const RU: Dict = {
  briefHeader: '☀️ Доброе утро! План на сегодня:',
  briefEmpty: '☀️ Доброе утро! Открытых задач нет — чистая доска. ✅',
  briefPersonHeader: (who) => `\n👤 ${who}`,
  briefTaskLine: (title, due) => `   • ${title}${due ? ` — до ${due}` : ''}`,
  overdueBadge: (d) => ` ⚠️ просрочено ${d} дн.`,
  briefFooter: '\n\nЗакрыли задачу — напишите «@бот готово» и приложите фото/файл как доказательство.',
  weeklyHeader: '🗓 Планёрка — итоги недели по каждому:',
  weeklyPersonLine: (who, a, d, pct, ov, md) =>
    `👤 ${who}: взял ${a}, сделал ${d} (${pct}%)` + (ov > 0 ? `, просрочено ${ov}${md > 0 ? ` (до ${md} дн.)` : ''}` : ''),
  weeklyEmpty: '🗓 Планёрка — за эту неделю задач не было.',
  weeklyFooter: '\n\nПодробнее — в разделах «Задачи» и «Мониторинг».',
  accepted: (title) => `✅ Принято: «${title}» — 100%.`,
  proofAttached: ' 📎 Доказательство приложено.',
  proofMissing: '\nℹ️ Приложите фото/файл/ссылку как доказательство, чтобы задача засчиталась полностью.',
  progress: (title, pct) => `🟡 Прогресс по «${title}»: ${pct}%.`,
  markedInProgress: (title) => `🟡 Отметил «${title}» — в процессе. Как закончите — пришлите фото/файл/ссылку как доказательство.`,
  askPercent: 'На сколько процентов готово? Напишите число, например «сделал 50%».',
  discussCooldown: '⏳ Команда ещё обрабатывает прошлое обсуждение. Подождите пару минут и попробуйте снова.',
  verifiedNote: '\n🔎 ИИ проверил доказательство — засчитано.',
  proofRejected: (title, reason) => `⚠️ Доказательство по «${title}» не подтверждает выполнение${reason ? `: ${reason}` : ''}. Задача осталась открытой — приложите корректное фото/файл/ссылку.`,
  noTaskToClose: 'Не нашёл открытую задачу за вами. Если она в группе — напишите «@бот готово» там.',
  taskCreated: (title, who, due) => `✅ Задача записана для ${who}: «${title}»${due ? ` до ${due}` : ''}. Напомню ближе к сроку.`,
  sheetLogged: ' 📊 В Google-таблице.',
  tasksHeader: '📋 Открытые задачи:',
  noOpenTasks: 'Открытых задач нет. ✅',
  taskListLine: (i, title, who, due) => `${i}. ${title} · ${who}${due ? ` — до ${due}` : ''}`,
  poweredBy: (url) => `\n\n🤖 Автоматизировано Nemo AI — заведите такого же бота бесплатно: ${url}`,
}

const UZ: Dict = {
  briefHeader: '☀️ Xayrli tong! Bugungi reja:',
  briefEmpty: '☀️ Xayrli tong! Ochiq vazifalar yoʻq — doska toza. ✅',
  briefPersonHeader: (who) => `\n👤 ${who}`,
  briefTaskLine: (title, due) => `   • ${title}${due ? ` — ${due} gacha` : ''}`,
  overdueBadge: (d) => ` ⚠️ ${d} kun kechikdi`,
  briefFooter: '\n\nVazifani yakunladingizmi — «@bot tayyor» deb yozing va dalil sifatida foto/fayl biriktiring.',
  weeklyHeader: '🗓 Planerka — har biri boʻyicha hafta yakuni:',
  weeklyPersonLine: (who, a, d, pct, ov, md) =>
    `👤 ${who}: oldi ${a}, bajardi ${d} (${pct}%)` + (ov > 0 ? `, kechikdi ${ov}${md > 0 ? ` (${md} kungacha)` : ''}` : ''),
  weeklyEmpty: '🗓 Planerka — bu hafta vazifalar boʻlmadi.',
  weeklyFooter: '\n\nBatafsil — «Vazifalar» va «Monitoring» boʻlimlarida.',
  accepted: (title) => `✅ Qabul qilindi: «${title}» — 100%.`,
  proofAttached: ' 📎 Dalil biriktirildi.',
  proofMissing: '\nℹ️ Toʻliq hisoblanishi uchun dalil sifatida foto/fayl/havola biriktiring.',
  progress: (title, pct) => `🟡 «${title}» boʻyicha jarayon: ${pct}%.`,
  markedInProgress: (title) => `🟡 «${title}» — jarayonda deb belgiladim. Tugatgach — dalil sifatida foto/fayl/havola yuboring.`,
  askPercent: 'Necha foiz tayyor? Raqam yozing, masalan «50% qildim».',
  discussCooldown: '⏳ Jamoa oldingi muhokamani hali qayta ishlayapti. Bir-ikki daqiqa kutib, qayta urinib koʻring.',
  verifiedNote: '\n🔎 AI dalilni tekshirdi — hisobga olindi.',
  proofRejected: (title, reason) => `⚠️ «${title}» boʻyicha dalil bajarilganini tasdiqlamayapti${reason ? `: ${reason}` : ''}. Vazifa ochiq qoldi — toʻgʻri foto/fayl/havola biriktiring.`,
  noTaskToClose: 'Sizga biriktirilgan ochiq vazifa topilmadi. Agar u guruhda boʻlsa — oʻsha yerda «@bot tayyor» deb yozing.',
  taskCreated: (title, who, due) => `✅ ${who} uchun vazifa yozildi: «${title}»${due ? ` ${due} gacha` : ''}. Muddat yaqinlashganda eslataman.`,
  sheetLogged: ' 📊 Google-jadvalda.',
  tasksHeader: '📋 Ochiq vazifalar:',
  noOpenTasks: 'Ochiq vazifalar yoʻq. ✅',
  taskListLine: (i, title, who, due) => `${i}. ${title} · ${who}${due ? ` — ${due} gacha` : ''}`,
  poweredBy: (url) => `\n\n🤖 Nemo AI orqali avtomatlashtirildi — bepul shunday bot oching: ${url}`,
}

const EN: Dict = {
  briefHeader: '☀️ Good morning! Today’s plan:',
  briefEmpty: '☀️ Good morning! No open tasks — clean board. ✅',
  briefPersonHeader: (who) => `\n👤 ${who}`,
  briefTaskLine: (title, due) => `   • ${title}${due ? ` — by ${due}` : ''}`,
  overdueBadge: (d) => ` ⚠️ ${d}d overdue`,
  briefFooter: '\n\nFinished a task? Reply “@bot done” and attach a photo/file as proof.',
  weeklyHeader: '🗓 Stand-up — the week per person:',
  weeklyPersonLine: (who, a, d, pct, ov, md) =>
    `👤 ${who}: took ${a}, done ${d} (${pct}%)` + (ov > 0 ? `, overdue ${ov}${md > 0 ? ` (up to ${md}d)` : ''}` : ''),
  weeklyEmpty: '🗓 Stand-up — no tasks this week.',
  weeklyFooter: '\n\nDetails — in “Tasks” and “Monitoring”.',
  accepted: (title) => `✅ Accepted: “${title}” — 100%.`,
  proofAttached: ' 📎 Proof attached.',
  proofMissing: '\nℹ️ Attach a photo/file/link as proof so the task counts as fully done.',
  progress: (title, pct) => `🟡 Progress on “${title}”: ${pct}%.`,
  markedInProgress: (title) => `🟡 Marked “${title}” as in progress. When done, send a photo/file/link as proof.`,
  askPercent: 'What percent is done? Send a number, e.g. “done 50%”.',
  discussCooldown: '⏳ The team is still working through the last discussion. Give it a couple of minutes and try again.',
  verifiedNote: '\n🔎 AI checked the proof — accepted.',
  proofRejected: (title, reason) => `⚠️ The proof for “${title}” does not confirm completion${reason ? `: ${reason}` : ''}. The task stays open — attach a proper photo/file/link.`,
  noTaskToClose: 'No open task found for you. If it’s in a group, reply “@bot done” there.',
  taskCreated: (title, who, due) => `✅ Task saved for ${who}: “${title}”${due ? ` by ${due}` : ''}. I’ll remind near the deadline.`,
  sheetLogged: ' 📊 In the Google Sheet.',
  tasksHeader: '📋 Open tasks:',
  noOpenTasks: 'No open tasks. ✅',
  taskListLine: (i, title, who, due) => `${i}. ${title} · ${who}${due ? ` — by ${due}` : ''}`,
  poweredBy: (url) => `\n\n🤖 Automated by Nemo AI — get your own bot free: ${url}`,
}

const DICTS: Record<Lang, Dict> = { uz: UZ, ru: RU, en: EN }
export function L(lang: Lang): Dict { return DICTS[lang] }
