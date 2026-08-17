// Подключение внешних MCP-серверов как источника инструментов.
//
// MCP (Model Context Protocol) решает конкретную задачу: инструменты перестают быть кодом внутри
// нашего процесса. Нужен доступ к базе — поднимается postgres-mcp отдельным процессом; нужна работа
// с файлами — filesystem-mcp. Мы не пишем ни строчки их логики, только объявляем, что им можно.
//
// ГЛАВНОЕ ЗДЕСЬ — НЕДОВЕРИЕ К ЧУЖОМУ СЕРВЕРУ. Он присылает описания инструментов, и описание уезжает
// прямо в поручение модели. То есть чужой процесс получает возможность писать модели инструкции. Из
// этого следуют три правила, каждое проверено тестом:
//
//   1. Права по-прежнему НАШИ. MCP-сервер сообщает `readOnlyHint`, но это подсказка, а не решение.
//      Не отмеченный явно как читающий инструмент считается действием — то есть требует разрешения.
//      Наоборот делать нельзя: сервер, объявивший «drop_table — только чтение», выполнится молча.
//   2. Имена приводятся к нашему пространству имён (`mcp__<сервер>__<инструмент>`). Иначе чужой
//      сервер может назваться `browser_screenshot` и подменить наш инструмент, а модель не заметит.
//   3. Схема параметров чужая, и валидировать её нашими правилами мы не можем — она JSON Schema, а не
//      Zod. Поэтому аргументы передаются серверу как есть, но ФОРМА проверяется: объект, не строка,
//      не массив. Проверку содержимого делает сам сервер, и это его ответственность по протоколу.
//
// ЗАПУСК ПРОЦЕССОВ. StdioTransport запускает чужой исполняемый файл. Список серверов берётся из
// конфигурации, а не из ответа модели — модели нельзя дать выбирать, какую команду запустить в
// системе. Это тот же принцип, что в реестре инструментов: имя разрешается по списку, а не по строке.

import { z } from 'zod'
import { defineTool } from './registry.ts'
import type { OpenRouterTool, ToolDefinition, ToolPermission } from './registry.ts'

/** Как долго ждём ответа от чужого процесса. Минута: postgres-mcp на большом запросе бывает медленным. */
const CALL_TIMEOUT_MS = 60_000
/** Столько ждём, пока сервер поднимется и ответит на рукопожатие. */
const CONNECT_TIMEOUT_MS = 20_000

/**
 * Описание сервера в конфигурации.
 *
 * `command` и `args` — то, что будет запущено в системе. Поэтому источник этой структуры всегда
 * файл конфигурации или переменные окружения, и никогда не ответ модели или содержимое страницы.
 */
export const McpServerConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]{1,32}$/, 'имя сервера: строчные латинские, цифры, _ и -, до 32 знаков'),
  command: z.string().min(1, 'нужна команда запуска сервера'),
  args: z.array(z.string()).default([]),
  /**
   * Переменные окружения для дочернего процесса.
   *
   * Задаются ЯВНО и полностью: наследовать весь process.env в чужой процесс нельзя — там лежат
   * SUPABASE_SECRET_KEY, OPENROUTER_API_KEY и пепper токенов, и MCP-серверу они не нужны ни один.
   */
  env: z.record(z.string()).default({}),
  /**
   * Инструменты, которым разрешено менять данные.
   *
   * Список НАШ, а не сервера. Пустой — сервер работает только на чтение, что и нужно в большинстве
   * случаев: postgres-mcp для разбора схемы полезен и без права писать.
   */
  allowedActions: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

/** Инструмент, как его описал MCP-сервер. */
export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

/**
 * Наше имя для чужого инструмента.
 *
 * Префикс не украшение: без него сервер, назвавшийся `browser_screenshot`, встанет в реестр вместо
 * нашего инструмента с тем же именем — точнее, реестр честно откажет по дублю, и подключение сервера
 * сломает весь набор. С префиксом столкновение невозможно по построению.
 */
export function namespacedToolName(serverName: string, toolName: string): string {
  const safe = toolName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const full = `mcp__${serverName}__${safe}`
  // Предел OpenRouter/OpenAI на function.name — 64 знака. Обрезаем хвост ИМЕНИ, а не префикса:
  // потерять признак сервера хуже, чем потерять конец длинного названия инструмента.
  return full.length <= 64 ? full : full.slice(0, 64)
}

