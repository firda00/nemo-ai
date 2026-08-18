// Сценарий разговора и распознавание намерения клиента.
//
// ЧТО ЗДЕСЬ РЕШАЕТСЯ. Не «что сказать» — это дело модели, — а КОГДА ЗАКОНЧИТЬ и С КАКИМ ИТОГОМ.
// Разница принципиальна: итог звонка попадает в отчётность, в карточку менеджеру и в CRM, и ошибка в
// нём стоит дороже неудачной формулировки. «Отказался» вместо «перезвонить позже» означает лид,
// вычеркнутый навсегда; «заинтересован в демо» вместо «отказался» — менеджера, который звонит
// человеку, уже сказавшему нет.
//
// ПОЧЕМУ ИТОГ ОПРЕДЕЛЯЕТСЯ ПРАВИЛАМИ, А НЕ МОДЕЛЬЮ. Модель отвечает клиенту в реальном времени, и
// просить её попутно классифицировать разговор значит либо задержать ответ на второй вызов, либо
// доверить классификацию тому же потоку, который уже занят другим. Правила ниже дешёвы, срабатывают
// мгновенно и ошибаются предсказуемо — а спорные случаи достаются пост-звонковому разбору, у которого
// есть весь транскрипт и нет ограничения по времени.
//
// ЯЗЫК. Разговоры идут по-русски и по-узбекски. Признаки заданы для обоих: узбекский вариант — не
// вежливость, а необходимость, потому что в регионе половина малого бизнеса говорит на нём.

import type { CallAnalytics, LeadCardNotification } from '../contracts/v5.ts'

export type CallOutcome = CallAnalytics['call_outcome']

/** Что известно про звонок к моменту очередной реплики. */
export interface DialogueContext {
  companyName?: string | null
  city?: string | null
  /** Чем компания занимается — из справочника. Нужен, чтобы бот не спрашивал очевидное. */
  niche?: string | null
  /** Описание целевого клиента: тот же ICP, что в SDR-прогоне. */
  icp?: string | null
  /** Первое касание, подготовленное скорером. Служит основой приветствия. */
  icebreaker?: string | null
}

export interface DialogueTurn {
  role: 'bot' | 'customer'
  text: string
  atMs: number
}

/**
 * Системный промпт.
 *
 * ТРИ ОГРАНИЧЕНИЯ, каждое из которых существует из-за конкретного способа испортить звонок:
 *
 *   Короткие реплики. Модель по умолчанию пишет абзацами. В тексте это нормально, в разговоре —
 *   катастрофа: человек не может перебить вежливо, ждёт паузы, не дожидается и кладёт трубку.
 *
 *   Не выдумывать. Цену, сроки и возможности продукта модель охотно сочиняет. Сказанное в звонке
 *   человек считает обещанием компании, и разбираться с этим будет менеджер.
 *
 *   Признаться, что робот, если спросили прямо. Отрицание здесь — обман, а в ряде стран ещё и
 *   нарушение: звонок с ИИ-агентом обязан быть распознаваем как таковой по запросу собеседника.
 */
export function buildSystemPrompt(context: DialogueContext): string {
  const lines = [
    'Ты — голосовой ассистент компании Nemo AI. Ты звонишь по телефону, а не переписываешься.',
    '',
    'КАК ГОВОРИТЬ:',
    '— Одно-два коротких предложения за реплику. Никаких списков и абзацев: это разговор вслух.',
    '— Живая речь, без канцелярита. Обращение на «вы».',
    '— Если собеседник перебил — замолчи и слушай, не повторяй начатое.',
    '— Отвечай на том языке, на котором говорит собеседник (русский или узбекский).',
    '',
    'ЧЕГО НЕЛЬЗЯ:',
    '— Не называй цен, сроков и возможностей, которых нет в этой инструкции. Не знаешь — скажи, что',
    '  уточнит менеджер.',
    '— Не спорь и не уговаривай после отказа. Одно уточнение — и вежливо попрощайся.',
    '— Если спросили прямо, робот ли ты, — ответь честно, что ты ИИ-ассистент.',
    '',
    'ЦЕЛЬ ЗВОНКА: понять, есть ли у компании задача, которую решает Nemo, и договориться о коротком',
    'демо. Демо — это следующий шаг, а не продажа в трубке.',
  ]

  if (context.companyName) lines.push('', `КОМУ ЗВОНИШЬ: ${context.companyName}${context.city ? `, ${context.city}` : ''}.`)
  if (context.niche) lines.push(`Чем занимаются: ${context.niche}.`)
  if (context.icp) lines.push(`Кого мы ищем: ${context.icp}`)
  if (context.icebreaker) lines.push(`С чего начать разговор: ${context.icebreaker}`)

  return lines.join('\n')
}

