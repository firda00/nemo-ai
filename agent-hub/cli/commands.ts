// Слеш-команды CLI: разбор, автодополнение, исполнение.
//
// ОТДЕЛЬНО ОТ ТОЧКИ ВХОДА, потому что здесь живут решения, которые ломают сессию тихо: срез истории,
// смена роли, смена модели. Их проверяют вызовом функции, а не запуском терминала.
//
// ПРАВИЛО ФАЙЛА: команда либо делает ровно то, что обещает её имя, либо отказывается вслух. Молчаливый
// отказ хуже ошибки — человек продолжает работать, считая, что модель сменилась или контекст сжат.

import type { AgentSession, ChatMessage } from '../agent-runtime.ts'
import { DEFAULT_AGENT_MODEL } from '../agent-runtime.ts'
import type { ToolOutcome, ToolRegistry } from '../tools/registry.ts'

// Роли живут в roles.ts: они нужны и точке входа, и диспетчеру, и тестам, а этот файл — про разбор
// и исполнение команд. Реэкспорт оставлен, чтобы не менять места вызова.
export { AGENT_ROLES, DEFAULT_ROLE, type AgentRole } from './roles.ts'
import { AGENT_ROLES } from './roles.ts'
import { catalogLines, loadSkills, skillPromptBlock } from './skills.ts'


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
  { name: 'qa', usage: '/qa <url|code>', summary: 'аудит сайта или прогон гейта качества' },
  { name: 'skill', usage: '/skill [id|off]', summary: 'подключить маркетинговую методику' },
  { name: 'health', usage: '/health', summary: 'состояние зависимостей' },
  { name: 'balance', usage: '/balance', summary: 'тариф и остаток облачных лимитов Nemo' },
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
  | { kind: 'unknown'; name: string; suggestions: string[] }

export interface CommandDeps {
  readonly session: AgentSession
  readonly registry: ToolRegistry
  /** Сменить роль: вызывающая сторона перестраивает промпт и фильтр инструментов. */
  readonly setRole: (role: AgentRole) => void
  readonly currentRole: () => AgentRole
  /** Активные маркетинговые методики. Живут рядом с ролью: и то и другое — настройка сеанса. */
  readonly activeSkills?: () => string[]
  readonly setSkills?: (ids: string[]) => void
  /** Сменить модель. Возвращает отказ строкой, если новая модель не принята. */
  readonly setModel: (resolved: { id: string; local: boolean }) => string | null
  readonly currentModel: () => string
  readonly mcpStatus: () => Array<{ server: string; state: string; tools: string[] }>
  readonly health: () => Promise<Array<{ name: string; ok: boolean; detail: string }>>
  readonly balance: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** Прямой вызов инструмента через реестр: /browse и /qa зовут его, минуя модель. */
  readonly runTool?: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>
  /** Аудит сайта или репозитория. Возвращает готовые строки для терминала. */
  readonly runQa?: (target: { kind: 'site'; url: string } | { kind: 'code' }) => Promise<{ lines: string[] }>
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

    /*
     * ПРЯМОЙ ВЫЗОВ, А НЕ ПРОСЬБА К МОДЕЛИ.
     *
     * Раньше `/browse` превращался в фразу «открой такой-то адрес», и дальше всё зависело от того,
     * решит ли модель звать инструмент. Она регулярно решала иначе — отвечала по памяти или уточняла
     * задачу, — и команда, названная прямой, вела себя как намёк. Здесь страница открывается сразу.
     *
     * Результат кладётся В ИСТОРИЮ: следующий вопрос про эту страницу модель встречает с данными, а
     * не с пустыми руками.
     */
    if (!deps.runTool || !deps.registry.has('browser_navigate_and_extract')) {
      return {
        kind: 'lines',
        lines: [
          '  браузер недоступен: не установлен Playwright или задано SDR_BROWSER=0',
          '  установка: npm i playwright && npx playwright install chromium',
        ],
      }
    }

    const outcome = await deps.runTool('browser_navigate_and_extract', { url })
    deps.session.recordToolCall(
      'browser_navigate_and_extract',
      { url },
      outcome.ok ? JSON.stringify({ ok: true, result: outcome.result }) : JSON.stringify({ ok: false, error: outcome.error }),
    )
    if (!outcome.ok) return { kind: 'lines', lines: [`  × ${outcome.error}`] }