/**
 * Право на вызов чужого инструмента.
 *
 * ЗАПРЕТ ПО УМОЛЧАНИЮ, и подсказка сервера может только ПОНИЗИТЬ уровень доверия, никогда повысить:
 * `readOnlyHint: true` учитывается лишь тогда, когда инструмент назван в нашем списке разрешённых или
 * сервер вообще не объявлен как пишущий. Сервер, совравший про readOnlyHint, не должен получать
 * право на действие только потому, что сам себя так пометил.
 */
export function resolvePermission(
  descriptor: McpToolDescriptor,
  config: Pick<McpServerConfig, 'allowedActions'>,
): ToolPermission {
  // Явно разрушительный — действие всегда, что бы ещё сервер о себе ни сообщил.
  if (descriptor.annotations?.destructiveHint) return 'action'
  // Наш список важнее подсказок в обе стороны: назвали в allowedActions — значит знаем, что это
  // действие, и подтверждаем право отдельно, через контекст вызова.
  if (config.allowedActions.includes(descriptor.name)) return 'action'
  if (descriptor.annotations?.readOnlyHint === true) return 'read_only'
  // Молчание сервера — не признак безопасности. Инструмент без пометок считается действием.
  return 'action'
}

/**
 * JSON Schema чужого инструмента → Zod-схема для реестра.
 *
 * Полноценной трансляции здесь НЕТ и быть не должно: JSON Schema богаче Zod в тех местах, где нам
 * это не нужно, а неверная трансляция опаснее отсутствующей — она отсеет годный вызов и модель не
 * поймёт, почему. Проверяется только ФОРМА (объект) и наличие обязательных полей верхнего уровня.
 * Содержимое проверяет сам сервер: по протоколу это его обязанность, и он один знает свои правила.
 */
export function schemaFromJsonSchema(jsonSchema: Record<string, unknown> | undefined): z.ZodTypeAny {
  const required = Array.isArray(jsonSchema?.required) ? (jsonSchema.required as string[]) : []
  if (!required.length) {
    // passthrough: чужие поля должны доехать до сервера нетронутыми, иначе мы молча урежем вызов.
    return z.object({}).passthrough()
  }
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const key of required) {
    // Тип не сужаем: обязательное поле должно ПРИСУТСТВОВАТЬ, а годится ли его значение — решает
    // сервер. z.any() здесь честнее, чем угаданный z.string().
    shape[key] = z.any().refine((value) => value !== undefined, { message: `поле «${key}» обязательно` })
  }
  return z.object(shape).passthrough()
}

/** Инструменты сервера в формате tool calling OpenRouter — без участия реестра. */
export function toOpenRouterTools(serverName: string, descriptors: readonly McpToolDescriptor[]): OpenRouterTool[] {
  return descriptors.map((one) => ({
    type: 'function' as const,
    function: {
      name: namespacedToolName(serverName, one.name),
      description: one.description?.trim()
        || `Инструмент «${one.name}» с MCP-сервера ${serverName} (описание сервером не задано)`,
      parameters: (one.inputSchema && typeof one.inputSchema === 'object')
        ? one.inputSchema
        : { type: 'object', properties: {}, additionalProperties: true },
    },
  }))
}

/**
 * Текстовый результат из ответа MCP.
 *
 * Ответ приходит массивом блоков разного вида (text, image, resource). Модели нужен текст; картинки и
 * ресурсы упоминаются, но не разворачиваются — base64 изображения в поручении съест весь контекст, а
 * пользы даст ноль, потому что смотреть на него всё равно некому.
 */
export function extractTextContent(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return typeof result === 'string' ? result : JSON.stringify(result ?? null)
  const parts: string[] = []
  for (const block of content) {
    const item = block as { type?: string; text?: string; resource?: { uri?: string }; mimeType?: string }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'image') parts.push(`[изображение ${item.mimeType ?? 'без типа'}]`)
    else if (item.type === 'resource') parts.push(`[ресурс ${item.resource?.uri ?? 'без адреса'}]`)
    else parts.push(`[блок ${item.type ?? 'неизвестного вида'}]`)
  }
  return parts.join('\n')
}

/** То, что нам нужно от клиента MCP. Интерфейс — ради тестов без запуска чужих процессов. */
export interface McpSession {
  listTools(): Promise<{ tools: McpToolDescriptor[] }>
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void>
}

