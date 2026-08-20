// Сессия звонка: полный дуплекс, инициативный старт и barge-in.
//
// Это сердце голосового тракта. Здесь три вещи, каждая из которых по отдельности выглядит мелочью, а
// вместе решает, звучит бот живым собеседником или роботом из автоответчика.
//
// ── 1. ТЕМП ИСХОДЯЩЕГО ПОТОКА, И ПОЧЕМУ БЕЗ НЕГО BARGE-IN НЕВОЗМОЖЕН ─────────────────────────────
//
// Соблазн очевиден: получили аудио от синтеза — отправили целиком, пусть FreeSWITCH разбирается.
// Так делать НЕЛЬЗЯ, и причина не в нагрузке. Отправленное уже НЕ НАШЕ: оно лежит в буфере
// FreeSWITCH и будет проиграно человеку, что бы мы дальше ни решили. Отдав пять секунд синтеза одним
// куском, мы физически лишаемся возможности замолчать раньше пятой секунды — клиент говорит, бот его
// не слышит и продолжает вещать, а в журнале при этом честно записано «barge-in сработал за 180 мс».
//
// Поэтому исходящий поток отдаётся ПОРЦИЯМИ, с опережением не больше пары кадров. Задержка прерывания
// тогда равна этому опережению, а не длине реплики.
//
// ── 2. НОМЕР РЕПЛИКИ, И ПОЧЕМУ ФЛАГА «БОТ ГОВОРИТ» НЕДОСТАТОЧНО ──────────────────────────────────
//
// Прерывание случается ПОСРЕДИ работы: модель ещё дописывает ответ, синтез ещё режет его на куски, и
// эти куски продолжают приходить асинхронно секунду-другую после того, как мы решили замолчать.
// Флаг «бот сейчас не говорит» их не остановит — они просто начнут новую речь поверх нового ответа.
// Каждая порция помечена номером реплики, и порция с устаревшим номером выбрасывается. Это единственное
// надёжное средство: гонку между отменой и уже запущенной работой иначе не выиграть.
//
// ── 3. ИНИЦИАТИВНЫЙ СТАРТ ────────────────────────────────────────────────────────────────────────
//
// Бот здоровается сразу после ANSWER, не дожидаясь клиента. Тишина в первые секунды звонка читается
// как «сорвалось» — человек говорит «алло?» и кладёт трубку.

import { BYTES_PER_FRAME, FRAME_MS, FrameAssembler, muLawDecode } from './audio.ts'
import { SpeechDetector, type SpeechEvent, type VadBackend } from './vad.ts'

export type SessionState = 'idle' | 'greeting' | 'listening' | 'thinking' | 'speaking' | 'ended'

/**
 * Насколько далеко вперёд разрешено уходить исходящему потоку.
 *
 * Три кадра — шестьдесят миллисекунд. Это верхняя граница задержки прерывания и одновременно запас на
 * дрожание планировщика: меньше двух кадров — и звук начнёт прерываться на любой заминке процесса,
 * больше десяти — и barge-in станет заметно опаздывать.
 */
export const MAX_LOOKAHEAD_FRAMES = 3

export interface OutboundChunk {
  /** Аудио в μ-law на телефонной частоте, уже готовое к отправке. */
  audio: Uint8Array
  /** Номер реплики, к которой относится порция. Устаревшие выбрасываются. */
  turn: number
}

export interface SessionCallbacks {
  /** Отправить кадр в FreeSWITCH. */
  sendAudio: (frame: Uint8Array) => void
  /** Начать реплику бота: вернуть поток порций аудио. Должен уважать сигнал отмены. */
  speak: (text: string, turn: number, signal: AbortSignal) => AsyncIterable<Uint8Array>
  /** Что ответить на реплику клиента. Возвращает текст; вызывается после конца речи. */
  respond: (utterance: Int16Array[], turn: number, signal: AbortSignal) => Promise<string>
  /** Наблюдение: этап, задержка, прерывание. */
  onEvent?: (event: SessionEvent) => void
}

export type SessionEvent =
  | { type: 'state'; from: SessionState; to: SessionState }
  | { type: 'barge_in'; turn: number; afterMs: number }
  | { type: 'turn_latency'; turn: number; ms: number }
  | { type: 'speech'; event: SpeechEvent }
  | { type: 'dropped_stale_chunk'; turn: number; currentTurn: number }

/**
 * Одна телефонная сессия.
 *
 * Время приходит ПАРАМЕТРОМ (`now`), а не берётся из Date.now() внутри. Это не ради чистоты: без
 * управляемого времени проверить порог прерывания в 180 мс можно только реальными паузами, то есть
 * набор тестов начал бы занимать минуты и стал бы плавающим на загруженной машине.
 */
export class CallSession {
  readonly callId: string
  private readonly vad: VadBackend
  private readonly detector: SpeechDetector
  private readonly assembler = new FrameAssembler(BYTES_PER_FRAME)
  private readonly callbacks: SessionCallbacks
  private readonly now: () => number

