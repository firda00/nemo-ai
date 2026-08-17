// Печать найденных лидов в консоль.
//
// Смысл модуля — чтобы владельцу НЕ ПРИХОДИЛОСЬ идти в базу за тем, что уже посчитано. Прогон,
// который сообщает «горячих: 3» и молчит о том, кто это и что им написать, заставляет открывать SQL
// ради данных, лежащих в двух шагах от экрана.
//
// Один модуль на оба режима CLI (местный и платформенный) намеренно: раньше платформенный печатал
// свою строку в одну строку, местный не печатал ничего, и эти два вывода разошлись бы дальше при
// первой же правке. Форма лида в обоих режимах одна и та же.
//
// Здесь ДВА вида вывода, и это не дублирование. `renderLeadReport` — журнал прогона по флагам: полный,
// с подписанными полями, его читают в логе и грепают. `renderLeadCards` — экран интерактива: плотные
// карточки, где на лид уходит четыре строки, потому что сразу под ними будет меню действий.

import { c } from './tui.mjs'

/** Порог, за которым лид считается горячим. Держится в согласии с schemas.ts:HOT_SCORE. */
export const HOT_SCORE = 70

/** Горячий ли лид. Статус решает порог, но если статуса нет вовсе — смотрим на число. */
export function isHot(lead) {
  const score = lead?.score
  if (!score) return false
  return score.status === 'HOT' || Number(score.score) >= HOT_SCORE
}

/** Все способы дотянуться до компании — то, без чего готовый текст некуда отправить. */
export function contactLines(lead) {
  const out = []
  if (lead.phone) out.push(`телефон:  ${lead.phone}`)
  if (lead.website) out.push(`сайт:     ${lead.website}`)
  const emails = lead.enrichment?.emails ?? []
  if (emails.length) out.push(`почта:    ${emails.slice(0, 3).join(', ')}`)
  const socials = lead.enrichment?.socials ?? {}
  if (socials.telegram) out.push(`telegram: ${socials.telegram}`)
  if (socials.instagram) out.push(`instagram: ${socials.instagram}`)
  // Пустого блока быть не должно: лид без единого канала связи не проходит фильтр качества, и если
  // такое всё же приехало — это надо увидеть, а не пролистать.
  if (!out.length) out.push('контактов нет — проверьте запись, до фильтра качества она дойти не должна была')
  return out
}

/** Кто принимает решение, если поиск людей его назвал. */
function decisionMaker(lead) {
  const fromScore = lead.score?.key_decision_maker
  if (fromScore) return fromScore
  const person = (lead.enrichment?.people ?? [])[0]
  return person ? `${person.name}${person.role ? ` — ${person.role}` : ''}` : null
}

/**
 * Подробная карточка одного лида.
 *
 * Icebreaker отделён пустой строкой и без префиксов не случайно: это единственная часть вывода,
 * которую копируют целиком и отправляют человеку. Любой наш значок, попавший внутрь, уедет в чужой
 * чат вместе с текстом.
 */
export function formatLead(lead, index) {
  const score = lead.score
  const hot = isHot(lead)
  const head = `${hot ? '🔥' : '  '} ${index}. ${lead.name}${lead.city ? ` — ${lead.city}` : ''}`
  const lines = [head]

  if (score) {
    lines.push(`     балл:     ${score.score}/100 (${score.status})`)
    if (score.reason) lines.push(`     почему:   ${score.reason}`)
  } else {
    // Отсутствие оценки — это не ноль баллов, а «модель не спрашивали». Путать нельзя: во втором
    // случае лид может оказаться лучшим в списке, просто об этом никто не узнал.
    lines.push('     балл:     нет — оценка не запускалась (нет OPENROUTER_API_KEY или ICP)')
  }

  const person = decisionMaker(lead)
  if (person) lines.push(`     ЛПР:      ${person}`)
  for (const line of contactLines(lead)) lines.push(`     ${line}`)

  if (score?.icebreaker_pitch) {
    lines.push('', '     ── первое касание, готово к отправке ──', `     ${score.icebreaker_pitch}`, '')
  } else if (score) {
    lines.push('     первое касание: не составлено — данных о компании не хватило для персонализации')
  }
  return lines.join('\n')
}

