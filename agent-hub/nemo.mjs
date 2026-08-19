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

import path from 'node:path'
import fs from 'node:fs/promises'
import { loadLocalEnv } from './load-local-env.mjs'
import { Ask, c, dashboard, isInteractiveTerminal, stopActiveSpinner } from './tui.mjs'
import {
  AgentSession, buildAgentSystemPrompt, createOpenRouterStream, DEFAULT_AGENT_MODEL, MAX_STEPS,
  setSessionRegistry,
} from './agent-runtime.ts'
import { buildPlatformRegistry } from './tools/platform.ts'
import { restrictRegistry } from './tools/registry.ts'
import { createRenderer, confirmationPrompt } from './nemo-ui.mjs'
import {
  AGENT_ROLES, COMPACT_INSTRUCTION, DEFAULT_ROLE, LOCAL_MODEL_BASE, completeSlash, parseSlash, runSlash,
} from './cli/commands.ts'
import { collectHealth, fetchBalance, toolBadges } from './cli/wiring.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
const localEnv = loadLocalEnv(repoRoot)
const debug = process.argv.includes('--debug')

if (!process.env.OPENROUTER_API_KEY) {
  console.error('Нужен OPENROUTER_API_KEY: агент без модели работать не может.')
  console.error('Ключ подхватывается из .secrets.local, .env.local или .env.')
  process.exit(1)
}
if (!isInteractiveTerminal()) {
  // Агент — диалоговый режим. В конвейере он повис бы на первом же вопросе, и выглядело бы это как
  // зависший процесс. Для скриптов есть режим флагов у sdr:run.
  console.error('Агенту нужен терминал. Для скриптов: npm run sdr:run -- --query "..." --city "..."')
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
  browserEngine: browser.fallback ? browser.engine : undefined,
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
let localModel = false

const buildStream = () => createOpenRouterStream({
  apiKey: process.env.OPENROUTER_API_KEY,
  model,
  baseUrl: localModel ? LOCAL_MODEL_BASE : undefined,
})

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
  buildAgentSystemPrompt({ toolNames: fullRegistry.names(), hasConfirm: true, mission: role.mission }),
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
      const answer = (await ask.line(`${c.magenta('❯')} `)).trim().toLowerCase()
      // Умолчание — ОТКАЗ. Enter на вопросе про отправку сообщения живому человеку не должен означать
      // согласие: цена ошибки здесь несимметрична.
      return ['д', 'да', 'y', 'yes', 'ага'].includes(answer)
    },
    onEvent: (event) => renderer.onEvent(event),
  },
)

/** Применить роль: новый промпт и суженный круг инструментов. */
function applyRole(next) {
  role = next
  const narrowed = restrictRegistry(fullRegistry, next.tools)
  setSessionRegistry(session, narrowed)
  session.setSystemPrompt(buildAgentSystemPrompt({
    toolNames: narrowed.names(), hasConfirm: true, mission: next.mission,
  }))
  return narrowed
}
let activeRegistry = restrictRegistry(fullRegistry, role.tools)

const commandDeps = {
  session,
  get registry() { return activeRegistry },
  setRole: (next) => { activeRegistry = applyRole(next) },
  currentRole: () => role,
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
  balance: () => fetchBalance(process.env.OPENROUTER_API_KEY),
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

console.clear()
if (debug) {
  if (localEnv.loaded.length) console.log(`[nemo] ключи из ${localEnv.files.join(', ')}: ${localEnv.loaded.join(', ')}`)
  for (const one of skipped) console.log(`[nemo] не подключено: ${one}`)
  for (const one of mcp.failures) console.log(`[nemo] MCP ${one.server}: ${one.error}`)
}

console.log(dashboard({
  title: c.bold('Nemo — агент'),
  left: [
    c.magenta('NEMO AGENT'),
    `Модель: ${model}`,
    `Роль:   ${role.name} (${role.title})`,
    // Что ЕСТЬ, а не чего нет: список «недоступно: …» при старте читается как пять поломок и
    // заставляет искать причину там, где её нет. Чего нет — покажет /health по запросу.
    `Инструменты: ${toolBadges(activeRegistry.names())}`,
  ],
  right: [
    c.bold('Просто напишите, что нужно'),
    c.dim('найди 10 клиник в Ташкенте'),
    c.dim('/browse https://example.com'),
    '',
    c.dim('/help — команды, Tab — подсказка'),
  ],
}))

console.log('')
for (;;) {
  const input = (await ask.line(`${c.magenta('❯')} `)).trim()
  if (!input) continue

  const command = parseSlash(input)
  if (command) {
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
    // kind === 'prompt': команда превратилась в обычный запрос к модели.
    console.log('')
    await runTurn(result.text)
    continue
  }

  console.log('')
  await runTurn(input)
}

async function runTurn(text) {
  try {
    await session.send(text)
  } catch (error) {
    console.log(`\n${c.red('×')} ${error instanceof Error ? error.message : String(error)}`)
  }
  renderer.finishTurn()
  console.log('')
}

ask.close()
await mcp.close()
await browser.close()
console.log(`\n${c.dim('До связи.')}\n`)
process.exit(0)
