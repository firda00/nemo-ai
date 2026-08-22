/*
 * Инструменты аудита разговоров и автодозвона.
 *
 * ЗДЕСЬ НЕТ ЛОГИКИ — только описания и переходники, как и в platform.ts. Работа живёт в
 * agent-hub/modules/sales-qa и agent-hub/modules/dialer, где она проверяется без сети и без модели.
 *
 * ── ПРАВА ────────────────────────────────────────────────────────────────────────────────────
 *
 * analyze_sales_call   read_only — читает расшифровку, отдаёт отчёт; наружу ничего не выходит.
 * dialer_status        read_only — показывает состояние очереди.
 * dialer_queue_lead    ACTION    — ставит живого человека в очередь на звонок.
 *
 * Постановка в очередь помечена действием, хотя сама по себе никому не звонит. Это осознанно:
 * очередь существует ровно затем, чтобы по ней позвонили, и человек должен видеть КАЖДОЕ добавление
 * до того, как оно случилось. Спрашивать позже, «перед набором», поздно — к тому моменту список уже
 * собран моделью, и подтверждать придётся оптом, не глядя.
 */
import { z } from 'zod'
import { defineTool } from './registry.ts'
import { buildAuditPrompt, buildReport, type RawAnalysis } from '../modules/sales-qa/auditor.ts'
import { DEFAULT_PLAYBOOK, PlaybookCatalog } from '../modules/sales-qa/playbook.ts'
import type { Dialer } from '../modules/dialer/queue.ts'

export const AnalyzeCallParams = z.object({
  transcript: z.string().min(40).max(200_000)
    .describe('Расшифровка разговора с отметками времени вида 0:14'),
  playbook_id: z.string().min(1).max(80).optional()
    .describe('Идентификатор сценария. Не указан — берётся базовый исходящий разговор'),
})

/**
 * Кто спрашивает модель. Зависимостью, чтобы разбор проверялся без сети.
 *
 * Сигнал прерывания передаётся ОБЯЗАТЕЛЬНО. Без него истёкший таймаут инструмента снимает ожидание,
 * а сам запрос к модели продолжает идти и тратить деньги — при расшифровке на двести тысяч знаков
 * это заметная сумма за ответ, которого никто уже не ждёт.
 */
export interface AskModel {
  (prompt: string, signal?: AbortSignal): Promise<string>
}

/**
 * Порог, за которым второй проход не делается.
 *
 * Второй проход отправляет расшифровку заново — то есть удваивает входные токены. Для короткого
 * разговора это разумная плата за точность, для часовой расшифровки — нет: подтверждённых этапов
 * прибавится один-два, а счёт вырастет вдвое. Предел выбран так, чтобы обычный звонок на десять
 * минут в него укладывался.
 */
const RETRY_TRANSCRIPT_LIMIT = 40_000

/**
 * Разбор ответа модели.
 *
 * Модель регулярно оборачивает JSON в ```-блок и дописывает пояснение до и после. Поэтому пробуются
 * ДВА способа по очереди, а не один: разметка блока бывает какой угодно (```json, ```JSON, ```text,
 * просто ```), и цепляться за неё — значит терять готовый разбор из-за трёх лишних букв.
 *
 * Разбор возвращает null, а не пустой отчёт. Пустой отчёт — это ноль процентов, и по нему накажут
 * менеджера за сбой разбора.
 */
function parseModelJson(text: string): RawAnalysis | null {
  const raw = String(text ?? '')
  const candidates: string[] = []
  for (const fenced of raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) candidates.push(fenced[1])
  const open = raw.indexOf('{')
  const close = raw.lastIndexOf('}')
  if (open >= 0 && close > open) candidates.push(raw.slice(open, close + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as RawAnalysis
      /*
       * Проверяется НЕ ТОЛЬКО «это объект», но и форма.
       *
       * Строка и число тоже разбираются JSON.parse. Но и объект бывает не тем: ответ
       * `{"stages":{}, "criteria":[]}` — формально объект, а разбор по нему падает на попытке
       * пройтись по stages, и вместо честного «модель вернула не то» получается исключение
       * инструмента, которое человек читает как поломку платформы.
       */
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.stages)) return parsed
    } catch { /* следующий способ */ }
  }
  return null
}