    const page = outcome.result as PageResult
    if (name === 'scrape') {
      return {
        kind: 'lines',
        lines: JSON.stringify(scrapeShape(url, page), null, 2).split('\n').map((one) => `  ${one}`),
      }
    }
    return { kind: 'lines', lines: describePage(url, page) }
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

  if (name === 'qa') {
    const target = command.rest
    if (!target) {
      return {
        kind: 'lines',
        lines: ['  /qa https://example.com — аудит сайта', '  /qa code — прогон гейта качества репозитория'],
      }
    }
    // Цель разбирается ДО проверки доступности: опечатка в цели встречается несравнимо чаще, чем
    // сборка без аудита, и прятать её за «недоступно» значит отправить человека чинить не то.
    const code = ['code', 'local', 'repo', '.'].includes(target.toLowerCase())
    if (!code && !/^https?:\/\//i.test(target)) {
      return {
        kind: 'lines',
        lines: [`  цель — адрес сайта (http:// или https://) либо слово code, получено: ${target}`],
      }
    }
    if (!deps.runQa) return { kind: 'lines', lines: ['  аудит недоступен в этой сборке'] }

    const result = await deps.runQa(code ? { kind: 'code' } : { kind: 'site', url: target })
    return { kind: 'lines', lines: result.lines }
  }

