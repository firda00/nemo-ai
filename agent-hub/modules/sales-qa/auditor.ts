/*
 * Аудит разговора: два прохода модели и ПРОВЕРКА КАЖДОГО УТВЕРЖДЕНИЯ ПО РАСШИФРОВКЕ.
 *
 * Перенесено из MetaSell (server/aiEngine.js) — это самая ценная часть того модуля, и ценна она
 * не оценкой, а недоверием к модели.
 *
 * ГЛАВНОЕ ПРАВИЛО: ЭТАП СЧИТАЕТСЯ ВЫПОЛНЕННЫМ, ТОЛЬКО ЕСЛИ В РАСШИФРОВКЕ ЕСТЬ ДОСЛОВНАЯ ЦИТАТА.
 *
 * Модель, которую попросили оценить разговор, охотно напишет «менеджер выяснил потребность» там,
 * где менеджер этого не делал: связный отчёт для неё правдоподобнее рваного. От такой оценки
 * зависит премия человека, поэтому здесь каждое «выполнено» обязано опираться на цитату, и цитата
 * ищется в расшифровке буквально. Не нашлась — этап переводится в «не подтверждено» с нулём.
 *
 * Отказ идёт в БЕЗОПАСНУЮ сторону: неподтверждённое становится неподтверждённым, а не выполненным.
 * Обратный выбор дал бы систему, которая завышает оценки тем убедительнее, чем лучше модель пишет.
 */
import type { Playbook, PlaybookStage } from './playbook.ts'

export interface Evidence {
  /** Дословная цитата из расшифровки. Проверяется на вхождение, а не на похожесть. */
  quote: string
  /** Отметка времени вида M:SS или MM:SS. Нужна человеку, чтобы перемотать и послушать. */
  timestamp: string
}

export type StageStatus = 'done' | 'partial' | 'missed' | 'not_applicable' | 'unverified'

export interface StageVerdict {
  stageId: number
  status: StageStatus
  /** 0–3. У неприменимого и неподтверждённого обязан быть ноль. */
  score: number
  evidence: Evidence | null
  note: string
}

export interface CriterionVerdict {
  code: string
  score: number
  evidence: Evidence | null
  note: string
}

export interface RawAnalysis {
  stages: StageVerdict[]
  criteria: CriterionVerdict[]
  summary?: string
  recommendations?: string[]
}

export interface AuditReport {
  playbookId: string
  /** Итог в процентах от суммы весов. */
  scorePercent: number
  stages: StageVerdict[]
  criteria: CriterionVerdict[]
  /** Этапы с оценкой 0–1: с них и начинают разбор с менеджером. */
  weakStages: number[]
  /** Что модель заявила, но подтвердить цитатой не смогла. Показывается человеку отдельно. */
  downgraded: Array<{ stageId: number; claimed: StageStatus; reason: string }>
  summary: string
  recommendations: string[]
  /** Расхождения формы ответа модели. Пусто — ответ разобран целиком. */
  issues: string[]
}

/**
 * Нормализация текста перед сверкой.
 *
 * Расшифровка и цитата приходят из разных мест: у одной «ё», у другой «е»; у одной неразрывный
 * пробел, у другой обычный; кавычки бывают трёх видов. Сверять их дословно байт в байт значит
 * отвергать верные цитаты — и обнулять оценку там, где менеджер всё сделал.
 *
 * Убирается ТОЛЬКО оформление. Слова и их порядок остаются: иначе проверка перестанет быть
 * проверкой и начнёт пропускать пересказ вместо цитаты.
 */