/**
 * Отчёт по всем лидам прогона.
 *
 * ГОРЯЧИЕ ПЕЧАТАЮТСЯ ВСЕГДА. Они и есть причина, по которой запускают прогон, и прятать их за
 * флагом значит заставлять запускать всё второй раз, чтобы увидеть то, что уже посчитано и оплачено.
 * `--details` добавляет остальных: тёплых и холодных смотрят, когда горячих не нашлось совсем.
 */
export function renderLeadReport(leads, { details = false } = {}) {
  const all = Array.isArray(leads) ? leads : []
  if (!all.length) return ''

  const hot = all.filter(isHot)
  const rest = all.filter((lead) => !isHot(lead))
  const shown = details ? [...hot, ...rest] : hot
  if (!shown.length) {
    // Молчать здесь нельзя: «горячих 0» без подсказки читается как «пусто», хотя лиды есть и их
    // можно посмотреть той же командой.
    return `\n[SDR] Горячих нет. Найдено ${all.length} — посмотреть все: добавьте --details\n`
  }

  const out = [`\n[SDR] ${details ? `Все лиды (${shown.length})` : `Горячие лиды (${hot.length} из ${all.length})`}:\n`]
  shown.forEach((lead, index) => { out.push(formatLead(lead, index + 1)) })
  if (!details && rest.length) out.push(`\n     Остальные ${rest.length} — покажет --details`)
  return `${out.join('\n')}\n`
}

/**
 * Плотная карточка лида для интерактивного экрана.
 *
 * Порядок строк — по тому, в каком порядке это читают: кто и насколько подходит, куда писать, почему
 * подходит, что написать. Питч последний и отделён пустой строкой: его выделяют мышью и копируют, и
 * любая наша строка, прилипшая снизу, уедет в чужой чат вместе с текстом.
 */
export function leadCard(lead, index) {
  const score = lead.score
  const contacts = [lead.phone, lead.website].filter(Boolean).join('  ·  ')
  const socials = [
    lead.enrichment?.socials?.telegram,
    lead.enrichment?.socials?.instagram,
    (lead.enrichment?.emails ?? [])[0],
  ].filter(Boolean).join('  ·  ')

  const out = [`  ${isHot(lead) ? '🔥' : '  '} ${c.bold(`${index}. ${lead.name}`)}`
    + `${lead.city ? c.dim(` — ${lead.city}`) : ''}  ${c.green(`${score?.score ?? '—'}/100`)}`]
  if (contacts) out.push(`     ${contacts}`)
  if (socials) out.push(`     ${c.dim(socials)}`)
  if (score?.reason) out.push(`     ${c.dim(score.reason)}`)
  if (score?.icebreaker_pitch) out.push('', `     ${score.icebreaker_pitch}`)
  return out.join('\n')
}

/**
 * Экран результата интерактивного прогона.
 *
 * Горячих нет — говорим об этом ЧИСЛОМ найденных, а не пустотой: «горячих нет» без «найдено 14»
 * читается как «поиск ничего не дал», хотя лиды есть и их можно выгрузить тут же в CSV.
 */
export function renderLeadCards(leads) {
  const all = Array.isArray(leads) ? leads : []
  const hot = all.filter(isHot)
  const rest = all.length - hot.length
  if (!hot.length) {
    return `\n  ${c.yellow('Горячих нет.')} ${c.dim(`Найдено всего: ${all.length}`)}\n`
  }
  const head = `\n  ${c.bold(`Горячие лиды — ${hot.length}`)}${rest ? c.dim(`  (ещё ${rest} ниже порога)`) : ''}\n`
  return `${head}\n${hot.map((lead, index) => leadCard(lead, index + 1)).join('\n\n')}\n`
}

/**
 * Человеческая формулировка этапа для строки спиннера.
 *
 * Технические имена фаз («enrich_score») в глаза человеку не показываем, но НОМЕР шага показываем
 * всегда: без «[2/3]» долгий этап выглядит как зависание, и прогон убивают на середине.
 */
export function phaseLine(event, city) {
  const step = `[${event.step}/${event.total}]`
  if (event.phase === 'search') return `${step} Поиск${city ? ` в ${city}` : ''} через OpenStreetMap…`
  if (event.phase === 'clean') return `${step} Очистка и дедупликация…`
  const progress = event.of ? ` (${event.done}/${event.of})` : ''
  return `${step} Обогащение контактов и ICP-скоринг${progress}…`
}