  private state: SessionState = 'idle'
  private turn = 0
  private abort: AbortController | null = null
  /** Очередь кадров на отправку. Обрывается целиком при прерывании. */
  private outbound: Uint8Array[] = []
  private outboundTurn = 0
  private framesSentAhead = 0
  private lastSpeechRunMs = 0
  private utteranceFrames: Int16Array[] = []
  private lastTurnEndedAt = 0
  /**
   * Номер реплики, синтез которой ЕЩЁ РАБОТАЕТ.
   *
   * Без него мгновенный провал очереди читается как конец реплики. Синтез отдаёт порции медленнее,
   * чем линия их проигрывает, поэтому очередь регулярно пустеет на пару кадров посреди фразы — и
   * состояние переключалось на «слушаю». Дальше клиент начинал говорить, прерывать было уже нечего,
   * а бот через мгновение продолжал вещать поверх него. Симуляция показала это прямо: barge-in НЕ
   * СРАБОТАЛ на реплике, которая на слух ещё звучала.
   */
  private synthesisActiveTurn = 0

  constructor(options: {
    callId: string
    vad: VadBackend
    callbacks: SessionCallbacks
    detector?: SpeechDetector
    now?: () => number
  }) {
    this.callId = options.callId
    this.vad = options.vad
    this.detector = options.detector ?? new SpeechDetector()
    this.callbacks = options.callbacks
    this.now = options.now ?? (() => Date.now())
  }

  get currentState(): SessionState { return this.state }
  get currentTurn(): number { return this.turn }
  get queuedFrames(): number { return this.outbound.length }

  private setState(to: SessionState): void {
    if (this.state === to) return
    const from = this.state
    this.state = to
    this.callbacks.onEvent?.({ type: 'state', from, to })
  }

  /**
   * Трубку сняли — здороваемся первыми.
   *
   * Именно здесь, а не по первому звуку от клиента: тишина в начале звонка читается как обрыв.
   */
  onAnswer(greeting: string): void {
    if (this.state !== 'idle') return
    this.setState('greeting')
    // НЕ await. Синтез приветствия занимает секунды, и ожидание здесь означало бы, что входящее аудио
    // всё это время не разбирается — то есть перебить бота во время приветствия физически нельзя.
    // Именно это и показала симуляция: приветствие успевало сгенерироваться целиком до первого пакета.
    this.runBotTurn(greeting)
  }

  /**
   * Входящее аудио от FreeSWITCH.
   *
   * Пакет НЕ обязан быть кадром: между нами и коммутатором TCP и планировщик, пакеты склеиваются и
   * делятся. Накопитель возвращает поток к кадрам постоянной длины, иначе порог в миллисекундах
   * перестаёт что-либо значить.
   */
  async onAudio(chunk: Uint8Array): Promise<void> {
    if (this.state === 'ended') return
    for (const frame of this.assembler.push(chunk)) {
      const samples = muLawDecode(frame)
      const verdict = await this.vad.process(samples)
      const event = this.detector.push(samples, verdict.speech)
      if (event) await this.onSpeechEvent(event)
      else if (this.detector.isSpeaking) this.utteranceFrames.push(samples)
    }
  }

  private async onSpeechEvent(event: SpeechEvent): Promise<void> {
    this.callbacks.onEvent?.({ type: 'speech', event })

    if (event.type === 'speech_start') {
      // Сколько клиент УЖЕ говорил к моменту события. Это и есть длительность наложения голосов, и
      // измеряется она детектором, а не часами: первая версия ставила здесь `now()` и тут же вычитала
      // его из `now()`, получая ноль при любом пороге — метрика существовала и ничего не значила.
      this.lastSpeechRunMs = event.speechRunMs
      // Предзапись — начало реплики, прошедшее ДО того, как порог набрался. Без неё распознавание
      // получает фразу без первого слога.
      this.utteranceFrames = [...event.preroll]

      // ПРЕРЫВАНИЕ. Клиент заговорил, пока говорил бот, — бот замолкает немедленно.
      if (this.state === 'greeting' || this.state === 'speaking' || this.state === 'thinking') {
        this.bargeIn()
      }
      this.setState('listening')
      return
    }

    // Речь кончилась — пора отвечать.
    if (this.state !== 'listening') return
    const utterance = this.utteranceFrames
    this.utteranceFrames = []
    this.lastTurnEndedAt = this.now()
    this.setState('thinking')

    const turn = ++this.turn
    const controller = new AbortController()
    this.abort = controller
    try {
      const reply = await this.callbacks.respond(utterance, turn, controller.signal)
      // Пока думали, клиент мог заговорить снова — тогда номер реплики уже другой, и отвечать поздно.
      if (controller.signal.aborted || turn !== this.turn) return
      if (reply.trim()) this.runBotTurn(reply, turn)
      else this.setState('listening')
    } catch {
      // Отказ распознавания или модели не должен ронять звонок: человек на линии, и молчание для него
      // выглядит как обрыв. Возвращаемся к слушанию — следующая реплика может пройти.
      if (!controller.signal.aborted) this.setState('listening')
    }
  }

