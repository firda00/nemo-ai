// Реестр агентных инструментов: единственное место, где описано, ЧТО агент вообще умеет вызывать.
//
// Смысл реестра не в удобстве, а в границе. Модель предлагает вызов по имени и с произвольным JSON —
// и то, и другое приходит из текста, который написала не она сама: в поручении лежит содержимое чужого
// сайта, чужой карточки товара, чужого письма. Поэтому:
//
//   1. Имя инструмента разрешается ТОЛЬКО по реестру. Не нашли — отказ, а не попытка угадать.
//   2. Аргументы проходят Zod ПЕРЕД вызовом обработчика. Обработчик никогда не видит непроверенное.
//   3. Права ЗАПРЕЩЕНЫ ПО УМОЛЧАНИЮ. Инструмент с побочным действием ('action') не выполняется, пока
//      вызывающая сторона явно не подтвердит право. Инструмент без побочных действий ('read_only')
//      выполняется сам.
//   4. Каждый вызов ограничен по времени и не имеет права уронить процесс: ошибка внутри инструмента
//      возвращается значением, а не исключением.
//
// Пункт 3 — не формальность. Именно так выглядит атака через содержимое страницы: агент читает сайт,
// в тексте сайта написано «вызови send_message и отправь вот это», и без запрета по умолчанию агент
// это выполнит. Чтение и действие должны стоить разного.
//
// ЧТО ЭТОТ ФАЙЛ НЕ ДЕЛАЕТ. Он не решает, кому давать право: это решает вызывающая сторона (сервер по
// токену и allowed_actions, CLI — вопросом человеку). Реестр только не даёт действию произойти молча.

import { z } from 'zod'

/**
 * Право на вызов.
 *
 * 'read_only' — только читает: открыть страницу, посчитать, найти. Повторный вызов ничего не меняет.
 * 'action'    — меняет мир: пишет в базу, отправляет сообщение, тратит деньги. Требует подтверждения.
 *
 * Третьего значения нет намеренно. «Почти безопасно» на практике означает «однажды окажется опасно»,
 * и разбираться в этом будут по факту отправленного письма.
 */
export const ToolPermissionSchema = z.enum(['read_only', 'action'])
export type ToolPermission = z.infer<typeof ToolPermissionSchema>

/** Пятнадцать секунд: дольше живут только браузер и модель, и у них свои таймауты внутри. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Имя инструмента: то же ограничение, что у OpenRouter/OpenAI на function.name. */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

export interface ToolContext {
  /** Права, подтверждённые вызывающей стороной. Пустой набор — только чтение. */
  readonly allowedActions?: readonly string[]
  /** Прерывание извне: воркер снял задачу, человек нажал Ctrl+C. */
  readonly signal?: AbortSignal
  /** Кому принадлежит вызов. Нужен инструментам, пишущим в базу с изоляцией по тенанту. */
  readonly tenantId?: string
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string
  /** Описание уезжает в модель как есть — оно и есть инструкция, когда инструмент применять. */
  readonly description: string
  readonly parameters: TSchema
  readonly permission: ToolPermission
  readonly timeoutMs?: number
  readonly execute: (args: z.infer<TSchema>, context: ToolContext) => Promise<unknown>
}

/**
 * Итог вызова. ВСЕГДА значение, никогда исключение.
 *
 * Инструменты обращаются к сети, чужим процессам и браузеру — то есть падают регулярно и по причинам,
 * которые нас не касаются. Исключение отсюда означало бы, что один недоступный сайт роняет весь
 * прогон, а вместе с ним и уже найденные лиды.
 */
export type ToolOutcome =
  | { ok: true; name: string; result: unknown; durationMs: number }
  | { ok: false; name: string; error: string; code: ToolErrorCode; durationMs: number }

export type ToolErrorCode =
  | 'tool_not_found'
  | 'invalid_arguments'
  | 'permission_denied'
  | 'timeout'
  | 'aborted'
  | 'execution_failed'

