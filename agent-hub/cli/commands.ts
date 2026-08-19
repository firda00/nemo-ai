// Слеш-команды CLI: разбор, автодополнение, исполнение.
//
// ОТДЕЛЬНО ОТ ТОЧКИ ВХОДА, потому что здесь живут решения, которые ломают сессию тихо: срез истории,
// смена роли, смена модели. Их проверяют вызовом функции, а не запуском терминала.
//
// ПРАВИЛО ФАЙЛА: команда либо делает ровно то, что обещает её имя, либо отказывается вслух. Молчаливый
// отказ хуже ошибки — человек продолжает работать, считая, что модель сменилась или контекст сжат.

import type { AgentSession, ChatMessage } from '../agent-runtime.ts'
import { DEFAULT_AGENT_MODEL } from '../agent-runtime.ts'
import type { ToolRegistry } from '../tools/registry.ts'

// ─── Роли ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Роль — это специализация промпта И круг инструментов.
 *
 * Ограничение инструментов не косметика: роль `qa` не должна иметь возможности отправить карточку
 * клиенту, даже если модель решит, что так будет полезнее. Роль `general` видит всё — она умолчание.
 *
 * `tools: null` означает «все зарегистрированные». Список имён означает «только эти, если они есть»:
 * роль не может ВКЛЮЧИТЬ инструмент, который не настроен, — она только сужает.
 */
export interface AgentRole {
  readonly name: string
  readonly title: string
  readonly mission: string
  readonly tools: readonly string[] | null
}

export const AGENT_ROLES: Record<string, AgentRole> = {
  general: {
    name: 'general',
    title: 'универсальный',
    mission: '',
    tools: null,
  },
  sdr: {
    name: 'sdr',
    title: 'поиск клиентов',
    mission: [
      'Ты — Nemo в режиме поиска клиентов для Ustudy IT.',
      'Твоя работа: найти компании по нише и городу, собрать контакты, оценить соответствие профилю',
      'клиента и передать лучших менеджеру. Оценку и причину бери из результатов инструментов, не из головы.',
    ].join('\n'),
    tools: ['search_leads', 'browser_navigate_and_extract', 'browser_screenshot', 'telegram_send_lead', 'crm_sync_lead', 'fs_export'],
  },
  dev: {
    name: 'dev',
    title: 'инженер',
    mission: [
      'Ты — Nemo в режиме инженерного помощника.',
      'Твоя работа: разбираться в коде, данных и внешних сервисах, объяснять причины поведения и',
      'предлагать наименьшее безопасное изменение. Прежде чем утверждать, проверь инструментом.',
    ].join('\n'),
    tools: null,
  },
  qa: {
    name: 'qa',
    title: 'проверка',
    mission: [
      'Ты — Nemo в режиме проверки.',
      'Твоя работа: открывать страницы, сверять обещанное с фактическим и сообщать расхождения.',
      'Ты НИЧЕГО не отправляешь наружу и не меняешь чужие данные — только смотришь и сообщаешь.',
    ].join('\n'),
    // Ни отправки в Telegram, ни записи в CRM: у проверяющего не должно быть возможности задеть
    // боевые данные, даже случайно.
    tools: ['browser_navigate_and_extract', 'browser_screenshot', 'search_leads', 'fs_export'],
  },
  media: {
    name: 'media',
    title: 'медиа',
    mission: [
      'Ты — Nemo в режиме сборки роликов.',
      'Твоя работа: собирать вертикальные видео 9:16 с субтитрами под соцсети. Держи текст коротким:',
      'длинная строка субтитра не влезает в кадр телефона.',
    ].join('\n'),
    tools: ['render_video_pitch', 'fs_export', 'browser_navigate_and_extract'],
  },
}

export const DEFAULT_ROLE = 'general'

// ─── Модели ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Короткие имена моделей.
 *
 * Полный идентификатор тоже принимается: список алиасов устаревает быстрее, чем каталог OpenRouter, и
 * запрещать `openai/o3-mini` только потому, что для него не завели алиас, — значит чинить это каждую
 * неделю. Проверка наличия модели не делается заранее: она стоит запроса к каталогу на каждый старт,
 * а ошибка всё равно придёт от сервера с внятным текстом.
 */
export const MODEL_ALIASES: Record<string, string> = {
  claude: DEFAULT_AGENT_MODEL,
  sonnet: DEFAULT_AGENT_MODEL,
  gpt4o: 'openai/gpt-4o',
  gpt4omini: 'openai/gpt-4o-mini',
  deepseek: 'deepseek/deepseek-chat',
  qwen: 'qwen/qwen-2.5-72b-instruct',
  local: 'local',
}

