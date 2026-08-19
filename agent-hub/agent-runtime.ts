// Агентное ядро: цикл «подумал — вызвал инструмент — посмотрел результат — решил дальше».
//
// ЧТО ЭТО ЗАМЕНЯЕТ. Раньше CLI был визардом: четыре вопроса по сценарию и один прогон. Визард умеет
// ровно то, что в него заложили, и любое «а посмотри ещё сайт этой компании» требует новой ветки в
// коде. Здесь наоборот: инструменты объявлены, а последовательность их вызова решает модель — она же
// извлекает параметры из свободной фразы и переспрашивает только то, чего действительно не хватает.
//
// ── ЧЕТЫРЕ ВЕЩИ, КОТОРЫЕ ЗДЕСЬ ЛЕГКО СЛОМАТЬ, И КАЖДАЯ ЛОМАЕТСЯ ТИХО ───────────────────────────
//
// 1. СБОРКА ФРАГМЕНТОВ tool_calls. В потоковом режиме аргументы инструмента приходят КУСКАМИ строки:
//    сначала `{"que`, потом `ry":"стома`, потом `тология"}`. Собирать их надо ПО ПОЛЮ index, а не по
//    позиции в массиве очередного фрагмента — модель может звать два инструмента разом, и во втором
//    фрагменте первым элементом окажется второй вызов. Ошибка здесь даёт JSON.parse на обрывке и
//    выглядит как «модель прислала мусор».
//
// 2. ССЫЛКА tool_call_id. Результат инструмента возвращается сообщением с тем же идентификатором,
//    который прислала модель. Потерянный или перепутанный id — отказ следующего запроса с сообщением
//    про несоответствие сообщений, по которому непонятно, что именно не сошлось.
//
// 3. ПРЕДЕЛ ИТЕРАЦИЙ. Модель, получившая неудачный результат инструмента, охотно зовёт его снова.
//    Без предела это бесконечный круг, оплачиваемый по токенам.
//
// 4. ГРАНИЦА ПРАВ. Модель предлагает вызов на основании текста, который писала не она: содержимое
//    чужого сайта, чужая карточка компании. Инструмент с побочным действием (отправить сообщение,
//    записать в CRM) обязан требовать подтверждения человека, а не выполняться по решению модели.

import { ToolRegistry, type ToolContext, type ToolOutcome } from './tools/registry.ts'

/** Сообщение в истории сессии. Форма — как у OpenRouter, чтобы не переводить туда-обратно. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Предел шагов в одном ответе.
 *
 * Двенадцать — с запасом на осмысленную цепочку («найди лидов → посмотри сайт первого → отправь
 * карточку») и заметно меньше числа, на котором круг из повторяющихся вызовов успеет стоить дорого.
 */
export const MAX_STEPS = 12

/** Предел размера результата инструмента, уходящего обратно в модель. */
const MAX_TOOL_RESULT_CHARS = 12_000

export type AgentEvent =
  /** Кусок текста ответа. Приходит по мере генерации — это и есть потоковый вывод. */
  | { type: 'text'; delta: string }
  /** Модель решила вызвать инструмент. Аргументы уже собраны и разобраны. */
  | { type: 'tool_start'; name: string; args: Record<string, unknown>; step: number }
  | { type: 'tool_end'; name: string; outcome: ToolOutcome; step: number }
  /** Инструмент требует подтверждения человека. Ответ приходит через confirm(). */
  | { type: 'tool_needs_confirmation'; name: string; args: Record<string, unknown> }
  | { type: 'step'; step: number; of: number }
  | { type: 'error'; message: string }

export interface AgentDeps {
  registry: ToolRegistry
  /** Потоковый вызов модели. Отдельным параметром — чтобы цикл проверялся без сети и без ключа. */
  stream: (messages: ChatMessage[], tools: unknown[], signal: AbortSignal) => AsyncIterable<StreamChunk>
  /** Спросить человека про действие с побочным эффектом. Нет функции — действия запрещены. */
  confirm?: (name: string, args: Record<string, unknown>) => Promise<boolean>
  onEvent?: (event: AgentEvent) => void
  maxSteps?: number
}