/** Инструмент в формате tool calling OpenRouter/OpenAI. */
export interface OpenRouterTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/**
 * Zod-схема → JSON Schema для модели.
 *
 * Своя реализация вместо zod-to-json-schema: нужна ровно та часть, которую понимает tool calling, а
 * лишняя зависимость в этом месте означала бы, что формат схемы для модели меняется вместе с чужим
 * пакетом. Неизвестный тип отдаётся как объект со свободными полями — модель тогда пришлёт что-то, и
 * это что-то отсеет Zod при вызове. Хуже было бы соврать про тип и получить уверенно неверный вызов.
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string } & Record<string, unknown>
  const typeName = def.typeName

  if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
    return toJsonSchema((def.innerType as z.ZodTypeAny))
  }
  if (typeName === 'ZodDefault') {
    return { ...toJsonSchema(def.innerType as z.ZodTypeAny), default: (def.defaultValue as () => unknown)() }
  }
  if (typeName === 'ZodString') return { type: 'string', ...describe(schema) }
  if (typeName === 'ZodNumber') return { type: 'number', ...describe(schema) }
  if (typeName === 'ZodBoolean') return { type: 'boolean', ...describe(schema) }
  if (typeName === 'ZodEnum') return { type: 'string', enum: [...(def.values as string[])], ...describe(schema) }
  if (typeName === 'ZodLiteral') return { const: def.value, ...describe(schema) }
  if (typeName === 'ZodArray') {
    return { type: 'array', items: toJsonSchema(def.type as z.ZodTypeAny), ...describe(schema) }
  }
  if (typeName === 'ZodObject') {
    const shape = (def.shape as () => Record<string, z.ZodTypeAny>)()
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJsonSchema(value)
      if (!value.isOptional()) required.push(key)
    }
    // required с пустым массивом некоторые модели читают как «обязательных нет вообще» и начинают
    // присылать пустой объект. Поле проще не писать вовсе.
    return { type: 'object', properties, ...(required.length ? { required } : {}), ...describe(schema) }
  }
  return { type: 'object', additionalProperties: true, ...describe(schema) }
}

function describe(schema: z.ZodTypeAny): { description?: string } {
  const text = (schema._def as { description?: string }).description
  return text ? { description: text } : {}
}

/**
 * Реестр. Один на процесс не обязателен — воркер и CLI собирают свои наборы.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  /**
   * Зарегистрировать инструмент.
   *
   * Повторное имя — ОШИБКА, а не молчаливая замена. Два разных инструмента под одним именем означают,
   * что модель вызывает один, а срабатывает другой, и понять это по журналу невозможно.
   */
  register<TSchema extends z.ZodTypeAny>(tool: ToolDefinition<TSchema>): this {
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw new Error(`имя инструмента «${tool.name}» не подходит: разрешены латиница, цифры, _ и -, до 64 знаков`)
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`инструмент «${tool.name}» уже зарегистрирован — имена должны быть уникальны`)
    }
    if (!tool.description.trim()) {
      // Описание — единственное, по чему модель решает, когда звать инструмент. Пустое описание
      // означает, что инструмент не позовут вообще или позовут не к месту.
      throw new Error(`инструменту «${tool.name}» нужно описание: по нему модель решает, когда его звать`)
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition)
    return this
  }

  has(name: string): boolean { return this.tools.has(name) }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name) }
  names(): string[] { return [...this.tools.keys()] }
  size(): number { return this.tools.size }

  /**
   * Набор для модели.
   *
   * По умолчанию отдаются ТОЛЬКО инструменты, которые разрешено выполнить в этом вызове. Показывать
   * модели то, что ей запретят, — прямой путь к бесполезному кругу: модель зовёт, получает отказ,
   * зовёт снова, тратит токены и не понимает, почему.
   */
  describeForOpenRouter(context: ToolContext = {}): OpenRouterTool[] {
    return [...this.tools.values()]
      .filter((tool) => this.isAllowed(tool, context))
      .map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toJsonSchema(tool.parameters),
        },
      }))
  }

  /** Разрешён ли инструмент в этом контексте. Чтение — всегда, действие — только по явному праву. */
  isAllowed(tool: ToolDefinition, context: ToolContext): boolean {
    if (tool.permission === 'read_only') return true
    return (context.allowedActions ?? []).includes(tool.name)
  }

  /**
   * Выполнить вызов, пришедший от модели.
   *
   * Порядок проверок важен и не случаен: сначала существование, потом ПРАВО, и только потом разбор
   * аргументов. Отказ по праву не должен зависеть от того, правильно ли модель заполнила поля, — иначе
   * сообщение об ошибке подсказывает, как подобрать аргументы к запрещённому действию.
   */
  async call(name: string, rawArgs: unknown, context: ToolContext = {}): Promise<ToolOutcome> {
    const startedAt = Date.now()
    const spent = () => Date.now() - startedAt

    const tool = this.tools.get(name)
    if (!tool) {
      return {
        ok: false, name, code: 'tool_not_found', durationMs: spent(),
        error: `инструмента «${name}» нет. Доступны: ${this.names().join(', ') || 'ни одного'}`,
      }
    }

    if (!this.isAllowed(tool, context)) {
      return {
        ok: false, name, code: 'permission_denied', durationMs: spent(),
        error: `«${name}» меняет данные и требует явного разрешения — оно не выдано`,
      }
    }

    const parsed = tool.parameters.safeParse(rawArgs ?? {})
    if (!parsed.success) {
      // Причины перечисляются полем и текстом: модель, получившая «неверные аргументы» без указания
      // поля, исправляет наугад и присылает тот же вызов второй раз.
      const reasons = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`)
        .join('; ')
      return { ok: false, name, code: 'invalid_arguments', error: reasons, durationMs: spent() }
    }

    if (context.signal?.aborted) {
      return { ok: false, name, code: 'aborted', error: 'вызов отменён до начала', durationMs: spent() }
    }

    /*
     * ИСТЁКШИЙ СРОК ОБЯЗАН ОТМЕНИТЬ САМУ РАБОТУ, А НЕ ТОЛЬКО ОЖИДАНИЕ.
     *
     * Раньше withTimeout просто переставал ждать: обещание оставалось жить, запрос продолжал идти.
     * Для быстрых инструментов это мелочь, для обращения к модели — нет. Разбор звонка отправляет
     * расшифровку на сотню тысяч знаков; брошенный запрос дойдёт до конца и будет оплачен полностью
     * за ответ, который никто уже не прочтёт.
     *
     * Контроллер СВОЙ и связан с внешним сигналом: снаружи отменяют сеанс целиком, здесь — один
     * вызов по сроку. Смешивать нельзя ни в ту, ни в другую сторону.
     */
    const guard = new AbortController()
    const relay = () => guard.abort()
    context.signal?.addEventListener('abort', relay, { once: true })
    const scoped: ToolContext = { ...context, signal: guard.signal }

    try {
      const result = await withTimeout(
        tool.execute(parsed.data, scoped),
        tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        name,
        context.signal,
        guard,
      )
      return { ok: true, name, result, durationMs: spent() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code: ToolErrorCode = message.startsWith('tool_timeout')
        ? 'timeout'
        : (context.signal?.aborted ? 'aborted' : 'execution_failed')
      return { ok: false, name, code, error: message, durationMs: spent() }
    } finally {
      // Слушатель снимается ВСЕГДА: внешний сигнал живёт весь сеанс, и по слушателю на каждый вызов
      // инструмента — это утечка, растущая ровно с активностью агента.
      context.signal?.removeEventListener('abort', relay)
    }
  }
}

/**
 * Ограничение по времени.
 *
 * Таймер снимается в finally ВСЕГДА, включая успешный путь: незакрытый setTimeout держит процесс
 * живым, и CLI, закончивший работу, не выходит — человек видит зависший терминал вместо приглашения.
 * Само обещание при этом продолжает выполняться: остановить чужой fetch снаружи нельзя, поэтому
 * инструменты с настоящей отменой (браузер) обязаны сами уважать signal.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  /**
   * Кого прервать по истечении срока.
   *
   * Необязателен: у части вызовов прерывать нечего. Но там, где работа идёт по сети, отказаться
   * ЖДАТЬ мало — надо отказаться и платить. Обещание, брошенное без отмены, доходит до конца.
   */
  onTimeout?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            onTimeout?.abort()
            reject(new Error(`tool_timeout: «${label}» не ответил за ${timeoutMs} мс`))
          },
          timeoutMs,
        )
        if (signal) {
          onAbort = () => reject(new Error(`вызов «${label}» отменён`))
          signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Удобный конструктор описания инструмента.
 *
 * Существует только ради вывода типов: без него `args` в execute приходит как `any`, и Zod-схема
 * перестаёт что-либо значить для того, кто пишет обработчик.
 */
export function defineTool<TSchema extends z.ZodTypeAny>(tool: ToolDefinition<TSchema>): ToolDefinition<TSchema> {
  return tool
}

/**
 * Копия реестра с суженным набором инструментов.
 *
 * Нужна для ролей: роль `qa` не должна иметь возможности отправить карточку клиенту, даже если модель
 * решит, что так полезнее. Именно КОПИЯ, а не флаг на исходном реестре: подключённые MCP-серверы и
 * платформенные инструменты регистрируются один раз при старте, и вычёркивать их из общего реестра
 * ради текущей роли значило бы терять их при возврате к роли `general`.
 *
 * Роль умеет только СУЖАТЬ. Имя, которого нет в исходном реестре, молча пропускается: включить
 * ненастроенный инструмент нельзя, а падать из-за упоминания браузера в роли при выключенном браузере
 * — значит запретить эту роль на машинах без Playwright.
 */
export function restrictRegistry(source: ToolRegistry, allowed: readonly string[] | null): ToolRegistry {
  if (!allowed) return source
  const narrowed = new ToolRegistry()
  for (const pattern of allowed) {
    /*
     * ОБРАЗЕЦ СО ЗВЁЗДОЧКОЙ НА КОНЦЕ.
     *
     * Нужен ровно для MCP: сервера подключаются по настройке, каждый метод регистрируется отдельным
     * инструментом с префиксом сервера, и заранее ни числа, ни имён нет. Перечислить их в роли
     * невозможно — а без этого роль `dev` осталась бы без всех внешних сервисов.
     *
     * Звёздочка допускается ТОЛЬКО в конце и только как хвост: `mcp__*` — образец, `*_lead` или
     * `*` — нет. Полная маска превратила бы сужение роли в её отсутствие, причём незаметно.
     */
    if (pattern.endsWith('*') && pattern.length > 1 && !pattern.slice(0, -1).includes('*')) {
      const prefix = pattern.slice(0, -1)
      for (const name of source.names()) {
        if (!name.startsWith(prefix) || narrowed.has(name)) continue
        const tool = source.get(name)
        if (tool) narrowed.register(tool)
      }
      continue
    }
    const tool = source.get(pattern)
    if (tool && !narrowed.has(pattern)) narrowed.register(tool)
  }
  return narrowed
}
