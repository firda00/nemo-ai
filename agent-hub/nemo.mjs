// npm run nemo — универсальный агентный интерфейс.
//
// Здесь только подключения и ввод: цикл живёт в agent-runtime.ts, отрисовка — в nemo-ui.mjs,
// инструменты — в tools/platform.ts. Разделение не ради красоты: цикл и отрисовка проверяются
// сравнением строк без сети и без ключа, а этот файл проверить иначе как запуском нельзя.
//
// СТАРЫЙ ВИЗАРД ОСТАЁТСЯ. `npm run sdr:run -- --query ... --city ...` работает как раньше: он живёт в
// cron и в скриптах, и менять его поведение ради нового интерфейса значило бы сломать то, что уже
// работает у людей. Агент — отдельная точка входа.

import path from 'node:path'
import { loadLocalEnv } from './load-local-env.mjs'
import { Ask, c, dashboard, isInteractiveTerminal, stopActiveSpinner } from './tui.mjs'
import { AgentSession, buildAgentSystemPrompt, createOpenRouterStream, DEFAULT_AGENT_MODEL, MAX_STEPS } from './agent-runtime.ts'
import { buildPlatformRegistry } from './tools/platform.ts'
import { createRenderer, confirmationPrompt } from './nemo-ui.mjs'
import { parseCommand } from './query-parse.mjs'

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

const browser = createBrowserBridge()
const cards = resolveLeadCardConfig()

const { registry, skipped } = buildPlatformRegistry({
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

// ── Экран ────────────────────────────────────────────────────────────────────────────────────────

console.clear()
if (debug && localEnv.loaded.length) console.log(`[nemo] ключи из ${localEnv.files.join(', ')}: ${localEnv.loaded.join(', ')}`)

console.log(dashboard({
  title: c.bold('Nemo — агент'),
  left: [
    c.magenta('NEMO AGENT'),
    `Модель:  ${process.env.NEMO_AGENT_MODEL ?? DEFAULT_AGENT_MODEL}`,
    `Инструментов: ${registry.size()}`,
    `Шагов на ответ: до ${MAX_STEPS}`,
  ],
  right: [
    c.bold('Просто напишите, что нужно'),
    c.dim('найди 10 клиник в Ташкенте'),
    c.dim('что ты умеешь?'),
    '',
    c.dim('/tools — список   /exit — выход'),
  ],
}))
for (const one of skipped) console.log(`  ${c.dim(`недоступно: ${one}`)}`)

const renderer = createRenderer()
const ask = new Ask()

const session = new AgentSession(
  buildAgentSystemPrompt({ toolNames: registry.names(), hasConfirm: true }),
  {
    registry,
    stream: createOpenRouterStream({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.NEMO_AGENT_MODEL,
    }),
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

console.log('')
for (;;) {
  const input = (await ask.line(`${c.magenta('❯')} `)).trim()

  const command = parseCommand(input)
  if (command) {
    if (['exit', 'quit', 'q'].includes(command.name)) break
    if (command.name === 'tools') {
      console.log('')
      for (const name of registry.names()) {
        const tool = registry.get(name)
        const mark = tool.permission === 'action' ? c.yellow('действие') : c.dim('чтение  ')
        console.log(`  ${mark} ${c.bold(name)}`)
        console.log(`           ${c.dim(tool.description.slice(0, 100))}`)
      }
      console.log('')
      continue
    }
    if (command.name === 'clear') { console.clear(); continue }
    console.log(`  ${c.dim(`нет такой команды: /${command.name}`)}`)
    continue
  }
  if (!input) continue

  console.log('')
  try {
    await session.send(input)
  } catch (error) {
    console.log(`\n${c.red('×')} ${error instanceof Error ? error.message : String(error)}`)
  }
  renderer.finishTurn()
  console.log('')
}

ask.close()
await browser.close()
console.log(`\n${c.dim('До связи.')}\n`)
process.exit(0)