/** Фрагмент потока в разобранном виде: либо текст, либо кусок вызова инструмента. */
export type StreamChunk =
  | { kind: 'text'; delta: string }
  | { kind: 'tool_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { kind: 'done'; reason: string | null }

/**
 * Накопитель фрагментов вызова инструмента.
 *
 * Ключ — index из потока, и это не деталь реализации: модель может начать два вызова параллельно, и
 * во втором фрагменте первым элементом массива придёт вызов с index 1. Сборка по позиции в массиве
 * склеила бы аргументы разных инструментов в одну строку, а JSON.parse затем выдал бы ошибку разбора,
 * по которой невозможно понять, что произошло.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>()

  push(chunk: Extract<StreamChunk, { kind: 'tool_delta' }>): void {
    const existing = this.byIndex.get(chunk.index) ?? { id: '', name: '', args: '' }
    // Идентификатор и имя приходят ОДИН раз, обычно в первом фрагменте. Перезаписывать их пустой
    // строкой из последующих фрагментов нельзя — потерянный id ломает следующий запрос целиком.
    if (chunk.id) existing.id = chunk.id
    if (chunk.name) existing.name = chunk.name
    if (chunk.argsDelta) existing.args += chunk.argsDelta
    this.byIndex.set(chunk.index, existing)
  }

  /** Собранные вызовы в порядке индексов. Пустой список означает, что модель ответила текстом. */
  finish(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([, call]) => ({
        id: call.id || `call_${call.name}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args || '{}' },
      }))
  }

  get isEmpty(): boolean { return this.byIndex.size === 0 }
}

/**
 * Разбор аргументов инструмента.
 *
 * Модель регулярно присылает почти-JSON: обёртку ```json, оборванную строку, пустоту вместо `{}`.
 * Отказ здесь возвращается ЗНАЧЕНИЕМ и уходит модели как результат инструмента — она перевызывает его
 * с исправленными аргументами. Исключение вместо этого оборвало бы весь ответ.
 */
export function parseToolArguments(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, args: {} }
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    const parsed = JSON.parse(unfenced)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> }
    }
    return { ok: false, error: 'аргументы должны быть объектом' }
  } catch (error) {
    return { ok: false, error: `аргументы не разбираются как JSON: ${(error as Error).message}` }
  }
}

/**
 * Результат инструмента → строка для модели.
 *
 * Режется по длине: страница сайта на двести килобайт, отданная модели целиком, съедает контекст и
 * стоит денег, не добавляя ничего к решению. Обрезка помечается явно — иначе модель принимает обрывок
 * за полные данные и делает вывод по половине списка.
 */