/**
 * Первая реплика.
 *
 * Строится КОДОМ, а не моделью, и это осознанно: приветствие произносится сразу после снятия трубки,
 * то есть в момент, когда ждать вызова модели нельзя — каждая секунда тишины здесь читается как обрыв
 * связи. Заодно первая фраза остаётся предсказуемой, а её текст можно согласовать с юристом.
 */
export function buildGreeting(context: DialogueContext): string {
  const who = context.companyName ? `Это ${context.companyName}?` : ''
  const hook = context.icebreaker?.trim()
  return [
    'Здравствуйте!',
    who,
    'Меня зовут Нэмо, я ИИ-ассистент компании Ustudy.',
    hook || 'Звоню по поводу автоматизации приёма заявок. Удобно говорить?',
  ].filter(Boolean).join(' ')
}

// ── Признаки итога ────────────────────────────────────────────────────────────────────────────────
//
// Порядок проверки — от самого дорогого к самому дешёвому по цене ошибки. «Не тот номер» проверяется
// ПЕРВЫМ: продолжать продавать человеку, который сказал «вы ошиблись», хуже всего остального.

/**
 * Граница слова, работающая с кириллицей.
 *
 * \\b в JavaScript определён на ASCII: word-символы — это [A-Za-z0-9_], и кириллическая буква в их
 * число НЕ входит. Поэтому /\\bне нужно\\b/ не находит «нам не нужно» — совпадения нет вовсе, потому
 * что между пробелом и «н» нет перехода word/non-word.
 *
 * Обнаружено проверкой, а не чтением: из одиннадцати разговорных фраз сработали ровно две — обе
 * узбекские, записанные латиницей. Весь русский набор правил был мёртв и молча возвращал «итог не
 * определён» на любом отказе. Здесь граница задана через свойства Unicode и флаг u.
 */
const BOUND_START = '(?<![\\p{L}\\p{N}])'
const BOUND_END = '(?![\\p{L}\\p{N}])'

/** Собрать выражение с юникодными границами вместо \\b. */
function phrase(body: string): RegExp {
  return new RegExp(BOUND_START + '(?:' + body + ')' + BOUND_END, 'iu')
}

interface OutcomeRule {
  outcome: CallOutcome
  patterns: RegExp[]
  /** Пояснение попадает в журнал: по нему видно, ПОЧЕМУ звонок закрыт именно так. */
  reason: string
}

const OUTCOME_RULES: OutcomeRule[] = [
  {
    outcome: 'WRONG_NUMBER',
    reason: 'собеседник сказал, что это не та компания',
    patterns: [
      phrase('не туда|ошиблись номером|вы ошиблись|это не (?:мы|я|наша компания)|нет такой (?:компании|организации)'),
      phrase('такого номера нет|неправильный номер|не та компания'),
      phrase("adashdingiz|noto'g'ri raqam|bu biz emas"),
    ],
  },
  {
    outcome: 'INTERESTED_DEMO',
    reason: 'согласие на демонстрацию или запрос материалов',
    patterns: [
      phrase('(?:давайте|хорошо|согласен|согласна|можно|да)[^.!?]{0,30}(?:демо|показ\\p{L}*|презентац\\p{L}*|встреч\\p{L}*)'),
      phrase('(?:интересно|интересует|хотел бы|хотела бы|хочу)[^.!?]{0,40}(?:посмотреть|узнать|попробовать|демо)'),
      phrase('(?:пришлите|отправьте|скиньте)[^.!?]{0,30}(?:предложени|презентац|информац|материал|коммерческ)\\p{L}*'),
      phrase("qiziq|ko'rmoqchiman|yuboring"),
    ],
  },
  {
    outcome: 'CALL_LATER',
    reason: 'просьба перезвонить или связаться позже',
    patterns: [
      phrase('(?:перезвоните|перезвони|наберите|свяжитесь)[^.!?]{0,30}(?:позже|потом|завтра|на следующей|через)'),
      phrase('сейчас (?:не могу|неудобно|занят|занята)|не вовремя|давайте позже|попозже'),
      phrase("keyinroq|hozir band"),
    ],
  },
  {
    outcome: 'REJECTED',
    reason: 'явный отказ',
    patterns: [
      phrase('не интересно|неинтересно|нам не нужно|не нужно|не надо|отказыва\\p{L}*'),
      phrase('больше не звоните|не звоните|удалите (?:мой )?номер|исключите из базы'),
      phrase("kerak emas|qiziq emas|qo'ng'iroq qilmang"),
    ],
  },
]

/**
 * Итог по реплике клиента.
 *
 * null означает «пока не понятно» — и это НОРМАЛЬНЫЙ, самый частый ответ. Классифицировать каждую
 * реплику любой ценой значит закрыть звонок на первом же «ну не знаю».
 */
export function detectOutcome(customerText: string): { outcome: CallOutcome; reason: string } | null {
  const text = String(customerText ?? '').trim()
  if (text.length < 2) return null
  for (const rule of OUTCOME_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      return { outcome: rule.outcome, reason: rule.reason }
    }
  }
  return null
}

