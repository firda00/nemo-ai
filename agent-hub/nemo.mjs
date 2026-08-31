// npm run nemo — универсальный агентный интерфейс.
//
// Здесь только подключения и ввод: цикл живёт в agent-runtime.ts, отрисовка — в nemo-ui.mjs,
// инструменты — в tools/platform.ts, команды — в cli/commands.ts. Разделение не ради красоты: всё
// перечисленное проверяется вызовом функций без сети и без ключа, а этот файл иначе как запуском не
// проверить. Поэтому здесь не должно быть решений — только соединения.
//
// СТАРЫЙ ВИЗАРД ОСТАЁТСЯ. `npm run sdr:run -- --query ... --city ...` работает как раньше: он живёт в
// cron и в скриптах, и менять его поведение ради нового интерфейса значило бы сломать то, что уже
// работает у людей. Агент — отдельная точка входа.

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { loadLocalEnv } from './load-local-env.mjs'
import { Ask, Spinner, c, isInteractiveTerminal, stopActiveSpinner } from './tui.mjs'
import {
  AgentSession, buildAgentSystemPrompt, createOpenRouterStream, DEFAULT_AGENT_MODEL, MAX_STEPS,
  setSessionRegistry,
} from './agent-runtime.ts'
import { buildPlatformRegistry } from './tools/platform.ts'
import { buildDialer } from './modules/dialer/from-env.ts'
import { restrictRegistry } from './tools/registry.ts'
import { createRenderer, confirmationPrompt } from './nemo-ui.mjs'
import {
  AGENT_ROLES, COMPACT_INSTRUCTION, DEFAULT_ROLE, LOCAL_MODEL_BASE, completeSlash, parseSlash, runSlash,
} from './cli/commands.ts'
import { missionFor } from './cli/roles.ts'
import { collectHealth, toolBadges } from './cli/wiring.ts'
import { createNemoCloudStream, fetchNemoBalance } from './cli/cloud.ts'
import {
  INPUT_PROMPT, divider, estimateHistoryTokens, hudLine, plural, reasoningLine, shortModel,
  statusBar, treeBlock, userBar,
} from './cli/hud.ts'
import { theme } from './cli/theme.ts'
import { header, shortenPath } from './cli/banner.ts'
import { ensureSession, logout, readSession, writeSession } from './cli/login.ts'
import { loginWithBrowser } from './cli/browser-login.ts'
import { loadSkills, skillPromptBlock } from './cli/skills.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
const localEnv = loadLocalEnv(repoRoot)
const debug = process.argv.includes('--debug')

/*
 * Версия берётся из package.json, а не из строки в коде.
 *
 * Зашитая «v1.0.0» разошлась бы с настоящей при первом же выпуске, и человек в переписке
 * называл бы версию, которой у него нет. Пусто — значит пусто: выдумывать номер нельзя.
 */
const CLI_VERSION = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')).version || '0.0.0'

// ── Вход в аккаунт ───────────────────────────────────────────────────────────────────────────────
//
// До всего остального: остальные шаги имеют смысл только для того, кто вошёл. Сессия лежит в
// ~/.nemo/auth.json, и при живом токене вопросов не задаётся вовсе.
if (process.argv.includes('logout')) {
  logout()
  console.log('Сессия удалена.')
  process.exit(0)
}

const browserLogin = async () => {
  const result = await loginWithBrowser({ say: (line) => console.log(`  ${line}`) })
  if (result.ok) {
    const welcomeName = result.session.name?.trim() || result.session.email.split('@')[0] || 'пользователь'
    console.log(`  ✅ Авторизация успешна! Добро пожаловать, ${welcomeName}.`)
  }
  return result
}

// Явный вход не запускает интерактивного агента и потому работает даже из конвейера/скрипта.
if (process.argv.includes('login')) {
  const result = await browserLogin()
  if (!result.ok) {
    console.error(`  Не вошли: ${result.error}`)
    process.exit(1)
  }
  writeSession(result.session)
  process.exit(0)
}