export function formatToolResult(outcome: ToolOutcome): string {
  if (!outcome.ok) return JSON.stringify({ ok: false, error: outcome.error, code: outcome.code })
  const serialized = JSON.stringify({ ok: true, result: outcome.result })
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized
  return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}… [РЕЗУЛЬТАТ ОБРЕЗАН: показано ${MAX_TOOL_RESULT_CHARS} из ${serialized.length} знаков]`
}

/**
 * Сессия: история сообщений и цикл.
 *
 * История живёт в объекте, а не в файле: сеанс CLI короткий, а сохранять переписку с моделью на диск
 * без спроса — это хранить чужие данные без причины. Кому нужна история между запусками, сохраняет её
 * сам через fs_export.
 */
export class AgentSession {
  readonly messages: ChatMessage[] = []
  private readonly deps: AgentDeps
  private readonly maxSteps: number

  constructor(systemPrompt: string, deps: AgentDeps) {
    this.deps = deps
    this.maxSteps = deps.maxSteps ?? MAX_STEPS
    this.messages.push({ role: 'system', content: systemPrompt })
  }

  /** Сколько реплик в истории без системной. Для отображения и для решения о сжатии. */
  get turnCount(): number { return this.messages.filter((one) => one.role !== 'system').length }

  /**
   * Заменить системный промпт НА МЕСТЕ.
   *
   * Именно на месте, а не добавлением второй системной реплики: две системные реплики с разными
   * ролями противоречат друг другу, и модель следует то одной, то другой. Смена роли должна отменять
   * прежнюю, а не спорить с ней.
   */
  setSystemPrompt(prompt: string): void {
    const at = this.messages.findIndex((one) => one.role === 'system')
    if (at === -1) this.messages.unshift({ role: 'system', content: prompt })
    else this.messages[at] = { role: 'system', content: prompt }
  }

  /**
   * Записать в историю вызов инструмента, сделанный НЕ моделью.
   *
   * Нужно для команд вроде `/browse <url>`: человек вызвал инструмент напрямую, минуя модель, но
   * результат обязан попасть в контекст — иначе следующий вопрос «а что там про запись онлайн?»
   * модель встретит с пустыми руками и либо переспросит, либо выдумает.
   *
   * Обе реплики кладутся ВМЕСТЕ и только вместе. Реплика с вызовом без ответа и ответ без вызова
   * одинаково отвергаются провайдером — причём не сейчас, а на следующем запросе, когда связь с
   * командой уже не видна.
   */
  recordToolCall(name: string, args: Record<string, unknown>, content: string): void {
    const id = `manual_${name}_${this.messages.length}`
    this.messages.push({
      role: 'assistant',
      // Пояснение, а не пустота: без него в выгрузке сессии видно вызов, взявшийся ниоткуда.
      content: `(вызов ${name} по прямой команде человека)`,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    })
    this.messages.push({ role: 'tool', tool_call_id: id, name, content })
  }

  /** Сменить модель: поток строится вызывающей стороной, сессия лишь принимает новый. */
  setStream(stream: AgentDeps['stream']): void {
    ;(this.deps as { stream: AgentDeps['stream'] }).stream = stream
  }

  /** Забыть разговор, сохранив роль. Системный промпт — это настройка, а не часть беседы. */
  reset(): void {
    const system = this.messages.find((one) => one.role === 'system')
    this.messages.length = 0
    if (system) this.messages.push(system)
  }

  /**
   * Убрать последний ход человека ВМЕСТЕ со всем, что модель на него ответила.
   *
   * Границей служит последняя реплика человека, а не «две последние реплики». Ход — это не пара
   * сообщений: между вопросом и ответом лежат реплика модели с вызовами инструментов и результаты
   * этих вызовов. Снять «две последние» значит оставить в истории результат инструмента без реплики,
   * которая его заказала, — а по протоколу такое сообщение отвергается вместе со всем запросом.
   */
  undoLastTurn(): boolean {
    const at = this.messages.findLastIndex((one) => one.role === 'user')
    if (at === -1) return false
    this.messages.length = at
    return true
  }

  /**
   * Заменить старую часть разговора пересказом.
   *
   * `keepTurns` — сколько последних ходов человека оставить дословно. Граница среза ВСЕГДА совпадает
   * с репликой человека по той же причине, что и в undoLastTurn: срез посреди группы «вызовы →
   * результаты» оставляет результат без заказавшей его реплики, и следующий запрос отвергается
   * целиком. Поэтому граница не «последние N сообщений», а «начало N-го с конца хода».
   *
   * Пересказ ложится парой «человек попросил напомнить → модель напомнила»: это единственная форма,
   * которую принимают все провайдеры. Вторая системная реплика формально короче, но у Anthropic
   * системная реплика одна, и лишняя молча превращается в пользовательскую — то есть в ту же пару,
   * только неявно.
   */
  async compact(
    summarize: (messages: readonly ChatMessage[]) => Promise<string>,
    keepTurns = 2,
  ): Promise<{ before: number; after: number; summarized: number }> {
    const before = this.messages.length
    const userAt = this.messages.flatMap((one, index) => (one.role === 'user' ? [index] : []))
    // Сжимать нечего, пока ходов не больше, чем велено сохранить дословно.
    if (userAt.length <= keepTurns) return { before, after: before, summarized: 0 }

    const cut = userAt[userAt.length - keepTurns]
    const system = this.messages.filter((one) => one.role === 'system')
    const older = this.messages.slice(0, cut).filter((one) => one.role !== 'system')
    const summary = await summarize(older)

    const tail = this.messages.slice(cut)
    this.messages.length = 0
    this.messages.push(...system)
    this.messages.push({ role: 'user', content: 'Напомни, о чём мы говорили раньше.' })
    this.messages.push({ role: 'assistant', content: summary })
    this.messages.push(...tail)
    return { before, after: this.messages.length, summarized: older.length }
  }

  /**
   * Обработать реплику человека до конца — то есть до текстового ответа или до предела шагов.
   *
   * Возвращает финальный текст. События (текст по кускам, вызовы инструментов) уходят в onEvent по
   * ходу: вызывающий рисует их в терминале, не дожидаясь конца.
   */
  async send(userText: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
    this.messages.push({ role: 'user', content: userText })

    let finalText = ''
    for (let step = 1; step <= this.maxSteps; step++) {
      this.deps.onEvent?.({ type: 'step', step, of: this.maxSteps })

      const context: ToolContext = { signal }
      const tools = this.deps.registry.describeForOpenRouter({
        ...context,
        // Модели показываются ВСЕ инструменты, включая требующие подтверждения, — иначе она не сможет
        // даже предложить отправку карточки. Право проверяется в момент вызова, а не показа: это
        // отличается от серверного режима, где показывать запрещённое бессмысленно.
        allowedActions: this.deps.confirm ? this.deps.registry.names() : [],
      })

      const accumulator = new ToolCallAccumulator()
      let text = ''
      try {
        for await (const chunk of this.deps.stream(this.messages, tools, signal)) {
          if (chunk.kind === 'text' && chunk.delta) {
            text += chunk.delta
            this.deps.onEvent?.({ type: 'text', delta: chunk.delta })
          } else if (chunk.kind === 'tool_delta') {
            accumulator.push(chunk)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.onEvent?.({ type: 'error', message })
        // Отказ модели НЕ роняет сессию: история цела, человек может повторить или спросить иначе.
        return finalText || `Не удалось получить ответ: ${message}`
      }

      const calls = accumulator.finish()
      if (!calls.length) {
        // Модель ответила текстом — цикл закончен.
        this.messages.push({ role: 'assistant', content: text })
        return text
      }

      // Реплика модели с вызовами кладётся в историю ДО результатов: порядок обязателен по протоколу,
      // и обратный порядок даёт отказ следующего запроса.
      this.messages.push({ role: 'assistant', content: text || null, tool_calls: calls })
      finalText = text || finalText

      for (const call of calls) {
        const outcome = await this.runCall(call, context, step)
        this.messages.push({
          role: 'tool',
          // ТОТ ЖЕ идентификатор, что прислала модель: потерянный или изменённый ломает следующий
          // запрос с сообщением про несоответствие сообщений.
          tool_call_id: call.id,
          name: call.function.name,
          content: formatToolResult(outcome),
        })
      }
    }

    // Предел исчерпан. Говорим об этом ПРЯМО: молча оборванная цепочка выглядит как ответ, хотя работа
    // не доделана.
    const exhausted = `Остановился после ${this.maxSteps} шагов — задача оказалась длиннее ожидаемого.`
      + ' Уточните, что именно доделать.'
    this.messages.push({ role: 'assistant', content: exhausted })
    return exhausted
  }

  /**
   * Выполнить вызов, сообщив о его начале и ОБЯЗАТЕЛЬНО о завершении.
   *
   * Оба события живут здесь, а не внутри attemptCall, из-за их ПАРНОСТИ: на tool_start терминал рисует
   * открытую рамку, на tool_end закрывает её итогом. Каждый ранний выход внутри — это либо рамка,
   * оставшаяся открытой навсегда, либо низ рамки без верха. Оба варианта уже случались на прогонах:
   * первый при отказе человека подтвердить действие, второй при негодных аргументах от модели.
   *
   * Разбор аргументов тоже поднят сюда: рамку надо открыть ДО первой возможной неудачи, иначе о самом
   * факте вызова человек узнает только из строки с ошибкой.
   */
  private async runCall(call: ToolCall, context: ToolContext, step: number): Promise<ToolOutcome> {
    const name = call.function.name
    const parsed = parseToolArguments(call.function.arguments)
    // При негодном JSON показываем СЫРУЮ строку: по ней видно, что именно прислала модель, а пустой
    // список аргументов выглядел бы как вызов без параметров.
    const shown = parsed.ok ? parsed.args : { аргументы: call.function.arguments }
    this.deps.onEvent?.({ type: 'tool_start', name, args: shown, step })

    const outcome: ToolOutcome = parsed.ok
      ? await this.attemptCall(name, parsed.args, context, step)
      : { ok: false, name, code: 'invalid_arguments', error: parsed.error, durationMs: 0 }

    this.deps.onEvent?.({ type: 'tool_end', name, outcome, step })
    return outcome
  }

  /** Выполнить один вызов, спросив подтверждение, если инструмент меняет данные. */
  private async attemptCall(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
    step: number,
  ): Promise<ToolOutcome> {
    const parsed = { args }
    const tool = this.deps.registry.get(name)
    if (!tool) {
      return {
        ok: false, name, code: 'tool_not_found', durationMs: 0,
        error: `инструмента «${name}» нет. Доступны: ${this.deps.registry.names().join(', ')}`,
      }
    }

    let allowed: string[] = []
    if (tool.permission === 'action') {
      // ПОДТВЕРЖДЕНИЕ ЧЕЛОВЕКА, а не решение модели. Предложение вызвать инструмент модель строит по
      // тексту, который писала не она: содержимое чужого сайта, чужая карточка компании. Отправка
      // сообщения живому человеку и запись в чужую CRM не должны происходить по такому основанию.
      if (!this.deps.confirm) {
        return {
          ok: false, name, code: 'permission_denied', durationMs: 0,
          error: 'действие требует подтверждения, а спросить некого (неинтерактивный режим)',
        }
      }
      this.deps.onEvent?.({ type: 'tool_needs_confirmation', name, args: parsed.args })
      const approved = await this.deps.confirm(name, parsed.args)
      if (!approved) {
        // Отказ уходит модели РЕЗУЛЬТАТОМ, а не молчанием: она должна знать, что действие не выполнено,
        // и не отчитываться о нём как о сделанном.
        return {
          ok: false, name, code: 'permission_denied', durationMs: 0,
          error: 'человек отклонил это действие',
        }
      }
      allowed = [name]
    }

    return await this.deps.registry.call(name, parsed.args, { ...context, allowedActions: allowed })
  }
}

// ── OpenRouter ────────────────────────────────────────────────────────────────────────────────────

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
/**
 * Модель по умолчанию.
 *
 * Sonnet, а не самая дешёвая: здесь она решает, какой инструмент вызвать и с какими параметрами, и
 * ошибка в этом решении стоит настоящего прогона — запроса к чужому API, минут рендера, сообщения
 * живому человеку. Экономия на этом месте оплачивается впустую потраченной работой инструментов.
 */
export const DEFAULT_AGENT_MODEL = 'anthropic/claude-sonnet-4'

/**
 * Потоковый вызов OpenRouter с разбором server-sent events.
 *
 * Разбор свой, без SDK: нужен ровно один формат ответа, а поведение при обрыве потока в своём коде
 * понятнее. Неполная последняя строка ОСТАВЛЯЕТСЯ до следующего чтения — иначе JSON.parse получит
 * обрезанный объект и поток оборвётся на середине ответа.
 */
export function createOpenRouterStream(options: {
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  /** Другой адрес совместимого API — например локальная Ollama. */
  baseUrl?: string
}): AgentDeps['stream'] {
  const model = options.model ?? DEFAULT_AGENT_MODEL
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = (options.baseUrl ?? OPENROUTER_BASE).replace(/\/+$/, '')
  /*
   * КЛЮЧ УХОДИТ ТОЛЬКО В OPENROUTER.
   *
   * Смена адреса — это `/model local`, то есть запрос на localhost. Отправить туда ключ от платного
   * счёта означает раздать его любому процессу, слушающему порт 11434: у локальной Ollama нет проверки
   * подлинности, и любой, кто занял порт первым, получил бы ключ в заголовке.
   */
  const authorized = baseUrl === OPENROUTER_BASE

  return async function* stream(messages, tools, signal) {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: authorized
        ? { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: 2_000,
      }),
      signal,
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`OpenRouter ответил ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') { yield { kind: 'done', reason: 'stop' }; return }
        let parsed: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> }
        try {
          parsed = JSON.parse(payload)
        } catch {
          // Обрывок JSON в потоке — не повод падать: следующая порция обычно приходит целой.
          continue
        }
        const choice = parsed.choices?.[0]
        const delta = choice?.delta as { content?: string; tool_calls?: Array<Record<string, unknown>> } | undefined
        if (delta?.content) yield { kind: 'text', delta: delta.content }
        for (const raw of delta?.tool_calls ?? []) {
          const fn = raw.function as { name?: string; arguments?: string } | undefined
          yield {
            kind: 'tool_delta',
            // index — единственный надёжный ключ сборки. Позиция в массиве этого фрагмента им не
            // является: при двух параллельных вызовах порядок элементов между фрагментами меняется.
            index: Number(raw.index ?? 0),
            id: raw.id ? String(raw.id) : undefined,
            name: fn?.name,
            argsDelta: fn?.arguments,
          }
        }
        if (choice?.finish_reason) yield { kind: 'done', reason: choice.finish_reason }
      }
    }
  }
}