/**
 * Пора ли завершать звонок.
 *
 * Отказ и «не тот номер» завершают СРАЗУ: продолжать после них — навязчивость, за которую в CRM
 * прилетает жалоба. Согласие на демо и просьба перезвонить дают боту ещё одну реплику: подтвердить
 * договорённость и попрощаться, иначе звонок обрывается на полуслове и человек не понимает, что
 * произошло.
 */
export function shouldHangUp(outcome: CallOutcome | null, botTurnsSinceOutcome: number): boolean {
  if (!outcome) return false
  if (outcome === 'REJECTED' || outcome === 'WRONG_NUMBER') return true
  return botTurnsSinceOutcome >= 1
}

/** Завершающая реплика под итог. Без неё звонок обрывается молча, и это выглядит как сбой связи. */
export function buildClosing(outcome: CallOutcome): string {
  switch (outcome) {
    case 'INTERESTED_DEMO':
      return 'Отлично, договорились. Менеджер свяжется с вами и подберёт удобное время. Хорошего дня!'
    case 'CALL_LATER':
      return 'Понял вас, перезвоним позже. Спасибо за уделённое время!'
    case 'REJECTED':
      return 'Понял, больше не побеспокоим. Хорошего дня!'
    case 'WRONG_NUMBER':
      return 'Прошу прощения за беспокойство. Всего доброго!'
    default:
      return 'Спасибо за разговор, хорошего дня!'
  }
}

// ── Состояние разговора ───────────────────────────────────────────────────────────────────────────

/**
 * Ход разговора: реплики, итог, счётчик реплик после его определения.
 *
 * Держит МИНИМУМ: история нужна для промпта и для пост-звонкового разбора, итог — для решения о
 * завершении. Всё остальное считается из этого и не хранится, чтобы не разъезжалось.
 */
export class DialogueState {
  readonly context: DialogueContext
  readonly turns: DialogueTurn[] = []
  private outcome: CallOutcome | null = null
  private outcomeReason: string | null = null
  private botTurnsSinceOutcome = 0

  constructor(context: DialogueContext = {}) {
    this.context = context
  }

  get detectedOutcome(): CallOutcome | null { return this.outcome }
  get detectedReason(): string | null { return this.outcomeReason }

  addCustomer(text: string, atMs: number): { outcome: CallOutcome; reason: string } | null {
    this.turns.push({ role: 'customer', text, atMs })
    const detected = detectOutcome(text)
    if (detected) {
      // Итог НЕ перезаписывается более поздним. Человек, сказавший «не интересно», а потом из
      // вежливости «ну хорошо, присылайте», — это отказ, и записывать его как согласие на демо значит
      // отправить менеджера к тому, кто уже отказал.
      if (!this.outcome) {
        this.outcome = detected.outcome
        this.outcomeReason = detected.reason
        this.botTurnsSinceOutcome = 0
      }
    }
    return detected
  }

  addBot(text: string, atMs: number): void {
    this.turns.push({ role: 'bot', text, atMs })
    if (this.outcome) this.botTurnsSinceOutcome += 1
  }

  shouldHangUp(): boolean { return shouldHangUp(this.outcome, this.botTurnsSinceOutcome) }

  /** История в формате сообщений для модели. Системный промпт добавляет вызывающий. */
  toMessages(): Array<{ role: 'assistant' | 'user'; content: string }> {
    return this.turns.map((turn) => ({
      role: turn.role === 'bot' ? ('assistant' as const) : ('user' as const),
      content: turn.text,
    }))
  }

  /**
   * Доля времени, которую говорил бот.
   *
   * Считается по ЗНАКАМ, а не по секундам: длительность реплики известна только для клиента (её мерил
   * детектор речи), а для бота пришлось бы измерять проигранное аудио. Знаки — грубая, но честная
   * оценка, и для коучинга менеджера её порядка достаточно. То, что это оценка, сказано в поле явно.
   */
  talkToListenRatio(): number {
    const bot = this.turns.filter((one) => one.role === 'bot').reduce((sum, one) => sum + one.text.length, 0)
    const customer = this.turns.filter((one) => one.role === 'customer').reduce((sum, one) => sum + one.text.length, 0)
    if (customer === 0) return bot === 0 ? 0 : 99
    return Number((bot / customer).toFixed(2))
  }

  /** Полный транскрипт для записи в telephony_calls.full_transcript. */
  transcript(): DialogueTurn[] { return [...this.turns] }
}

/** Итог звонка → итог для карточки менеджеру. WRONG_NUMBER карточки не порождает. */
export function outcomeToCardOutcome(outcome: CallOutcome): LeadCardNotification['outcome'] | null {
  return outcome === 'WRONG_NUMBER' ? null : outcome
}

export { OUTCOME_RULES }