if (!isInteractiveTerminal()) {
  // Агент — диалоговый режим. В конвейере он повис бы на первом же вопросе, и выглядело бы это как
  // зависший процесс. Для скриптов есть режим флагов у sdr:run.
  console.error('Агенту нужен терминал. Для скриптов: npm run sdr:run -- --query "..." --city "..."')
  process.exit(1)
}

const account = process.env.NEMO_SKIP_LOGIN
  ? null
  : await ensureSession({
    read: () => readSession(),
    write: (value) => writeSession(value),
    clear: () => logout(),
    browserLogin,
    say: (line) => console.log(`  ${line}`),
  })

if (!account && !process.env.NEMO_SKIP_LOGIN) {
  console.error('Без входа продолжать нечем. Регистрация — в веб-панели Nemo AI.')
  process.exit(1)
}

// ── Инструменты: подключаем то, что действительно настроено ──────────────────────────────────────

const [{ runSdrPipeline }, { resolvePlacesSearch }, { WebEnricher }, { resolveScorer }] =
  await Promise.all([
    import('../supabase/functions/_shared/leadgen/pipeline.ts'),
    import('../supabase/functions/_shared/leadgen/placesSearch.ts'),
    import('../supabase/functions/_shared/leadgen/enricher.ts'),
    import('../supabase/functions/_shared/leadgen/scorer.ts'),
  ])
const { createBrowserBridge } = await import('./tools/enrich-browser.ts')
const { syncHotLeadsToCrm } = await import('./crm-sync.ts')
const { resolveLeadCardConfig } = await import('./telegram/lead-card-bridge.ts')
const { connectMcpServers, resolveMcpServers } = await import('./tools/mcp-client.ts')

const browser = createBrowserBridge()
const cards = resolveLeadCardConfig()
const { PlaywrightQaProbe } = await import('./tools/qa-probe.ts')
const qaProbe = browser.engine ? new PlaywrightQaProbe() : null

/*
 * Автодозвон собирается ДО реестра и в try — потому что настройки могут быть негодными.
 *
 * Негодная настройка не должна ронять весь терминал: человек пришёл писать код или искать клиентов,
 * а не звонить, и остаться совсем без агента из-за опечатки в NEMO_DIALER_HOURS — плохой обмен.
 * Но и промолчать нельзя: он вправе думать, что обзвон настроен. Поэтому ошибка называется вслух, а
 * автодозвона в этот запуск нет — то есть инструмент не регистрируется и модель его не видит.
 */
let dialer = null
let dialerProblem = null
try {
  dialer = buildDialer(process.env)
} catch (error) {
  // Печатать ЗДЕСЬ нельзя: ниже идёт console.clear(), и предупреждение стёрлось бы, не успев
  // попасться на глаза. Сообщение откладывается и уходит в шапку, где у него своя рамка слева.
  dialerProblem = error instanceof Error ? error.message : String(error)
}