/**
 * Подключение к одному MCP-серверу.
 *
 * Держит дочерний процесс. Закрывать ОБЯЗАТЕЛЬНО: незакрытый stdio-транспорт оставляет процесс
 * сервера живым, и он переживёт наш CLI — ровно тот же зомби, что и незакрытый Chromium.
 */
export class McpConnection {
  private readonly config: McpServerConfig
  private session: McpSession | null = null
  private readonly connector: (config: McpServerConfig) => Promise<McpSession>
  private tools: McpToolDescriptor[] = []

  constructor(config: McpServerConfig, connector?: (config: McpServerConfig) => Promise<McpSession>) {
    this.config = McpServerConfigSchema.parse(config)
    this.connector = connector ?? connectViaStdio
  }

  get name(): string { return this.config.name }
  get descriptors(): readonly McpToolDescriptor[] { return this.tools }

  /** Поднять сервер и забрать список инструментов. */
  async connect(): Promise<McpToolDescriptor[]> {
    if (!this.session) this.session = await this.connector(this.config)
    const listed = await this.session.listTools()
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []
    return this.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.session) throw new Error(`сервер «${this.config.name}» не подключён`)
    const raw = await this.session.callTool({ name, arguments: args })
    // isError по протоколу — НЕ исключение транспорта, а сообщение об ошибке в успешном ответе.
    // Пропустить его значит выдать модели текст ошибки как результат работы.
    if ((raw as { isError?: boolean })?.isError) {
      throw new Error(`сервер «${this.config.name}» вернул ошибку: ${extractTextContent(raw)}`)
    }
    return extractTextContent(raw)
  }

  async close(): Promise<void> {
    const session = this.session
    this.session = null
    this.tools = []
    await session?.close().catch(() => {})
  }

  /**
   * Инструменты этого сервера в виде описаний для нашего реестра.
   *
   * Имена с префиксом, права по нашим правилам, вызов — через это же подключение.
   */
  toToolDefinitions(): ToolDefinition[] {
    return this.tools.map((descriptor) => defineTool({
      name: namespacedToolName(this.config.name, descriptor.name),
      description: descriptor.description?.trim()
        || `Инструмент «${descriptor.name}» с MCP-сервера ${this.config.name} (описание сервером не задано)`,
      permission: resolvePermission(descriptor, this.config),
      parameters: schemaFromJsonSchema(descriptor.inputSchema),
      timeoutMs: CALL_TIMEOUT_MS,
      // Внутрь уходит ИСХОДНОЕ имя: префикс — наша выдумка, сервер о нём не знает.
      execute: async (args) => await this.callTool(descriptor.name, args as Record<string, unknown>),
    }) as ToolDefinition)
  }
}

/**
 * Настоящее подключение через stdio.
 *
 * Импорт динамический: SDK тяжёлый, а прогон без MCP-серверов (то есть почти любой) не должен за него
 * платить. Окружение дочернего процесса собирается ЯВНО из config.env — наследование process.env
 * отдало бы чужому процессу все ключи проекта.
 */