// ── Системный промпт ──────────────────────────────────────────────────────────────────────────────

/**
 * Кто такой агент и чего ему нельзя.
 *
 * ТРИ ЗАПРЕТА, каждый закрывает конкретный способ навредить:
 *
 *   Не отчитываться о невыполненном. Модель, получившая отказ инструмента, охотно пишет «отправил» —
 *   и человек узнаёт правду через день по отсутствию ответа от клиента.
 *
 *   Не выдумывать данные. Телефон и сайт компании модель придумывает убедительно, а звонить по ним
 *   будет живой менеджер.
 *
 *   Не звать действия без просьбы. Отправка карточки и запись в CRM касаются людей вне этого
 *   разговора; предлагать — да, делать по своей инициативе — нет.
 */
/**
 * Общая часть системного промпта.
 *
 * ЗДЕСЬ НЕТ УПОМИНАНИЯ B2B-ПРОДАЖ. Раньше первая строка объявляла Nemo ассистентом для продаж, и это
 * сужало его собственными руками: на просьбу разобрать логи или собрать видео модель отвечала, что
 * занимается лидогенерацией. Специализация задаётся ролью (`mission`), а роль по умолчанию —
 * универсальная.
 */
export const UNIVERSAL_MISSION = [
  'Ты — Nemo, автономный ассистент мультиагентной платформы Nemo AI.',
  'Ты работаешь в терминале и умеешь пользоваться инструментами: искать компании и людей, изучать сайты',
  'через браузер, слать сообщения, писать в CRM, собирать видео, обращаться к внешним сервисам по MCP и',
  'сохранять файлы. Круг задач не ограничен продажами: код, данные, телефония, медиа, поиск — всё это твоё.',
].join('\n')