/** Локальная модель через Ollama. Живёт не в OpenRouter, поэтому у неё отдельный адрес. */
export const LOCAL_MODEL_BASE = 'http://127.0.0.1:11434/v1'

export function resolveModel(alias: string): { id: string; local: boolean } {
  const key = alias.trim().toLowerCase().replace(/[\s._-]/g, '')
  const mapped = MODEL_ALIASES[key]
  if (mapped === 'local') return { id: process.env.NEMO_LOCAL_MODEL ?? 'qwen2.5:7b', local: true }
  if (mapped) return { id: mapped, local: false }
  return { id: alias.trim(), local: false }
}

// ─── Разбор ───────────────────────────────────────────────────────────────────────────────────────

export interface SlashCommand {
  readonly name: string
  readonly args: string[]
  /** Всё после имени команды одной строкой — для команд вроде /browse, где аргумент это URL с пробелами. */
  readonly rest: string
}

/**
 * Разбор строки ввода.
 *
 * Возвращает null для всего, что командой не является: обычная фраза, пустая строка, а также «/» с
 * пробелом после — «/ 5 клиник» это опечатка в запросе, а не команда с именем «».
 */
export function parseSlash(input: string): SlashCommand | null {
  const raw = String(input ?? '').trim()
  if (!raw.startsWith('/') || raw.length < 2) return null
  const body = raw.slice(1)
  if (/^\s/.test(body)) return null
  const match = /^(\S+)\s*([\s\S]*)$/.exec(body)
  if (!match) return null
  return { name: match[1].toLowerCase(), args: match[2] ? match[2].split(/\s+/) : [], rest: match[2].trim() }
}

export interface CommandSpec {
  readonly name: string
  readonly usage: string
  readonly summary: string
}

export const COMMANDS: CommandSpec[] = [
  { name: 'help', usage: '/help', summary: 'список команд' },
  { name: 'agent', usage: '/agent [general|sdr|dev|qa|media]', summary: 'сменить роль и круг инструментов' },
  { name: 'model', usage: '/model [claude|gpt4o|deepseek|qwen|local|<id>]', summary: 'сменить модель' },
  { name: 'tools', usage: '/tools', summary: 'инструменты и их права' },
  { name: 'mcp', usage: '/mcp', summary: 'состояние MCP-серверов' },
  { name: 'browse', usage: '/browse <url>', summary: 'открыть страницу и достать текст' },
  { name: 'scrape', usage: '/scrape <url>', summary: 'то же, но результатом — JSON с контактами' },
  { name: 'compact', usage: '/compact', summary: 'сжать историю пересказом' },
  { name: 'undo', usage: '/undo', summary: 'отменить последний ход' },
  { name: 'export', usage: '/export [json|md]', summary: 'сохранить историю сессии' },
  { name: 'health', usage: '/health', summary: 'состояние зависимостей' },
  { name: 'balance', usage: '/balance', summary: 'остаток кредитов OpenRouter' },
  { name: 'clear', usage: '/clear', summary: 'забыть разговор, роль сохранить' },
  { name: 'exit', usage: '/exit', summary: 'выход' },
]

const ALIASES: Record<string, string> = { quit: 'exit', q: 'exit', h: 'help', '?': 'help' }

export function canonicalName(name: string): string {
  return ALIASES[name] ?? name
}

/**
 * Подсказки для Tab.
 *
 * Пустая строка даёт ВСЕ команды: человек, нажавший Tab на пустой строке, спрашивает «что тут есть»,
 * и молчание в ответ — худший из возможных ответов.
 */
export function completeSlash(line: string): { matches: string[]; replaced: string } {
  const raw = String(line ?? '')
  if (!raw.startsWith('/')) return { matches: [], replaced: raw }
  const typed = raw.slice(1).split(/\s+/)[0].toLowerCase()
  const all = COMMANDS.map((one) => `/${one.name}`)
  if (!typed) return { matches: all, replaced: raw }
  return { matches: all.filter((one) => one.slice(1).startsWith(typed)), replaced: raw }
}

// ─── Исполнение ───────────────────────────────────────────────────────────────────────────────────

export type CommandResult =
  | { kind: 'lines'; lines: string[] }
  | { kind: 'exit' }
  /** Команда превратилась в обычный запрос к модели — /browse и /scrape работают так. */
  | { kind: 'prompt'; text: string }
  | { kind: 'unknown'; name: string; suggestions: string[] }