async function connectViaStdio(config: McpServerConfig): Promise<McpSession> {
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ])

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // Системный минимум ПЛЮС явно заданное, и ничего больше.
    //
    // Полностью пустое окружение не работает: на Windows процесс без SYSTEMROOT и PATH умирает сразу
    // после запуска, и клиент видит только «Connection closed» — причина при этом не называется
    // нигде. getDefaultEnvironment() из SDK отдаёт ровно системный набор (PATH, HOME, TEMP…) и
    // НЕ содержит ни SUPABASE_SECRET_KEY, ни OPENROUTER_API_KEY, ни пеппера токенов: проверено
    // перечислением ключей, а не прочтением документации.
    env: { ...getDefaultEnvironment(), ...config.env },
    // Ошибки чужого процесса в наш stderr не пускаем: они выглядят как наши и путают того, кто
    // читает журнал прогона.
    stderr: 'pipe',
  })

  const client = new Client({ name: 'nemo-ai', version: '1.0.0' }, { capabilities: {} })

  const connecting = client.connect(transport)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP-сервер «${config.name}» не ответил за ${CONNECT_TIMEOUT_MS} мс`)),
          CONNECT_TIMEOUT_MS,
        )
      }),
    ])
  } catch (error) {
    // stderr упавшего сервера ДОБАВЛЯЕТСЯ к ошибке, и это не украшательство.
    //
    // Без него отказ выглядит как «MCP error -32000: Connection closed» — сообщение, по которому
    // нельзя понять ничего. Настоящая причина при этом лежала в stderr дочернего процесса и звучала
    // «Cannot find package '@modelcontextprotocol/sdk'». Разница между этими двумя текстами — час
    // работы того, кто будет настраивать сервер.
    const details = await readStderr(transport)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(details ? `${reason}. Сервер сказал: ${details}` : reason)
  } finally {
    if (timer) clearTimeout(timer)
  }

  return {
    listTools: async () => await client.listTools() as { tools: McpToolDescriptor[] },
    callTool: async (params) => await client.callTool(params),
    close: async () => { await client.close() },
  }
}

/**
 * Прочитать то, что дочерний процесс успел написать в stderr.
 *
 * Читается НЕБЛОКИРУЮЩЕ и с коротким пределом: процесс уже мёртв, поток закрыт, и ждать здесь нечего.
 * Пустой результат — законный случай (сервер упал молча), поэтому любая неудача чтения даёт пустую
 * строку, а не исключение: диагностика не имеет права стать второй причиной отказа.
 */
async function readStderr(transport: { stderr?: unknown }): Promise<string> {
  const stream = transport.stderr as
    | { readable?: boolean; read?: () => unknown; on?: (event: string, fn: (chunk: unknown) => void) => void }
    | null
    | undefined
  if (!stream || typeof stream.on !== 'function') return ''
  return await new Promise<string>((resolve) => {
    let text = ''
    const done = () => resolve(text.trim().slice(0, 600))
    stream.on('data', (chunk) => { text += String(chunk) })
    stream.on('end', done)
    stream.on('close', done)
    stream.on('error', done)
    setTimeout(done, 500).unref?.()
  })
}

/**
 * Список серверов из окружения.
 *
 * Формат — JSON в NEMO_MCP_SERVERS. Негодный JSON называется вслух и НЕ игнорируется: молча
 * пропущенная опечатка означает, что агент работает без половины инструментов, а узнают об этом по
 * непонятно плохому результату через неделю.
 */
export function resolveMcpServers(
  env: Record<string, string | undefined> = process.env,
): { servers: McpServerConfig[]; error?: string } {
  const raw = env.NEMO_MCP_SERVERS
  if (!raw?.trim()) return { servers: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { servers: [], error: `NEMO_MCP_SERVERS не разбирается как JSON: ${(error as Error).message}` }
  }
  const list = z.array(McpServerConfigSchema).safeParse(parsed)
  if (!list.success) {
    const reasons = list.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { servers: [], error: `NEMO_MCP_SERVERS описан неверно: ${reasons}` }
  }
  return { servers: list.data.filter((one) => one.enabled) }
}

/**
 * Подключить все серверы и зарегистрировать их инструменты.
 *
 * Отказ ОДНОГО сервера не отменяет остальные: MCP-серверы — сторонние процессы, и «postgres-mcp не
 * установлен» не повод лишить агента файловых инструментов. Отказы возвращаются списком, чтобы
 * вызывающая сторона могла их назвать, а не проглотить.
 */
export async function connectMcpServers(
  registry: { register: (tool: ToolDefinition) => unknown; has: (name: string) => boolean },
  servers: readonly McpServerConfig[],
  connector?: (config: McpServerConfig) => Promise<McpSession>,
): Promise<{
  connections: McpConnection[]
  registered: string[]
  failures: Array<{ server: string; error: string }>
  close: () => Promise<void>
}> {
  const connections: McpConnection[] = []
  const registered: string[] = []
  const failures: Array<{ server: string; error: string }> = []

  for (const config of servers) {
    const connection = new McpConnection(config, connector)
    try {
      await connection.connect()
      for (const tool of connection.toToolDefinitions()) {
        // Дубль означал бы, что два сервера назвались одинаково — с префиксом это возможно только
        // при одинаковом имени сервера, то есть при ошибке в конфигурации. Молча заменять нельзя.
        if (registry.has(tool.name)) {
          failures.push({ server: config.name, error: `инструмент «${tool.name}» уже есть в реестре` })
          continue
        }
        registry.register(tool)
        registered.push(tool.name)
      }
      connections.push(connection)
    } catch (error) {
      failures.push({ server: config.name, error: error instanceof Error ? error.message : String(error) })
      await connection.close()
    }
  }

  return {
    connections,
    registered,
    failures,
    close: async () => { await Promise.all(connections.map((one) => one.close())) },
  }
}

export { CALL_TIMEOUT_MS, CONNECT_TIMEOUT_MS }