export function buildAgentSystemPrompt(options: {
  toolNames: readonly string[]
  hasConfirm: boolean
  /** Специализация. Пусто — универсальная роль. */
  mission?: string
}): string {
  return [
    options.mission?.trim() || UNIVERSAL_MISSION,
    '',
    `ДОСТУПНЫЕ ИНСТРУМЕНТЫ: ${options.toolNames.join(', ')}.`,
    '',
    'КАК РАБОТАТЬ:',
    '— Из свободной фразы САМ извлекай параметры. «Найди 10 клиник в Ташкенте» — это ниша «стоматология',
    '  или клиники», город «Ташкент», предел 10. Не переспрашивай то, что уже сказано.',
    '— Переспрашивай, только если без ответа вызвать инструмент НЕЛЬЗЯ. Не хватает города — спроси',
    '  город, а не устраивай опрос из четырёх пунктов.',
    '— На вопросы о себе («кто ты», «что умеешь») отвечай обычным текстом, без вызова инструментов.',
    '— Отвечай по-русски, коротко и по делу. Это терминал, а не переписка.',
    '',
    'ЧЕГО НЕЛЬЗЯ:',
    '— НЕ сообщай о выполненном действии, если инструмент вернул ошибку или отказ. Скажи прямо, что не',
    '  получилось и почему.',
    '— НЕ выдумывай телефоны, адреса, названия компаний и цифры. Всё, чего нет в результатах',
    '  инструментов, ты не знаешь.',
    options.hasConfirm
      ? '— Действия, меняющие данные (отправка в Telegram, запись в CRM), требуют подтверждения человека.'
        + ' Предлагай их, но помни: подтверждение спрашивает система, и человек может отказать.'
      : '— Действия, меняющие данные, в этом режиме недоступны: подтвердить их некому.',
  ].join('\n')
}

/**
 * Сменить реестр инструментов на лету.
 *
 * Нужно для ролей: `/agent qa` сужает круг инструментов, `/agent general` возвращает полный. История
 * при этом НЕ трогается — в ней уже лежат результаты вызовов инструментов, которых в новой роли нет,
 * и это нормально: они описывают прошлое, а не будущие возможности.
 */
export function setSessionRegistry(session: AgentSession, registry: ToolRegistry): void {
  ;(session as unknown as { deps: { registry: ToolRegistry } }).deps.registry = registry
}