export interface CommandDeps {
  readonly session: AgentSession
  readonly registry: ToolRegistry
  /** Сменить роль: вызывающая сторона перестраивает промпт и фильтр инструментов. */
  readonly setRole: (role: AgentRole) => void
  readonly currentRole: () => AgentRole
  /** Сменить модель. Возвращает отказ строкой, если новая модель не принята. */
  readonly setModel: (resolved: { id: string; local: boolean }) => string | null
  readonly currentModel: () => string
  readonly mcpStatus: () => Array<{ server: string; state: string; tools: string[] }>
  readonly health: () => Promise<Array<{ name: string; ok: boolean; detail: string }>>
  readonly balance: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  readonly summarize: (messages: readonly ChatMessage[]) => Promise<string>
  readonly writeExport: (name: string, body: string) => Promise<string>
}

/** Похожие имена для опечаток. Без них «нет такой команды» заставляет искать /help вручную. */
function suggest(name: string): string[] {
  return COMMANDS.map((one) => one.name)
    .filter((one) => one.startsWith(name.slice(0, 2)) || name.startsWith(one.slice(0, 2)))
    .slice(0, 3)
}

export async function runSlash(command: SlashCommand, deps: CommandDeps): Promise<CommandResult> {
  const name = canonicalName(command.name)

  if (name === 'exit') return { kind: 'exit' }

  if (name === 'help') {
    return {
      kind: 'lines',
      lines: COMMANDS.map((one) => `  ${one.usage.padEnd(44)} ${one.summary}`),
    }
  }

  if (name === 'agent') {
    const wanted = command.args[0]?.toLowerCase()
    if (!wanted) {
      return {
        kind: 'lines',
        lines: [
          `  сейчас: ${deps.currentRole().name} (${deps.currentRole().title})`,
          ...Object.values(AGENT_ROLES).map((role) => {
            const scope = role.tools ? `${role.tools.length} инструментов` : 'все инструменты'
            return `  ${role.name.padEnd(10)} ${role.title.padEnd(20)} ${scope}`
          }),
        ],
      }
    }
    const role = AGENT_ROLES[wanted]
    if (!role) {
      return { kind: 'lines', lines: [`  нет роли «${wanted}». Есть: ${Object.keys(AGENT_ROLES).join(', ')}`] }
    }
    deps.setRole(role)
    // Роль называется ВМЕСТЕ с кругом инструментов: смена роли молча отбирает у агента часть
    // возможностей, и человек должен узнать об этом сразу, а не когда модель откажется отправить лид.
    const available = deps.registry.names()
    return {
      kind: 'lines',
      lines: [
        `  роль: ${role.name} (${role.title})`,
        `  инструменты: ${available.length ? available.join(', ') : 'нет ни одного'}`,
      ],
    }
  }

  if (name === 'model') {
    const wanted = command.rest
    if (!wanted) {
      return {
        kind: 'lines',
        lines: [
          `  сейчас: ${deps.currentModel()}`,
          `  короткие имена: ${Object.keys(MODEL_ALIASES).join(', ')}`,
          '  можно и полный идентификатор OpenRouter, например openai/o3-mini',
        ],
      }
    }
    const resolved = resolveModel(wanted)
    const refusal = deps.setModel(resolved)
    if (refusal) return { kind: 'lines', lines: [`  ${refusal}`] }
    return {
      kind: 'lines',
      lines: [`  модель: ${resolved.id}${resolved.local ? ` (локально, ${LOCAL_MODEL_BASE})` : ''}`],
    }
  }

  if (name === 'tools') {
    const names = deps.registry.names()
    if (!names.length) return { kind: 'lines', lines: ['  ни одного инструмента не подключено'] }
    return {
      kind: 'lines',
      lines: names.flatMap((toolName) => {
        const tool = deps.registry.get(toolName)
        const mark = tool?.permission === 'action' ? 'действие' : 'чтение  '
        return [`  ${mark} ${toolName}`, `           ${(tool?.description ?? '').split('\n')[0].slice(0, 96)}`]
      }),
    }
  }

  if (name === 'mcp') {
    const status = deps.mcpStatus()
    if (!status.length) {
      return {
        kind: 'lines',
        lines: [
          '  MCP-серверы не настроены.',
          '  Задайте NEMO_MCP_SERVERS: [{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}]',
        ],
      }
    }
    return {
      kind: 'lines',
      lines: status.flatMap((one) => [
        `  ${one.server}: ${one.state}`,
        one.tools.length ? `    методы: ${one.tools.join(', ')}` : '    методов нет',
      ]),
    }
  }

  if (name === 'browse' || name === 'scrape') {
    const url = command.rest
    if (!url) return { kind: 'lines', lines: [`  нужен адрес: /${name} https://example.com`] }
    if (!/^https?:\/\//i.test(url)) {
      // Без схемы Playwright откроет `file://` или упадёт: подставлять https молча — значит однажды
      // отправить агента не туда, куда просили.
      return { kind: 'lines', lines: [`  адрес должен начинаться с http:// или https://, получено: ${url}`] }
    }
    return {
      kind: 'prompt',
      text: name === 'browse'
        ? `Открой ${url} и перескажи, что там: чем занимается организация, есть ли контакты и виджеты записи.`
        : `Открой ${url} и верни ТОЛЬКО JSON с полями name, phones, emails, socials, booking_widgets. Ничего не выдумывай: чего нет на странице — пустой список.`,
    }
  }

  if (name === 'compact') {
    const before = deps.session.turnCount
    const result = await deps.session.compact(deps.summarize)
    if (result.summarized === 0) return { kind: 'lines', lines: ['  сжимать нечего: разговор ещё короткий'] }
    return {
      kind: 'lines',
      lines: [`  сжато: ${result.before} сообщений → ${result.after} (пересказано ${result.summarized}), ходов было ${before}`],
    }
  }

  if (name === 'undo') {
    return {
      kind: 'lines',
      lines: [deps.session.undoLastTurn() ? '  последний ход отменён' : '  отменять нечего'],
    }
  }

  if (name === 'clear') {
    deps.session.reset()
    return { kind: 'lines', lines: ['  разговор забыт, роль сохранена'] }
  }

  if (name === 'export') {
    const format = (command.args[0] ?? 'md').toLowerCase()
    if (!['json', 'md', 'markdown'].includes(format)) {
      return { kind: 'lines', lines: [`  формат json или md, получено: ${format}`] }
    }
    const isJson = format === 'json'
    const body = isJson
      ? JSON.stringify(deps.session.messages, null, 2)
      : renderTranscript(deps.session.messages)
    const path = await deps.writeExport(isJson ? 'session.json' : 'session.md', body)
    return { kind: 'lines', lines: [`  сохранено: ${path}`] }
  }

  if (name === 'health') {
    const checks = await deps.health()
    return {
      kind: 'lines',
      lines: checks.map((one) => `  ${one.ok ? '✓' : '×'} ${one.name.padEnd(14)} ${one.detail}`),
    }
  }

  if (name === 'balance') {
    const result = await deps.balance()
    return { kind: 'lines', lines: [`  ${result.ok ? result.text : `не удалось узнать: ${result.error}`}`] }
  }

  return { kind: 'unknown', name: command.name, suggestions: suggest(command.name) }
}