const { registry: fullRegistry, skipped } = buildPlatformRegistry({
  runPipeline: async ({ query, city, limit, icp }) => {
    const result = await runSdrPipeline({ query, city, limit, icp }, {
      search: resolvePlacesSearch(),
      enrich: new WebEnricher(process.env, fetch, browser.fallback),
      score: resolveScorer(),
      store: null,
      notify: null,
      log: () => {},
    })
    // Модели уходит СВОДКА, а не полный результат: сотня килобайт разметки сайтов не помогает решать,
    // что делать дальше, зато съедает контекст и стоит денег.
    return {
      found: result.found, hot: result.hot, qualified: result.qualified,
      leads: result.leads.map((lead) => ({
        name: lead.name, city: lead.city, phone: lead.phone, website: lead.website,
        score: lead.score?.score ?? null, status: lead.score?.status ?? null,
        reason: lead.score?.reason ?? null, pitch: lead.score?.icebreaker_pitch ?? null,
        whatsapp: lead.enrichment?.socials?.whatsapp ?? null,
        telegram: lead.enrichment?.socials?.telegram ?? null,
      })),
    }
  },
  // Движок берётся НАПРЯМУЮ, а не через `browser.fallback ? … : undefined`. В прежнем виде поля
  // engine в мосте не существовало вовсе, и браузерные инструменты не регистрировались никогда —
  // модель отвечала «у меня нет такого инструмента» на прямую просьбу открыть сайт.
  browserEngine: browser.engine ?? undefined,
  // Зонд аудита строится лениво: конструктор Chromium не запускает, поэтому платить за него при
  // старте не приходится, а инструмент модели виден сразу.
  qaProbe: browser.engine ? qaProbe : undefined,
  qaScreenshotDir: path.join(process.cwd(), 'qa-reports'),
  qaWriteFile: async (at, data) => { await fs.mkdir(path.dirname(at), { recursive: true }); await fs.writeFile(at, data) },
  sendCard: cards.enabled
    ? async (lead) => {
      const [{ TelegramNotificationService }, { leadToCardNotification, FOUND_LEAD_STYLE }] = await Promise.all([
        import('./telegram/bot-service.ts'), import('./telegram/lead-card-bridge.ts'),
      ])
      const card = leadToCardNotification({
        name: lead.leadName, phone: lead.phone ?? null, website: lead.website ?? null, city: lead.city ?? null,
        dedupe_key: `${lead.leadName}|${lead.city ?? ''}`,
        score: { score: lead.score, status: 'HOT', reason: lead.reason ?? null, icebreaker_pitch: lead.pitch ?? null },
        enrichment: { emails: [], booking_widgets: [], socials: {} },
      })
      if (!card) return { ok: false, error: 'лид не проходит порог горячего или у него нет контактов' }
      const service = new TelegramNotificationService(cards.token)
      const sent = await service.sendLeadCardToManager(cards.chatId, card, FOUND_LEAD_STYLE)
      return { ok: sent.ok, error: sent.ok ? undefined : sent.error }
    }
    : undefined,
  syncLead: process.env.CRM_WEBHOOK_URL
    ? async (lead) => {
      const outcome = await syncHotLeadsToCrm([{
        name: lead.leadName, phone: lead.phone ?? null, website: lead.website ?? null, city: lead.city ?? null,
        dedupe_key: `${lead.leadName}|${lead.city ?? ''}`,
        score: { score: lead.score ?? 0, status: 'HOT', reason: lead.note ?? null },
        enrichment: { emails: [], socials: {} },
      }], { idByKey: new Map() })
      return { ok: outcome.sent > 0, error: outcome.errors[0] }
    }
    : undefined,
  /*
   * Разбор звонка спрашивает модель ОТДЕЛЬНЫМ вызовом, а не внутри общего диалога.
   *
   * Расшифровка часового разговора — это десятки тысяч знаков. Положить её в историю значило бы
   * вытеснить оттуда всё остальное и платить за неё в каждом следующем сообщении. Здесь она уходит
   * одним запросом, обратно приходит отчёт, а в историю попадает только он.
   */
  askModel: async (prompt, signal) => {
      // Сигнал приходит СВОЙ, от реестра: истёкший таймаут инструмента обязан оборвать и запрос к
      // модели, иначе он продолжает идти и тратить деньги за ответ, которого никто не ждёт.
      const own = signal ? null : new AbortController()
      let text = ''
      for await (const chunk of buildStream()([{ role: 'user', content: prompt }], [], signal ?? own.signal)) {
        if (chunk.kind === 'text') text += chunk.delta
      }
      return text
    },
  // Автодозвон — только когда задана соль для отпечатков. Без неё белый список пришлось бы хранить
  // открытыми номерами, а это перечень людей, которым собираются звонить.
  dialer: dialer ?? undefined,
  exportDirectory: process.cwd(),
})

// MCP-серверы подключаются ОТДЕЛЬНЫМИ инструментами на каждый метод, а не одним общим mcp_call:
// модель получает настоящую схему параметров вместо непрозрачного объекта и может звать метод сразу,
// не угадывая его сигнатуру.
const mcpConfig = resolveMcpServers(process.env)
if (mcpConfig.error) console.log(`  ${c.yellow('MCP:')} ${mcpConfig.error}`)
const mcp = await connectMcpServers(fullRegistry, mcpConfig.servers)

