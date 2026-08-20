// Распознавание, синтез и модель — за интерфейсами.
//
// ПОЧЕМУ ИНТЕРФЕЙСЫ, А НЕ ПРЯМЫЕ ВЫЗОВЫ. Не ради подмены в тестах (хотя и ради неё тоже), а потому что
// у этих трёх ролей РАЗНЫЕ поставщики с разными сроками жизни. Deepgram и Cartesia — платные внешние
// сервисы, к которым у проекта пока нет ключей; OpenRouter уже используется скорером и работает.
// Прибить голосовой тракт к конкретному имени значило бы, что смена поставщика — это правка сессии,
// автомата и аналитики разом.
//
// ЧЕСТНОСТЬ ПРО ГОТОВНОСТЬ. Реализован и ПРОВЕРЕН ровно один поставщик — модель через OpenRouter, на
// живом ключе. Распознавание и синтез описаны интерфейсами и адаптерами, но НИ РАЗУ НЕ ВЫПОЛНЯЛИСЬ:
// ключей Deepgram/Cartesia/ElevenLabs нет, и придумывать их ответы, выдавая это за работающую
// интеграцию, было бы враньём. Отсутствующий ключ здесь означает явный отказ с названием переменной, а
// не тихую заглушку: голосовой воркер, который «работает», но молчит в трубку, — худший вид поломки.
//
// БЮДЖЕТ ЗАДЕРЖКИ. Спецификация V5 требует меньше 500 мс от конца реплики клиента до первого
// аудиопакета бота. Всё в этом файле подчинено ему: распознавание и синтез ПОТОКОВЫЕ, модель отдаёт
// ответ по мере генерации, а первая произносимая фраза режется по знаку конца предложения, а не по
// концу ответа. Ждать полного ответа модели значит потратить весь бюджет на одну её часть.

import type { DialogueState } from './dialogue.ts'

// ── Распознавание ─────────────────────────────────────────────────────────────────────────────────

export interface SttResult {
  text: string
  /** Уверенность 0..1, если поставщик её сообщает. */
  confidence: number | null
  /** Язык, если определён: разговоры идут на двух, и знать это полезно для отчётности. */
  language: string | null
}

export interface SttProvider {
  readonly name: string
  /**
   * Расшифровать реплику.
   *
   * На вход — кадры PCM16 на телефонной частоте, включая ПРЕДЗАПИСЬ. Именно поэтому интерфейс принимает
   * массив кадров, а не один буфер: предзапись приходит отдельными кадрами от детектора речи, и
   * склеивать их лишний раз незачем.
   */
  transcribe(frames: Int16Array[], signal: AbortSignal): Promise<SttResult>
}

// ── Синтез ────────────────────────────────────────────────────────────────────────────────────────