export function normalizeForMatch(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[‘’‚‛'`´]/g, "'")
    .replace(/[“”„‟"«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}'"\-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Отметка времени вида M:SS, MM:SS или H:MM:SS.
 *
 * Минуты и секунды строго меньше шестидесяти. Без этого «1:60» и «2:00» превращались в одинаковые
 * сто двадцать секунд, и ссылка на несуществующую отметку принималась как ссылка на соседнюю.
 */
const TIMESTAMP = /^(?:\d{1,2}:[0-5]\d|\d{1,2}:[0-5]\d:[0-5]\d)$/
/**
 * Отметка времени как РАЗМЕТКА расшифровки — только в начале строки, возможно в скобках.
 *
 * Именно в начале строки, а не где угодно. В речи полно вещей, выглядящих как отметка: «перезвоню в
 * 11:00», «встреча в 14:30». Считая их разметкой, мы рвали бы кусок посреди фразы — и цитата
 * «в четверг в 11:00 я пришлю расчёт» перестала бы находиться, хотя она сказана дословно.
 *
 * Перед отметкой допускаются обычные украшения списка: дефис, звёздочка, точка, угловая скобка.
 * Расшифровки выгружают по-разному, и строка «- 0:10 Менеджер: …» — это та же разметка. Не узнав
 * её, разбор молча переходил в слабый режим «цитата есть где-то в тексте», а выглядело это как
 * работающая привязка к моменту.
 */
const TIMESTAMP_IN_TEXT = /^[ \t]*(?:[-*•>·]+[ \t]*)?[[(]?(\d{1,2}:[0-5]\d(?::[0-5]\d)?)[\])]?/gm

/** Секунды из M:SS / MM:SS / H:MM:SS. Для сравнения отметок между собой. */
function stampSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number)
  if (parts.some((one) => !Number.isFinite(one))) return Number.NaN
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1]
}

/**
 * Разбор расшифровки на куски по отметкам времени.
 *
 * Нужен, чтобы привязать цитату к МОМЕНТУ, а не просто к факту наличия слов где-то в разговоре.
 * Возвращает пары «секунда → нормализованный текст от этой отметки до следующей».
 */
export function segmentTranscript(transcript: string): Array<{ at: number; text: string }> {
  const raw = String(transcript ?? '')
  const marks: Array<{ at: number; start: number; end: number }> = []
  for (const found of raw.matchAll(TIMESTAMP_IN_TEXT)) {
    const seconds = stampSeconds(found[1])
    if (Number.isFinite(seconds)) marks.push({ at: seconds, start: found.index, end: found.index + found[0].length })
  }
  return marks.map((mark, position) => ({
    at: mark.at,
    text: normalizeForMatch(raw.slice(mark.end, marks[position + 1]?.start ?? raw.length)),
  }))
}

/**
 * Годится ли доказательство.
 *
 * Условия, и все обязательны: цитата достаточно длинная, отметка времени похожа на время, цитата
 * ДЕЙСТВИТЕЛЬНО ЕСТЬ в расшифровке — И ИМЕННО В ТОТ МОМЕНТ, который назван.
 *
 * Порог в 12 знаков не случаен. Короткая цитата вроде «да» или «хорошо» найдётся в любом
 * разговоре, и проверка превратится в формальность: модель научится приводить односложные слова и
 * получать «подтверждено» на пустом месте.
 *
 * ПРИВЯЗКА К МОМЕНТУ — не украшение. Без неё цитата проверялась на вхождение в расшифровку целиком,
 * и один удачный фрагмент годился доказательством ВСЕХ шести этапов сразу: модель повторяла его с
 * шестью разными отметками и получала сто процентов. Теперь отметка обязана существовать в
 * расшифровке, а цитата — лежать в куске, который с неё начинается.
 *
 * Расшифровка без отметок времени (сплошной текст) проверяется по-старому, на вхождение: требовать
 * от неё разметки значило бы отвергать целый класс входных данных вместо того, чтобы разобрать их
 * хуже, но честно.
 */
export function isEvidenceValid(evidence: Evidence | null | undefined, transcript: string): boolean {
  const quote = String(evidence?.quote ?? '').trim()
  const stamp = String(evidence?.timestamp ?? '').trim()
  if (quote.length < 12) return false
  if (!TIMESTAMP.test(stamp)) return false
  const needle = normalizeForMatch(quote)
  if (needle.length < 12) return false
  if (!normalizeForMatch(transcript).includes(needle)) return false

  const segments = segmentTranscript(transcript)
  if (!segments.length) return true

  const at = stampSeconds(stamp)
  // ВСЕ куски с этой отметкой, а не первый: одно и то же время встречается дважды в расшифровках,
  // склеенных из двух дорожек, и цитата из второго куска отвергалась бы ни за что.
  const matching = segments.filter((one) => one.at === at)
  // Названа отметка, которой в расшифровке нет, — доказательство не принимается: сослаться можно
  // только на существующий момент разговора.
  if (!matching.length) return false
  return matching.some((one) => one.text.includes(needle))
}

const clampScore = (value: unknown): number => {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.min(3, Math.max(0, Math.round(num)))
}

/**
 * Свести ответ модели к отчёту, отвергнув всё неподтверждённое.
 *
 * Чистая функция: ни сети, ни времени, ни случайности. Поэтому её поведение проверяется таблицей
 * случаев, а не прогоном с живой моделью — а именно она и решает, чему верить.
 */
export function buildReport(raw: RawAnalysis, playbook: Playbook, transcript: string): AuditReport {
  const issues: string[] = []
  const downgraded: AuditReport['downgraded'] = []
  const byId = new Map<number, PlaybookStage>(playbook.stages.map((stage) => [stage.id, stage]))

  const seen = new Set<number>()
  const stages: StageVerdict[] = []
  /*
   * Уже использованные цитаты.
   *
   * Одна и та же фраза не может доказывать два разных этапа. Раньше могла: удачный фрагмент
   * повторялся шесть раз с шестью разными отметками, и все шесть этапов считались выполненными.
   * Проверка привязки к моменту закрывает большую часть этого, но не случай, когда все шесть
   * ссылаются на ОДНУ отметку. Здесь закрывается остаток.
   *
   * Побочный эффект известен: если менеджер в одной фразе и представился, и спросил разрешения,
   * второй этап придётся подтверждать другой частью фразы. Это ошибка в сторону заниженной оценки —
   * та, которую можно оспорить, послушав запись, в отличие от завышенной.
   */
  const usedQuotes = new Set<string>()

  for (const item of raw?.stages ?? []) {
    const stage = byId.get(Number(item?.stageId))
    if (!stage) { issues.push(`в ответе этап ${item?.stageId}, которого нет в сценарии`); continue }
    if (seen.has(stage.id)) { issues.push(`этап ${stage.id} встречается дважды`); continue }
    seen.add(stage.id)

    const claimed = item?.status as StageStatus
    let status: StageStatus = ['done', 'partial', 'missed', 'not_applicable'].includes(claimed) ? claimed : 'unverified'
    let score = clampScore(item?.score)
    let evidence: Evidence | null = item?.evidence ?? null
    let note = String(item?.note ?? '').trim()

    /*
     * ЗАЯВЛЕННОЕ БЕЗ ЦИТАТЫ НЕ ПРИНИМАЕТСЯ.
     *
     * Проверяется всё, что модель зачла хотя бы частично: и «выполнено», и «частично». Пропустив
     * «частично», мы оставили бы модели лазейку — она перестала бы писать «выполнено» и начала
     * писать «частично» с тем же результатом для балла.
     */
    if (status === 'done' || status === 'partial') {
      /*
       * Повтор ищется ПО ВЛОЖЕННОСТИ, а не по точному совпадению.
       *
       * Точное сравнение обходится тривиально: «Менеджер: достаточно длинная фраза» и «достаточно
       * длинная фраза» — одно и то же доказательство, обрезанное с краю, и как два разных оно
       * проходило бы. Отметка в ключ не входит намеренно: она уже проверена на принадлежность
       * моменту, а как часть ключа только давала бы обход через «0:10» против «00:10».
       */
      const quoteKey = normalizeForMatch(evidence?.quote ?? '')
      const reused = quoteKey.length >= 12
        && [...usedQuotes].some((used) => used.includes(quoteKey) || quoteKey.includes(used))
      if (!isEvidenceValid(evidence, transcript) || reused) {
        downgraded.push({
          stageId: stage.id,
          claimed: status,
          reason: reused
            ? 'та же цитата уже засчитана другому этапу'
            : evidence?.quote ? 'цитаты нет в расшифровке в названный момент' : 'цитата не приведена',
        })
        status = 'unverified'
        score = 0
        evidence = null
        note = note || 'Подтверждения в расшифровке не найдено.'
      } else {
        usedQuotes.add(quoteKey)
      }
    }

    /*
     * НЕПРИМЕНИМЫМ ЭТАП ОБЪЯВЛЯЕТ СЦЕНАРИЙ, А НЕ РАЗБОР.
     *
     * Неприменимый этап выпадает из знаменателя, то есть не портит оценку. Оставить это решение за
     * моделью — значит отдать ей ключ от итога: пять этапов «неприменимы», шестой подтверждён,
     * получилось сто процентов, и по отчёту не видно ничего подозрительного.
     */
    if (status === 'not_applicable' && !stage.optional) {
      downgraded.push({
        stageId: stage.id,
        claimed: 'not_applicable',
        reason: 'этап не объявлен условным в сценарии — неприменимым быть не может',
      })
      status = 'unverified'
      note = note || 'Этап обязателен по сценарию.'
    }

    // Неприменимый и неподтверждённый обязаны иметь ноль: иначе балл набирается из ничего.
    if (status === 'not_applicable' || status === 'unverified') score = 0
    if (status === 'missed' && score > 0) { issues.push(`пропущенный этап ${stage.id} с ненулевой оценкой`); score = 0 }

    stages.push({ stageId: stage.id, status, score, evidence, note })
  }

  // Пропущенные этапы добавляются как неподтверждённые: молча потерянный этап — это оценка, в
  // которой знаменатель тихо уменьшился, и итог оказался выше заслуженного.
  for (const stage of playbook.stages) {
    if (seen.has(stage.id)) continue
    issues.push(`модель не разобрала этап ${stage.id}`)
    stages.push({ stageId: stage.id, status: 'unverified', score: 0, evidence: null, note: 'Этап не разобран.' })
  }
  stages.sort((a, b) => a.stageId - b.stageId)

  /*
   * Итог: взвешенная доля от максимума.
   *
   * Неприменимые этапы ИСКЛЮЧАЮТСЯ ИЗ ЗНАМЕНАТЕЛЯ. Разговор без возражений не должен терять баллы
   * за неотработанное возражение — иначе вежливый клиент портит менеджеру оценку.
   *
   * Неподтверждённые в знаменателе ОСТАЮТСЯ: их не «не было», их не доказали.
   */
  let earned = 0
  let possible = 0
  for (const verdict of stages) {
    const weight = byId.get(verdict.stageId)?.weight ?? 0
    if (verdict.status === 'not_applicable') continue
    possible += weight * 3
    earned += weight * verdict.score
  }
  const scorePercent = possible > 0 ? Math.round((earned / possible) * 100) : 0

  const criteria: CriterionVerdict[] = []
  const knownCodes = new Set(playbook.criteria.map((one) => one.code))
  for (const item of raw?.criteria ?? []) {
    const code = String(item?.code ?? '')
    if (!knownCodes.has(code)) { issues.push(`в ответе критерий «${code}», которого нет в сценарии`); continue }
    let score = clampScore(item?.score)
    let evidence: Evidence | null = item?.evidence ?? null
    // Тот же порядок, что и с этапами: положительная оценка без цитаты не принимается.
    if (score > 0 && !isEvidenceValid(evidence, transcript)) { score = 0; evidence = null }
    criteria.push({ code, score, evidence, note: String(item?.note ?? '').trim() })
  }

  return {
    playbookId: playbook.id,
    scorePercent,
    stages,
    criteria,
    weakStages: stages.filter((one) => one.status !== 'not_applicable' && one.score <= 1).map((one) => one.stageId),
    downgraded,
    summary: String(raw?.summary ?? '').trim(),
    recommendations: (raw?.recommendations ?? []).map((one) => String(one).trim()).filter(Boolean),
    issues,
  }
}

/** Промпт разбора. Сценарий подставляется целиком: модель не должна догадываться об этапах. */
export function buildAuditPrompt(playbook: Playbook, transcript: string): string {
  const stages = playbook.stages
    .map((stage) => [
      `${stage.id}. ${stage.title} (вес ${stage.weight})`,
      stage.optional ? ' [условный: может быть неприменим]' : ' [обязательный]',
      ` — ${stage.expectation}`,
    ].join(''))
    .join('\n')
  const criteria = playbook.criteria.map((one) => `${one.code} — ${one.title}: ${one.expectation}`).join('\n')

  return [
    `Ты проверяешь запись разговора по сценарию «${playbook.title}». Язык разговора: ${playbook.language}.`,
    '',
    'ЭТАПЫ:',
    stages,
    '',
    'СКВОЗНЫЕ КРИТЕРИИ:',
    criteria,
    '',
    'ПРАВИЛА ОТВЕТА:',
    '1. На каждый этап дай статус: done, partial, missed или not_applicable.',
    '   not_applicable допустим ТОЛЬКО у этапов, помеченных выше как условные. У обязательного',
    '   этапа он не принимается и превращается в «не подтверждено».',
    '2. Для done и partial ОБЯЗАТЕЛЬНА дословная цитата из расшифровки и отметка времени.',
    '   Цитата сверяется автоматически, причём ИМЕННО В НАЗВАННЫЙ МОМЕНТ: отметка должна быть в',
    '   расшифровке, а цитата — стоять после неё, до следующей отметки. Пересказ, приблизительная',
    '   цитата и верная цитата с чужой отметкой отвергаются, и этап получает ноль.',
    '3. Одна цитата подтверждает ОДИН этап. Повторно приведённая засчитывается только первому.',
    '4. Не выдумывай цитат. Если подходящей нет, ставь missed честно.',
    '5. Оценка 0–3 у каждого этапа и критерия.',
    '6. Ответ — JSON: { stages: [{stageId, status, score, evidence: {quote, timestamp}, note}],',
    '   criteria: [{code, score, evidence, note}], summary, recommendations: [] }',
    '',
    'РАСШИФРОВКА:',
    transcript,
  ].join('\n')
}