// ── Состояние сессии: роль и модель меняются командами ───────────────────────────────────────────

let role = AGENT_ROLES[DEFAULT_ROLE]
let model = process.env.NEMO_AGENT_MODEL ?? DEFAULT_AGENT_MODEL
let localModel = Boolean(process.env.NEMO_SKIP_LOGIN && !account)

/*
 * Израсходованные токены.
 *
 * null означает «модель не сообщала», и это НЕ то же самое, что ноль: в строке состояния такой случай
 * показывается оценкой с пометкой «~». Локальные модели usage почти никогда не присылают.
 */
let usedTokens = null

const buildStream = () => localModel
  ? createOpenRouterStream({
      apiKey: '', model, baseUrl: LOCAL_MODEL_BASE,
      onUsage: (usage) => { usedTokens = usage.totalTokens },
    })
  : createNemoCloudStream({
      accessToken: account?.access_token ?? '', model,
      onUsage: (usage) => { usedTokens = usage.totalTokens },
    })

/** Ширина окна. Терминал могут растянуть посреди сессии, поэтому спрашиваем каждый раз. */
const width = () => Math.max(48, Math.min(process.stdout.columns || 80, 120))

/** Строка состояния: заполненность контекста, роль, модель, готовность. */
const printHud = (busyMs = null) => console.log(hudLine({
  model: localModel ? `${model} (локально)` : model,
  role: role.name,
  usedTokens,
  estimatedTokens: estimateHistoryTokens(session.messages),
  busyMs,
}, width()))

const renderer = createRenderer()
// Tab по слеш-команде показывает варианты. Обычная фраза не трогается: подсказка команд посреди
// запроса сбивает с толку.
const ask = new Ask(undefined, undefined, {
  completer: (line) => {
    const { matches } = completeSlash(line)
    return [matches, line]
  },
})

const session = new AgentSession(
  buildAgentSystemPrompt({ toolNames: fullRegistry.names(), hasConfirm: true, mission: missionFor(role) }),
  {
    registry: fullRegistry,
    stream: buildStream(),
    /**
     * Подтверждение действия.
     *
     * Спиннер гасится до вопроса — иначе анимация пишет в ту же строку, где readline ждёт ввод, и
     * набранный текст расползается по экрану. Эта ошибка уже возвращалась дважды в CLI SDR.
     */
    confirm: async (name, args) => {
      stopActiveSpinner()
      console.log(confirmationPrompt(name, args))
      const answer = (await ask.line(c.magenta(INPUT_PROMPT))).trim().toLowerCase()
      // Умолчание — ОТКАЗ. Enter на вопросе про отправку сообщения живому человеку не должен означать
      // согласие: цена ошибки здесь несимметрична.
      return ['д', 'да', 'y', 'yes', 'ага'].includes(answer)
    },
    onEvent: (event) => renderer.onEvent(event),
  },
)

/**
 * Прогон гейта качества отдельным процессом.
 *
 * Отдельным, а не вызовом внутрь: гейт поднимает vite, дёргает Supabase и живёт минуты. Запущенный в
 * этом же процессе, он унаследовал бы его окружение и обработчики сигналов, а падение любого шага
 * уронило бы CLI вместе с историей разговора.
 */