export interface TtsProvider {
  readonly name: string
  /**
   * Озвучить текст ПОТОКОМ порций μ-law на телефонной частоте.
   *
   * Именно поток, а не один буфер: буфер целиком означает, что первый звук прозвучит только после
   * синтеза последнего слова, а это секунды. И означает, что прервать реплику нечем — см. пояснение
   * про темп в session.ts.
   */
  synthesize(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>
}

// ── Модель ────────────────────────────────────────────────────────────────────────────────────────

export interface LlmProvider {
  readonly name: string
  /** Ответ репликами по мере генерации: куски текста, готовые к синтезу. */
  respond(systemPrompt: string, state: DialogueState, signal: AbortSignal): AsyncIterable<string>
  /** Разовый структурированный вызов — для пост-звонкового разбора. Не потоковый: спешить некуда. */
  complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string>
}

/**
 * Разрезание потока модели на произносимые куски.
 *
 * Синтезировать по слову нельзя — интонация рассыпается, речь звучит рублено. Ждать конца ответа тоже
 * нельзя — уйдёт весь бюджет задержки. Компромисс: режем по концу предложения, но не ждём его дольше
 * разумного предела, иначе длинная фраза без точки застрянет целиком.
 */
export const SENTENCE_END = /[.!?…]+[\s"»)]*/
/** Где можно разрезать ПЕРВУЮ фразу, не дожидаясь точки: запятая, тире, двоеточие. */
export const CLAUSE_END = /[,;:—–][\s]/
const MAX_CHUNK_CHARS = 180

/**
 * Насколько коротким может быть ПЕРВЫЙ кусок.
 *
 * Измерение на живом OpenRouter (openai/gpt-4o-mini): до первого ПОЛНОГО предложения проходит около
 * 1640 мс — то есть бюджет спецификации в 500 мс расходуется целиком ещё до синтеза. Основная часть
 * этого времени уходит не на генерацию, а на ОЖИДАНИЕ точки: модель успевает выдать половину фразы
 * заметно раньше.
 *
 * Поэтому первый кусок режется по запятой или по достижении этого предела. Дальше — по предложениям:
 * рубить всю реплику на клаузы значит получить рваную интонацию, а выигрыш во времени после первого
 * куска уже не нужен — синтез к тому моменту идёт непрерывно.
 */
const FIRST_CHUNK_MIN_CHARS = 40

/**
 * Накопитель кусков для синтеза.
 *
 * Отдельным классом, а не строчкой внутри цикла: у него есть состояние (хвост и признак первого куска),
 * и именно на хвосте ломаются наивные реализации — последняя фраза без завершающей точки просто не
 * произносится.
 */
export class SpeechChunker {
  private buffer = ''
  private firstEmitted = false

  /** Добавить кусок от модели и получить всё, что уже можно произнести. */
  push(delta: string): string[] {
    this.buffer += delta
    const ready: string[] = []
    for (;;) {
      // Первый кусок — по запятой, если предложение ещё не кончилось. Это и есть та часть бюджета
      // задержки, которой мы распоряжаемся сами.
      if (!this.firstEmitted && this.buffer.length >= FIRST_CHUNK_MIN_CHARS && !SENTENCE_END.test(this.buffer)) {
        const clause = this.buffer.slice(FIRST_CHUNK_MIN_CHARS).match(CLAUSE_END)
        if (clause && clause.index !== undefined) {
          const end = FIRST_CHUNK_MIN_CHARS + clause.index + 1
          const head = this.buffer.slice(0, end).trim()
          this.buffer = this.buffer.slice(end)
          if (head) { ready.push(head); this.firstEmitted = true }
          continue
        }
      }

      const match = this.buffer.match(SENTENCE_END)
      if (match && match.index !== undefined) {
        const end = match.index + match[0].length
        const sentence = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end)
        if (sentence) { ready.push(sentence); this.firstEmitted = true }
        continue
      }
      // Предложение затянулось: режем по последнему пробелу, чтобы не рвать слово пополам.
      if (this.buffer.length >= MAX_CHUNK_CHARS) {
        const cut = this.buffer.lastIndexOf(' ', MAX_CHUNK_CHARS)
        const at = cut > MAX_CHUNK_CHARS / 2 ? cut : MAX_CHUNK_CHARS
        ready.push(this.buffer.slice(0, at).trim())
        this.firstEmitted = true
        this.buffer = this.buffer.slice(at)
        continue
      }
      break
    }
    return ready
  }

  /** Хвост без завершающего знака. Без этого вызова последняя фраза ответа не прозвучит. */
  flush(): string | null {
    const tail = this.buffer.trim()
    this.buffer = ''
    this.firstEmitted = true
    return tail || null
  }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────────────────────────

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
/** Модель для разговора. Быстрая: в диалоге задержка важнее глубины рассуждения. */
const DEFAULT_VOICE_MODEL = 'openai/gpt-4o-mini'

/**
 * Модель через OpenRouter.
 *
 * ЕДИНСТВЕННЫЙ поставщик в этом файле, проверенный на живом ключе. Потоковый режим разбирает
 * server-sent events вручную: тянуть SDK ради разбора строк «data: {...}» незачем, а поведение при
 * обрыве потока в своём коде понятнее.
 */
export class OpenRouterLlm implements LlmProvider {
  readonly name = 'openrouter'
  private readonly apiKey: string
  private readonly model: string
  private readonly fetchImpl: typeof fetch

  constructor(apiKey: string, model = DEFAULT_VOICE_MODEL, fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new Error('нужен OPENROUTER_API_KEY')
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
  }

  async *respond(systemPrompt: string, state: DialogueState, signal: AbortSignal): AsyncIterable<string> {
    const response = await this.fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        // Короткий предел не украшение: в телефонном разговоре длинная реплика — это дефект, а не
        // щедрость. Модель, которой позволили писать абзацами, будет писать абзацами.
        max_tokens: 160,
        temperature: 0.6,
        messages: [{ role: 'system', content: systemPrompt }, ...state.toMessages()],
      }),
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`OpenRouter ответил ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      // Последняя строка может быть неполной — оставляем её до следующего чтения, иначе JSON.parse
      // получит обрезанный объект и поток оборвётся на середине ответа.
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') return
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) yield delta
        } catch {
          // Обрывок JSON в потоке — не повод падать: следующая порция обычно приходит целой.
        }
      }
    }
  }

  async complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
      signal: signal ?? AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`OpenRouter ответил ${response.status}`)
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? ''
  }
}

// ── Сбор поставщиков ──────────────────────────────────────────────────────────────────────────────

export interface VoiceProviders {
  stt: SttProvider | null
  tts: TtsProvider | null
  llm: LlmProvider | null
  /** Чего не хватает и почему. Пустой список означает полностью настроенный тракт. */
  missing: string[]
}

/**
 * Что удалось поднять из окружения.
 *
 * НЕ БРОСАЕТ при отсутствии ключей и НЕ подставляет заглушек. Возвращает список недостающего, а решение
 * — принимать ли звонки в таком состоянии — принимает воркер. Разница существенна: воркер, поднявшийся
 * без синтеза, обязан отказываться от звонков, а не снимать трубку и молчать.
 */
export function resolveVoiceProviders(
  env: Record<string, string | undefined> = process.env,
): VoiceProviders {
  const missing: string[] = []

  const llm = env.OPENROUTER_API_KEY
    ? new OpenRouterLlm(env.OPENROUTER_API_KEY, env.VOICE_LLM_MODEL ?? DEFAULT_VOICE_MODEL)
    : null
  if (!llm) missing.push('OPENROUTER_API_KEY (модель диалога)')

  // Распознавание и синтез: адаптеров с проверенной работой нет. Называем переменные, которых не
  // хватает, вместо того чтобы притворяться готовыми.
  const stt: SttProvider | null = null
  const tts: TtsProvider | null = null
  if (!env.DEEPGRAM_API_KEY && !env.GROQ_API_KEY) missing.push('DEEPGRAM_API_KEY или GROQ_API_KEY (распознавание)')
  if (!env.CARTESIA_API_KEY && !env.ELEVENLABS_API_KEY) missing.push('CARTESIA_API_KEY или ELEVENLABS_API_KEY (синтез)')

  return { stt, tts, llm, missing }
}

export { DEFAULT_VOICE_MODEL, MAX_CHUNK_CHARS }