  /**
   * Замолчать НЕМЕДЛЕННО.
   *
   * Три действия и все три обязательны: отменить незавершённую работу, выбросить очередь и поднять
   * номер реплики. Пропуск любого оставляет способ, которым голос бота всё-таки прозвучит поверх
   * клиента: незавершённая работа дошлёт свои порции, очередь доиграет уже накопленное, а без нового
   * номера обе эти порции будут выглядеть законными.
   */
  private bargeIn(): void {
    const interrupted = this.turn
    this.abort?.abort()
    this.abort = null
    this.outbound = []
    this.framesSentAhead = 0
    this.synthesisActiveTurn = 0
    this.turn += 1
    this.callbacks.onEvent?.({
      type: 'barge_in',
      turn: interrupted,
      // Длительность наложения голосов: столько клиент говорил, пока бот ещё звучал.
      afterMs: this.lastSpeechRunMs,
    })
  }

  /**
   * Запустить реплику фоном.
   *
   * Отдельный метод, потому что необработанное отклонение промиса в Node роняет процесс целиком — то
   * есть один сбой синтеза оборвал бы ВСЕ идущие звонки, а не один.
   */
  private runBotTurn(text: string, existingTurn?: number): void {
    void this.startBotTurn(text, existingTurn).catch(() => { /* отказ синтеза обработан внутри */ })
  }

  /** Начать реплику бота: синтез отдаёт порции, они уходят в очередь под своим номером. */
  private async startBotTurn(text: string, existingTurn?: number): Promise<void> {
    const turn = existingTurn ?? ++this.turn
    const controller = new AbortController()
    this.abort = controller
    this.outboundTurn = turn
    this.setState('speaking')

    let firstChunkAt = 0
    this.synthesisActiveTurn = turn
    try {
      for await (const audio of this.callbacks.speak(text, turn, controller.signal)) {
        // Порция от УСТАРЕВШЕЙ реплики. Приходит после прерывания, потому что синтез уже работал и
        // остановиться мгновенно не мог. Выбрасываем молча для звонка, но заметно для наблюдения.
        if (turn !== this.turn) {
          this.callbacks.onEvent?.({ type: 'dropped_stale_chunk', turn, currentTurn: this.turn })
          continue
        }
        if (!firstChunkAt) {
          firstChunkAt = this.now()
          if (this.lastTurnEndedAt) {
            // Задержка от конца речи клиента до первого звука бота — та самая, у которой в
            // спецификации бюджет меньше 500 мс.
            this.callbacks.onEvent?.({ type: 'turn_latency', turn, ms: firstChunkAt - this.lastTurnEndedAt })
          }
        }
        this.enqueue(audio, turn)
      }
    } catch {
      // Отмена синтеза — штатный путь прерывания, а не сбой.
    } finally {
      if (this.synthesisActiveTurn === turn) this.synthesisActiveTurn = 0
    }
    if (turn === this.turn && this.state === 'speaking' && this.outbound.length === 0) {
      this.setState('listening')
    }
  }

  /** Положить аудио в очередь, разрезав на кадры. */
  private enqueue(audio: Uint8Array, turn: number): void {
    if (turn !== this.turn) return
    for (let offset = 0; offset < audio.length; offset += BYTES_PER_FRAME) {
      const end = Math.min(offset + BYTES_PER_FRAME, audio.length)
      const frame = new Uint8Array(BYTES_PER_FRAME)
      // Хвост короче кадра дополняется тишиной (0xFF в μ-law), а не обрезается: кадр неполной длины
      // сбивает выравнивание потока у принимающей стороны.
      frame.fill(0xff)
      frame.set(audio.subarray(offset, end))
      this.outbound.push(frame)
    }
  }

  /**
   * Отдать очередной кадр в линию. Вызывается таймером раз в FRAME_MS.
   *
   * Возвращает, был ли отправлен кадр. Опережение ограничено: см. пояснение в заголовке файла — это
   * и есть то, что делает прерывание возможным.
   */
  tick(): boolean {
    if (this.state === 'ended') return false
    if (this.outbound.length === 0) {
      this.framesSentAhead = Math.max(0, this.framesSentAhead - 1)
      // Пусто В ОЧЕРЕДИ — не то же самое, что реплика закончена: синтез может ещё работать.
      if (this.state === 'speaking' && this.synthesisActiveTurn !== this.turn) this.setState('listening')
      return false
    }
    if (this.framesSentAhead >= MAX_LOOKAHEAD_FRAMES) return false

    const frame = this.outbound.shift()!
    this.callbacks.sendAudio(frame)
    this.framesSentAhead += 1
    return true
  }

  /** Кадр проигран на той стороне: опережение уменьшилось. Вызывается тем же таймером. */
  onFramePlayed(): void {
    this.framesSentAhead = Math.max(0, this.framesSentAhead - 1)
  }

  /** Завершение звонка. Всё незавершённое отменяется, очередь чистится. */
  end(): void {
    this.abort?.abort()
    this.abort = null
    this.outbound = []
    this.assembler.reset()
    this.setState('ended')
  }
}

export { FRAME_MS }