async function runQualityGate() {
  const { spawn } = await import('node:child_process')
  const started = Date.now()
  return await new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'quality'], {
      cwd: repoRoot, shell: process.platform === 'win32',
    })
    let output = ''
    // stdout и stderr в ОДИН поток: гейт печатает имена шагов в первый, а причины падений во второй,
    // и разделённые они дают отчёт, где видно что упало, но не видно почему.
    child.stdout?.on('data', (chunk) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', (error) => resolve({ code: 1, output: `
`, durationMs: Date.now() - started }))
    child.on('close', (code) => resolve({ code: code ?? 1, output, durationMs: Date.now() - started }))
  })
}

/*
 * Подключённые маркетинговые методики.
 *
 * Живут ЗДЕСЬ, а не в сессии: это настройка сеанса, как роль и модель. В сессии они пережили бы
 * /clear (он сохраняет системный промпт), но не пережили бы смену роли — та перестраивает промпт
 * заново, и методика молча исчезла бы, а агент вернулся к общим местам, ничего об этом не сказав.
 */
let skillIds = []

/** Применить роль: новый промпт, суженный круг инструментов и сохранённые методики. */
function applyRole(next) {
  role = next
  const narrowed = restrictRegistry(fullRegistry, next.tools)
  setSessionRegistry(session, narrowed)
  const block = skillIds.length ? skillPromptBlock(loadSkills(), skillIds) : ''
  session.setSystemPrompt(buildAgentSystemPrompt({
    toolNames: narrowed.names(),
    hasConfirm: true,
    mission: block ? `${missionFor(next)}\n\n${block}` : missionFor(next),
  }))
  return narrowed
}
let activeRegistry = restrictRegistry(fullRegistry, role.tools)

const commandDeps = {
  session,
  get registry() { return activeRegistry },
  setRole: (next) => { activeRegistry = applyRole(next) },
  currentRole: () => role,
  activeSkills: () => skillIds,
  // Перестроение промпта идёт через applyRole: одна дорога для роли и методик, иначе они разъедутся
  // — методика подключилась бы, а круг инструментов остался от прошлой роли.
  setSkills: (ids) => { skillIds = ids; activeRegistry = applyRole(role) },
  setModel: (resolved) => {
    model = resolved.id
    localModel = resolved.local
    session.setStream(buildStream())
    return null
  },
  currentModel: () => `${model}${localModel ? ' (локально)' : ''}`,
  mcpStatus: () => [
    ...mcpConfig.servers.map((server) => ({
      server: server.name,
      state: mcp.failures.some((one) => one.server === server.name)
        ? `не подключился: ${mcp.failures.find((one) => one.server === server.name).error}`
        : 'подключён',
      tools: mcp.registered.filter((name) => name.startsWith(`mcp__${server.name}__`)),
    })),
  ],
  health: () => collectHealth(process.env),
  balance: () => account
    ? fetchNemoBalance({ accessToken: account.access_token })
    : Promise.resolve({ ok: false, error: 'облачный баланс недоступен без nemo login' }),
  /** Прямой вызов инструмента: /browse зовёт браузер, минуя модель. */
  runTool: async (toolName, args) => await activeRegistry.call(toolName, args, { allowedActions: [] }),
  runQa: async (target) => {
    const startedAt = new Date()
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
    const dir = path.join(process.cwd(), 'qa-reports')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `QA_REPORT_${stamp}.md`)

    if (target.kind === 'code') {
      const { runCodeQa, renderCodeReport } = await import('./tools/qa-runner.ts')
      const spinner = new Spinner().start('гейт качества: это несколько минут')
      const result = await runCodeQa(runQualityGate)
      spinner.silence()
      await fs.writeFile(file, renderCodeReport(result, startedAt.toISOString()), 'utf8')
      return {
        lines: [
          `  ${result.ok ? '✓ гейт зелёный' : '× гейт КРАСНЫЙ'} — шагов ${result.steps.length}, упало ${result.failed.length}, ${Math.round(result.durationMs / 1000)} с`,
          ...result.failed.slice(0, 8).map((one) => `  × ${one}`),
          `  отчёт: ${file}`,
        ],
      }
    }

    if (!qaProbe) {
      return { lines: ['  аудит сайта требует Playwright: npm i playwright && npx playwright install chromium'] }
    }
    const { runSiteAudit, renderSiteReport, summarizeAudit } = await import('./tools/qa-runner.ts')
    // Зонд ОБЩИЙ с инструментом модели: два зонда — два процесса Chromium по 150 МБ, притом что
    // одновременно они не работают.
    const probe = qaProbe
    const spinner = new Spinner().start(`аудит ${target.url}`)
    try {
      const audit = await runSiteAudit(probe, {
        url: target.url,
        screenshotPath: path.join(dir, `QA_SHOT_${stamp}.png`),
        writeFile: async (at, data) => { await fs.writeFile(at, data) },
      })
      spinner.silence()
      await fs.writeFile(file, renderSiteReport(audit, startedAt.toISOString()), 'utf8')
      // Итог аудита кладётся в контекст: следующий вопрос «а что именно чинить?» модель встретит с
      // находками, а не с пустыми руками.
      session.recordToolCall('run_qa_audit', { url: target.url }, JSON.stringify({
        ok: true,
        result: { url: audit.url, score: audit.score, status: audit.status, findings: audit.findings },
      }))
      return { lines: [...summarizeAudit(audit), `  отчёт: ${file}`] }
    } finally {
      spinner.silence()
      // Зонд НЕ закрывается: он общий с инструментом модели и живёт до конца сессии. Закрытие здесь
      // означало бы перезапуск Chromium на каждый следующий аудит.
    }
  },
  summarize: async (messages) => {
    // Пересказ делает ТА ЖЕ модель отдельным запросом без инструментов: сжатие не должно ничего
    // вызывать, иначе /compact начнёт искать лидов заново.
    const stream = buildStream()
    let text = ''
    const transcript = messages
      .map((one) => `${one.role}: ${String(one.content ?? '').slice(0, 2_000)}`)
      .join('\n')
    for await (const chunk of stream(
      [{ role: 'system', content: COMPACT_INSTRUCTION }, { role: 'user', content: transcript }],
      [],
      new AbortController().signal,
    )) {
      if (chunk.kind === 'text') text += chunk.delta
    }
    return text.trim() || 'Пересказ не получился — модель не ответила.'
  },
  writeExport: async (name, body) => {
    const target = path.join(process.cwd(), name)
    await fs.writeFile(target, body, 'utf8')
    return target
  },
}

// ── Экран ────────────────────────────────────────────────────────────────────────────────────────

/*
 * Предупреждения собираются В ШАПКУ, а не печатаются по ходу.
 *
 * Выведенное до console.clear() стирается, не успев попасться на глаза; выведенное после — тонет
 * под деревом готовности. В шапке у предупреждения своя рамка слева, и пропустить его нельзя.
 */
const startupNotices = [
  ...(dialerProblem ? [`Автодозвон отключён: ${dialerProblem}`] : []),
  ...(localModel ? ['Локальная модель: расход не считается, ключ не нужен'] : []),
]

console.clear()
if (debug) {
  if (localEnv.loaded.length) console.log(`[nemo] ключи из ${localEnv.files.join(', ')}: ${localEnv.loaded.join(', ')}`)
  for (const one of skipped) console.log(`[nemo] не подключено: ${one}`)
  for (const one of mcp.failures) console.log(`[nemo] MCP ${one.server}: ${one.error}`)
}

/*
 * ШАПКА: ЛОГОТИП, СТРОКА СОСТОЯНИЯ, ДЕРЕВО ГОТОВНОСТИ.
 *
 * Прежде здесь стоял двухколоночный короб. Он честно показывал те же данные, но читался как форма:
 * взгляд обходил рамку, искал заголовки колонок и только потом добирался до содержимого. Логотип с
 * одной строкой состояния под ним узнаётся мгновенно, а остальное уходит в дерево — там видно и
 * порядок шагов, и их итог.
 */
for (const line of header({
  version: CLI_VERSION,
  model: shortModel(model),
  plan: role.name,
  cwd: shortenPath(process.cwd(), os.homedir()),
}, theme, { width: width(), notices: startupNotices })) console.log(line)

/*
 * Дерево готовности. Именно ЧТО ЕСТЬ, а не чего нет.
 *
 * Список «недоступно: …» при старте читался как пять поломок и заставлял искать причину там, где её
 * нет: браузер выключен настройкой, ffmpeg не нужен для поиска клиентов. Чего нет — покажет /health
 * по запросу.
 */
for (const line of treeBlock([
  `${skills.length} ${plural(skills.length, 'навык', 'навыка', 'навыков')} загружено`,
  `Инструменты: ${toolBadges(activeRegistry.names())}`,
  `Роль: ${role.name} — ${role.title}`,
], theme)) console.log(line)

// Негодная настройка автодозвона — ОШИБКА, а не «просто не подключено», и печатается она всегда, а
// не только в --debug. Место у неё теперь в шапке, среди startupNotices: там левая черта отделяет
// то, что человек обязан заметить, от того, что он может пролистать.

console.log('')
printHud()
console.log(divider(width()))
console.log(statusBar({ role: role.name }))
console.log('')

for (;;) {
  const input = (await ask.line(c.magenta(INPUT_PROMPT))).trim()
  if (!input) continue

  /*
   * СТРОКА, НАЧИНАЮЩАЯСЯ С «/», НЕ УХОДИТ В МОДЕЛЬ. НИКОГДА.
   *
   * Разбор команды может вернуть null — на «/», на «/ 5 клиник», на что угодно, что не похоже на имя
   * команды. Раньше такая строка отправлялась модели как обычная фраза: человек платил за токены,
   * ждал ответа и получал рассуждение о том, что означает «/». Хуже того, опечатка в имени команды
   * («/agnet qa») выглядела бы как разговор, и человек считал бы, что роль сменилась.
   *
   * Поэтому решение принимается по ПЕРВОМУ ЗНАКУ, а не по успеху разбора.
   */
  if (input.startsWith('/')) {
    const command = parseSlash(input)
    if (!command) {
      console.log(`  ${c.dim('это не похоже на команду. Список: /help')}\n`)
      continue
    }
    let result
    try {
      result = await runSlash(command, commandDeps)
    } catch (error) {
      console.log(`  ${c.red('×')} ${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    if (result.kind === 'exit') break
    if (result.kind === 'lines') { console.log(''); for (const line of result.lines) console.log(line); console.log('') ; continue }
    if (result.kind === 'unknown') {
      const hint = result.suggestions.length ? ` Может быть: ${result.suggestions.map((one) => `/${one}`).join(', ')}` : ''
      console.log(`  ${c.dim(`нет команды /${result.name}.${hint} Список: /help`)}\n`)
      continue
    }
    // Других видов результата нет: ветка «превратить команду в запрос к модели» убрана вместе с
    // возможностью отправить слеш-строку в LLM.
    continue
  }

  console.log(userBar(input, new Date(), width()))
  await runTurn(input)
}