export function buildAnalyzeCallTool(deps: { ask: AskModel; catalog?: PlaybookCatalog }) {
  const catalog = deps.catalog ?? new PlaybookCatalog([DEFAULT_PLAYBOOK])
  return defineTool({
    name: 'analyze_sales_call',
    description: 'Разобрать расшифровку разговора по сценарию продаж: баллы по этапам, слабые зоны, '
      + 'подтверждённые цитаты и рекомендации. Каждое «выполнено» проверяется дословной цитатой из '
      + 'расшифровки; неподтверждённое обнуляется. Применять на просьбы «оцени звонок», «разбери '
      + 'разговор», «проверь менеджера по скрипту».',
    permission: 'read_only',
    parameters: AnalyzeCallParams,
    timeoutMs: 180_000,
    execute: async (args, context) => {
      const playbook = catalog.get(args.playbook_id ?? DEFAULT_PLAYBOOK.id)
      if (!playbook) {
        return { error: `сценария «${args.playbook_id}» нет`, available: catalog.list() }
      }

      /*
       * ДВА ПРОХОДА, И ВТОРОЙ НЕ ДЛЯ КРАСОТЫ.
       *
       * Первый проход модель делает «на глаз» и охотно засчитывает этапы. Второй идёт уже после
       * сверки цитат: то, что не подтвердилось, ей возвращают и просят пересмотреть — часто
       * оказывается, что подходящая цитата в расшифровке есть, просто она процитировала по памяти.
       *
       * Итог всё равно проходит проверку заново: второй проход — это шанс исправиться, а не право
       * быть принятым на слово.
       */
      const first = parseModelJson(await deps.ask(buildAuditPrompt(playbook, args.transcript), context?.signal))
      if (!first) return { error: 'модель вернула не JSON' }

      let report = buildReport(first, playbook, args.transcript)
      let retried = false
      if (report.downgraded.length > 0 && args.transcript.length <= RETRY_TRANSCRIPT_LIMIT) {
        const retry = [
          buildAuditPrompt(playbook, args.transcript),
          '',
          'ПРЕДЫДУЩИЙ ОТВЕТ ОТКЛОНЁН ЧАСТИЧНО. Эти этапы засчитаны без доказательства, которое',
          'удалось бы подтвердить по расшифровке:',
          ...report.downgraded.map((one) => `— этап ${one.stageId}: ${one.reason}`),
          '',
          'Приведи для них ТОЧНЫЕ цитаты с верными отметками времени либо честно поставь missed.',
        ].join('\n')

        /*
         * ВТОРОЙ ПРОХОД НЕ ИМЕЕТ ПРАВА ПОГУБИТЬ ПЕРВЫЙ.
         *
         * Он идёт по сети и падает по причинам, к разбору не относящимся: оборвалась связь, кончился
         * лимит, провайдер вернул пятисотку. Первый отчёт к этому моменту уже готов и пригоден —
         * потерять его из-за неудачного уточнения значит превратить улучшение в источник отказов.
         */
        try {
          const second = parseModelJson(await deps.ask(retry, context?.signal))
          retried = true
          if (second) {
            const better = buildReport(second, playbook, args.transcript)
            /*
             * Второй проход берётся, только если он ПОДТВЕРДИЛ больше — и не за счёт того, что
             * объявил лишнее неприменимым. Сравнение по одному лишь числу неподтверждённых давало
             * лазейку: ответ, где половина этапов «неприменима», формально лучше, а по сути это
             * оценка из ничего.
             *
             * Считается ВЕС исключённого, а не количество. В сценарии с несколькими условными
             * этапами можно исключить лёгкий и вместо него тяжёлый — количество то же, знаменатель
             * заметно меньше, итог выше.
             */
            const weightOf = new Map(playbook.stages.map((stage) => [stage.id, stage.weight]))
            const excluded = (one: typeof report) => one.stages
              .filter((stage) => stage.status === 'not_applicable')
              .reduce((sum, stage) => sum + (weightOf.get(stage.stageId) ?? 0), 0)
            if (better.downgraded.length < report.downgraded.length && excluded(better) <= excluded(report)) {
              report = better
            }
          }
        } catch { /* остаётся первый отчёт */ }
      }

      return {
        playbook: { id: playbook.id, title: playbook.title },
        scorePercent: report.scorePercent,
        stages: report.stages,
        criteria: report.criteria,
        weakStages: report.weakStages,
        unconfirmed: report.downgraded,
        summary: report.summary,
        recommendations: report.recommendations,
        issues: report.issues,
        // Человек должен видеть, был ли второй проход: он объясняет и время ответа, и расход.
        secondPass: retried,
      }
    },
  })
}

export const QueueLeadParams = z.object({
  lead_id: z.string().min(1).max(120).describe('Идентификатор лида'),
  phone: z.string().min(5).max(32).describe('Телефон в любом формате'),
  status: z.string().max(60).optional().describe('Статус лида: закрытые не обзваниваются'),
})

export function buildDialerQueueTool(deps: { dialer: Dialer }) {
  return defineTool({
    name: 'dialer_queue_lead',
    description: 'Поставить лид в очередь автодозвона. По умолчанию режим симуляции: настоящий '
      + 'звонок требует отдельного подтверждения человеком в терминале. Отказ возвращается с '
      + 'причиной: вне рабочих часов, нет в белом списке, исчерпан суточный предел и так далее.',
    permission: 'action',
    parameters: QueueLeadParams,
    timeoutMs: 15_000,
    execute: async (args) => {
      const result = deps.dialer.enqueue({ id: args.lead_id, phone: args.phone, status: args.status })
      if (!result.queued) {
        const decision = result.decision as { ok: false; reason: string; detail?: string }
        return { queued: false, reason: decision.reason, detail: decision.detail ?? null }
      }
      return {
        queued: true,
        queueId: result.item?.id,
        phone: result.item?.masked,
        mode: deps.dialer.status().mode,
      }
    },
  })
}

export function buildDialerStatusTool(deps: { dialer: Dialer }) {
  return defineTool({
    name: 'dialer_status',
    description: 'Состояние автодозвона: режим (симуляция или боевой), размер белого списка и очередь '
      + 'с замаскированными номерами. Применять на «что в очереди», «идут ли звонки».',
    permission: 'read_only',
    parameters: z.object({}),
    timeoutMs: 10_000,
    execute: async () => deps.dialer.status(),
  })
}