/**
 * История разговора в Markdown.
 *
 * Вызовы инструментов показываются ИМЕНАМИ, а не полными аргументами: выгрузка сессии легко уходит в
 * чат или в тикет, а в аргументах лежат телефоны найденных людей.
 */
export function renderTranscript(messages: readonly ChatMessage[]): string {
  const lines = ['# Сессия Nemo', '']
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') lines.push(`## Человек`, '', String(message.content ?? ''), '')
    else if (message.role === 'tool') lines.push(`- инструмент \`${(message as { name?: string }).name ?? '?'}\` отработал`, '')
    else if (message.tool_calls?.length) {
      if (message.content) lines.push(`## Nemo`, '', String(message.content), '')
      lines.push(`- вызвал: ${message.tool_calls.map((one) => `\`${one.function.name}\``).join(', ')}`, '')
    } else lines.push(`## Nemo`, '', String(message.content ?? ''), '')
  }
  return lines.join('\n')
}

/** Просьба к модели пересказать старую часть разговора. */
export const COMPACT_INSTRUCTION = [
  'Ниже — начало разговора. Перескажи его так, чтобы можно было продолжать работу без этого текста.',
  'Сохрани: что человек просил, какие инструменты звались и с каким итогом, конкретные найденные данные',
  '(названия, телефоны, адреса, числа), о чём договорились. Выброси вежливость и рассуждения.',
  'Не выдумывай ничего, чего нет в тексте. До 300 слов, обычным текстом.',
].join('\n')