async function runTurn(text) {
  // Ход обязан открываться здесь: отсюда рендерер узнаёт и время начала (для «✦ Думал N с»), и роль
  // (для бейджа «✦ Nemo (sdr)»). Без этого вызова оба бейджа молча не печатаются.
  renderer.beginTurn(role.name)
  const startedAt = Date.now()
  try {
    await session.send(text)
  } catch (error) {
    console.log(`\n${c.red('×')} ${error instanceof Error ? error.message : String(error)}`)
  }
  renderer.finishTurn()
  /*
   * СТРОКА СОСТОЯНИЯ ОБНОВЛЯЕТСЯ НА ГРАНИЦЕ ХОДА, А НЕ ОДИН РАЗ ПРИ СТАРТЕ.
   *
   * printHud вызывался ровно однажды — при запуске, без аргумента. Счётчик контекста так и стоял на
   * стартовом «~1.8k» весь сеанс, а параметр busyMs не передавался никогда. То есть обе цифры, ради
   * которых строка и существует — сколько контекста съедено и сколько заняла генерация, — не
   * показывались. Понять, что пора /compact, было неоткуда: счётчик не двигался.
   *
   * Третий случай одного класса за сеанс: функция написана, покрыта тестами через прямой вызов и не
   * вызвана живым циклом. Контракт на связку рядом с contract'ом beginTurn.
   */
  printHud(Date.now() - startedAt)
  console.log('')
}

ask.close()
await mcp.close()
await qaProbe?.close()
await browser.close()
console.log(`\n${c.dim('До связи.')}\n`)
process.exit(0)