  /*
   * /skill — ПОДКЛЮЧЕНИЕ МЕТОДИКИ В СИСТЕМНЫЙ ПРОМПТ, А НЕ СПРАВКА.
   *
   * Навык — это инструкции о том, КАК работать, поэтому он идёт в системный промпт, а не репликой
   * в разговор: реплика уедет из контекста при первом же /compact, и агент тихо вернётся к общим
   * местам. Промпт переживает и сжатие, и /clear.
   *
   * ПО ОДНОМУ, А НЕ ВСЕ СРАЗУ. Навыков сорок девять, каждый — несколько килобайт. Загрузив всё, мы
   * забьём контекст методиками и не оставим места под саму задачу.
   */
  if (name === 'skill') {
    const skills = loadSkills()
    if (!skills.length) {
      return {
        kind: 'lines',
        lines: [
          '  каталог навыков не найден: vendor/marketingskills отсутствует',
          '  забрать: node scripts/vendor-marketing-skills.mjs',
        ],
      }
    }

    const active = deps.activeSkills?.() ?? []
    const arg = command.rest.trim().toLowerCase()

    if (!arg) {
      return {
        kind: 'lines',
        lines: [
          `  ${skills.length} методик, источник: github.com/coreyhaines31/marketingskills (MIT)`,
          active.length ? `  подключены: ${active.join(', ')}` : '  сейчас не подключено ничего',
          '',
          ...catalogLines(skills),
          '',
          '  подключить: /skill <id>   ·   отключить все: /skill off',
        ],
      }
    }

    if (arg === 'off') {
      deps.setSkills?.([])
      return { kind: 'lines', lines: ['  методики отключены'] }
    }

    const found = skills.find((one) => one.id === arg)
    if (!found) {
      // Близкие по написанию подсказываются: идентификаторы длинные, и промах в одну букву — обычное дело.
      /*
       * Близкие ищутся ПО НАЧАЛУ СЛОВА, а не по вхождению подстроки.
       *
       * Вхождение не ловит самую частую опечатку — пропущенную букву в середине: «copywritng» не
       * содержит «copywriting» и не содержится в нём, и подсказка молчала ровно там, где нужна
       * больше всего. Общее начало в четыре знака покрывает и пропуск, и лишнюю букву, и
       * перестановку.
       */
      const head = arg.slice(0, 4)
      const near = skills
        .map((one) => one.id)
        .filter((id) => id.startsWith(head) || arg.startsWith(id.slice(0, 4)))
        .slice(0, 4)
      return {
        kind: 'lines',
        lines: [
          `  нет методики «${arg}»`,
          near.length ? `  похоже на: ${near.join(', ')}` : '  список: /skill',
        ],
      }
    }

    if (active.includes(found.id)) {
      return { kind: 'lines', lines: [`  «${found.id}» уже подключена`] }
    }

    const next = [...active, found.id]
    deps.setSkills?.(next)
    return {
      kind: 'lines',
      lines: [
        `  подключена методика «${found.id}» (${skillPromptBlock(skills, [found.id]).length} знаков в промпте)`,
        `  всего подключено: ${next.length}`,
      ],
    }
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

/** Что возвращает browser_navigate_and_extract. Описано здесь, чтобы не тянуть модуль браузера. */
export interface PageResult {
  finalUrl?: string
  title?: string
  text?: string
  status?: number | null
  blocked?: boolean
  messengers?: Array<{ kind: string; url: string }>
  bookingWidgets?: string[]
  emails?: string[]
  phones?: string[]
}

/**
 * Страница человеческим языком.
 *
 * Текст показывается ОБРЕЗАННЫМ: страница на двести килобайт, вывалившаяся в терминал, стирает
 * прокруткой весь предыдущий разговор. Модели в историю уходит полный результат — ей он нужен целиком.
 */
export function describePage(url: string, page: PageResult): string[] {
  const text = (page.text ?? '').replace(/\s+/g, ' ').trim()
  const lines = [
    `  ${page.title || '(без заголовка)'}`,
    `  ${page.finalUrl && page.finalUrl !== url ? `→ ${page.finalUrl}` : url}${page.status ? `  [${page.status}]` : ''}`,
  ]
  // Защита от бота — не «пустая страница»: разница определяет, что делать дальше, и молчать о ней
  // значит отправить человека искать несуществующую ошибку в своём коде.
  if (page.blocked) lines.push('  ⚠ страница отдала защиту от ботов, текст неполный')
  lines.push('', `  ${text.slice(0, 600)}${text.length > 600 ? '…' : ''}`, '')
  if (page.messengers?.length) {
    lines.push(`  мессенджеры: ${page.messengers.map((one) => `${one.kind} → ${one.url}`).join(', ')}`)
  }
  if (page.bookingWidgets?.length) lines.push(`  виджеты записи: ${page.bookingWidgets.join(', ')}`)
  if (page.emails?.length) lines.push(`  почта: ${page.emails.join(', ')}`)
  if (page.phones?.length) lines.push(`  телефоны: ${page.phones.join(', ')}`)
  if (!page.messengers?.length && !page.bookingWidgets?.length) lines.push('  мессенджеров и виджетов записи не найдено')
  lines.push('', `  ${text.length} знаков текста — результат добавлен в контекст разговора`)
  return lines
}

/**
 * Телефоны из текста страницы.
 *
 * Браузерный инструмент их НЕ собирает — он отдаёт текст, мессенджеры и виджеты записи. Вернуть
 * `phones: []` на этом основании значило бы сказать «телефонов на странице нет», хотя их просто никто
 * не искал. Это ровно та тишина о непроверенном, которая делает отчёт хуже его отсутствия.
 */
export function extractPhones(text: string): string[] {
  const found = String(text ?? '').match(/\+?\d[\d\s().-]{7,18}\d/g) ?? []
  const normalized = found
    .map((one) => one.replace(/[\s().-]/g, ''))
    .filter((one) => {
      const digits = one.replace(/\D/g, '')
      // Пятнадцать цифр — предел E.164, длиннее номеров не бывает. Граница не придирка: без неё
      // двадцатидвузначный артикул товара попадал в список телефонов, и человек звонил бы по номеру,
      // которого не существует. Ровно это и случилось на первом прогоне извлекателя.
      if (one.startsWith('+')) return digits.length >= 10 && digits.length <= 15
      // Без кода страны осмысленны только национальные номера. Пятнадцатизначное число без плюса —
      // почти наверняка не телефон, а идентификатор.
      return digits.length >= 9 && digits.length <= 12
    })
  return [...new Set(normalized)].slice(0, 20)
}

/** Почта из текста страницы. Та же причина, что и у телефонов. */
export function extractEmailsFromText(text: string): string[] {
  const found = String(text ?? '').match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g) ?? []
  return [...new Set(found.map((one) => one.toLowerCase().replace(/[.,;]+$/, '')))].slice(0, 20)
}

/**
 * Структурированная выжимка для /scrape.
 *
 * Всё, чего нет, становится ПУСТЫМ СПИСКОМ, а не пропущенным полем: пропущенное поле модель заполняет
 * по своему разумению, то есть выдумывает.
 */
export function scrapeShape(url: string, page: PageResult): Record<string, unknown> {
  const text = page.text ?? ''
  return {
    url: page.finalUrl ?? url,
    title: page.title ?? null,
    status: page.status ?? null,
    blocked: Boolean(page.blocked),
    phones: page.phones ?? extractPhones(text),
    emails: page.emails ?? extractEmailsFromText(text),
    messengers: page.messengers ?? [],
    booking_widgets: page.bookingWidgets ?? [],
    text_length: text.length,
  }
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

