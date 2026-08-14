// План действий для браузерного агента: промпт и — главное — ПРОВЕРКА ответа.
//
// Модель предлагает, что нажать и что вписать на чужой странице. Ошибка здесь стоит не «неверного
// ответа в чате», а нажатой кнопки в кабинете продавца, поэтому всё, что вернула модель, проходит
// через фильтр ниже: номера сверяются со снимком, действия — с коротким списком разрешённых,
// значения обрезаются. Что не прошло — отбрасывается молча для модели и НАЗЫВАЕТСЯ в отчёте.
//
// Модуль чистый: ни сети, ни базы. Здесь весь риск агентского контура, поэтому здесь же тесты.

/** Элемент снимка страницы — ровно то, что прислал сканер расширения. */
export interface PageItem {
  id: number
  kind: string
  label?: string
  text?: string
  placeholder?: string
  name?: string
  value?: string
  disabled?: boolean
  context?: string
  risky?: boolean
  options?: string[]
}

export type PlanAction =
  | { type: 'type'; id: number; value: string }
  | { type: 'click'; id: number }
  | { type: 'select'; id: number; value: string }

export const ALLOWED_ACTIONS = ['type', 'click', 'select'] as const
/** Длиннее этого в поле формы не пишут: это уже не значение, а попытка что-то сломать. */
export const MAX_VALUE_LENGTH = 30_000
/** План длиннее двадцати шагов на одной странице — почти наверняка не план, а перебор. */
export const MAX_ACTIONS = 20

export const PLAN_SYSTEM_PROMPT = `Ты помогаешь заполнять формы на веб-страницах.

Тебе дают снимок страницы: список интерактивных элементов с номерами, подписями, плейсхолдерами и
окружающим текстом. И поручение от владельца страницы.

Верни JSON: {"actions": [...], "note": "одна фраза о том, что делаешь или почему не можешь"}.

Действие — одно из трёх:
  {"type":"type","id":<номер>,"value":"<текст>"}
  {"type":"click","id":<номер>}
  {"type":"select","id":<номер>,"value":"<текст варианта>"}

ПРАВИЛА, КОТОРЫЕ ВАЖНЕЕ ПОЛНОТЫ ОТВЕТА:
1. Используй ТОЛЬКО номера из снимка. Придуманный номер — это действие над случайным элементом.
2. Если подходящего поля нет — не подставляй похожее. Верни пустой список и объясни в note.
3. Не заполняй поле, если не уверен, что оно то самое. Пустое поле правится за минуту, текст не в
   том поле замечают через сутки.
4. Элементы с "risky": true не нажимай, пока владелец не попросил об этом прямо.
5. Не трогай поля с "disabled": true.
6. Соблюдай смысл языка: поле «на русском» получает русский текст, «на узбекском» — узбекский.
   Слово Uzum в контексте языком поля не делает.`

/** Данные черновика в виде, пригодном для промпта. Ключи говорящие: модель читает их как подписи. */
export function planUserPrompt(input: {
  instruction: string
  page: { url?: string; title?: string; items: PageItem[] }
  data?: Record<string, unknown> | null
}): string {
  const items = input.page.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label || undefined,
    text: item.text || undefined,
    placeholder: item.placeholder || undefined,
    value: item.value || undefined,
    disabled: item.disabled || undefined,
    risky: item.risky || undefined,
    options: item.options?.length ? item.options : undefined,
    context: item.context || undefined,
  }))
  return JSON.stringify({
    instruction: input.instruction,
    page: { url: input.page.url, title: input.page.title, elements: items },
    data: input.data ?? null,
  })
}

export interface PlanCheck {
  actions: PlanAction[]
  /** Что отброшено и почему. Молчаливая фильтрация превращает отладку в гадание. */
  rejected: Array<{ action: unknown; reason: string }>
}

/**
 * Проверка плана против снимка.
 *
 * Ни одно действие не проходит на доверии. Номер обязан существовать в снимке — это отсекает и
 * выдумки модели, и подменённый по дороге ответ: элемента, которого мы не показывали, коснуться
 * нельзя.
 */
export function checkPlan(raw: unknown, items: PageItem[]): PlanCheck {
  const known = new Map(items.map((item) => [Number(item.id), item]))
  const actions: PlanAction[] = []
  const rejected: PlanCheck['rejected'] = []

  const list = Array.isArray((raw as { actions?: unknown })?.actions)
    ? (raw as { actions: unknown[] }).actions
    : []

  for (const candidate of list) {
    if (actions.length >= MAX_ACTIONS) {
      rejected.push({ action: candidate, reason: 'too_many_actions' })
      continue
    }
    const row = candidate as Record<string, unknown>
    const type = String(row?.type ?? '')
    if (!ALLOWED_ACTIONS.includes(type as typeof ALLOWED_ACTIONS[number])) {
      rejected.push({ action: candidate, reason: 'unknown_action' })
      continue
    }
    const id = Number(row?.id)
    if (!Number.isInteger(id) || !known.has(id)) {
      rejected.push({ action: candidate, reason: 'unknown_id' })
      continue
    }
    const item = known.get(id)!
    if (item.disabled) {
      rejected.push({ action: candidate, reason: 'disabled_element' })
      continue
    }

    if (type === 'click') {
      actions.push({ type: 'click', id })
      continue
    }

    const value = typeof row?.value === 'string' ? row.value : ''
    if (!value) {
      rejected.push({ action: candidate, reason: 'empty_value' })
      continue
    }
    if (value.length > MAX_VALUE_LENGTH) {
      rejected.push({ action: candidate, reason: 'value_too_long' })
      continue
    }
    // Печатать в кнопку или ссылку бессмысленно, а выбирать вариант можно только в списке.
    if (type === 'type' && !['input', 'textarea', 'richtext'].includes(item.kind)) {
      rejected.push({ action: candidate, reason: 'not_a_text_field' })
      continue
    }
    if (type === 'select' && item.kind !== 'select') {
      rejected.push({ action: candidate, reason: 'not_a_select' })
      continue
    }
    actions.push({ type: type as 'type' | 'select', id, value })
  }

  return { actions, rejected }
}

/** Одна фраза о результате. null — если модель ничего внятного не сказала. */
export function planNote(raw: unknown): string | null {
  const note = (raw as { note?: unknown })?.note
  return typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null
}
