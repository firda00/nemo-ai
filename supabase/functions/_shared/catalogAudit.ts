// Deterministic catalogue audit for a connected marketplace. This is deliberately separate from
// the LLM: a model may explain the result and draft copy, but it must not decide that an SKU did
// not sell when the seller API did not provide a reliable sales match.

export type CatalogAuditClass = 'scale' | 'keep' | 'fix' | 'pause' | 'insufficient_data'

export interface CatalogAuditRow {
  sku: string
  name: string
  price: number | null
  stock: number | null
  units: number | null
}

export interface CatalogAuditItem extends CatalogAuditRow {
  class: CatalogAuditClass
  reason: string
  recommendation: string
}

const CLASS_LABEL: Record<CatalogAuditClass, string> = {
  scale: 'Пополнить',
  keep: 'Оставить',
  fix: 'Проверить карточку',
  pause: 'Проверить ассортимент',
  insufficient_data: 'Недостаточно данных',
}

const priorityOf = (item: CatalogAuditItem): number => (
  item.class === 'scale' ? 0 : item.class === 'fix' ? 1 : item.class === 'pause' ? 2 : item.class === 'keep' ? 3 : 4
)

export function catalogAudit(rows: CatalogAuditRow[]): CatalogAuditItem[] {
  return rows.map((row) => {
    if (row.units == null || row.stock == null) {
      return {
        ...row,
        class: 'insufficient_data',
        reason: 'Продажи за 7 дней или остаток не удалось надёжно сопоставить с этой позицией.',
        recommendation: 'Сначала сверить SKU/выгрузку. Не делать вывод, что товар не продаётся.',
      }
    }
    if (row.units > 0 && row.stock === 0) {
      return {
        ...row,
        class: 'scale',
        reason: `За 7 дней продано ${row.units}, остаток 0: спрос уже есть, но товар закончился.`,
        recommendation: 'Проверить пополнение и срок поставки. Карточку не менять до восстановления наличия.',
      }
    }
    if (row.units === 0 && row.stock > 0) {
      return {
        ...row,
        class: 'fix',
        reason: `За 7 дней продаж 0 при остатке ${row.stock}. Это кандидат на аудит карточки, а не доказательство плохого товара.`,
        recommendation: 'Проверить главное фото, заголовок, поисковые фразы, описание, цену и категорию; подготовить черновик, но не менять карточку без подтверждения владельца.',
      }
    }
    if (row.units === 0 && row.stock === 0) {
      return {
        ...row,
        class: 'pause',
        reason: 'Продаж за 7 дней нет и остаток 0.',
        recommendation: 'Проверить, нужна ли позиция в активном ассортименте; данные не доказывают, что её следует удалять.',
      }
    }
    return {
      ...row,
      class: 'keep',
      reason: `За 7 дней продано ${row.units}, остаток ${row.stock}.`,
      recommendation: 'Оставить карточку, следить за остатком и сравнить результат через 7 дней.',
    }
  })
}

/**
 * Owner-facing audit produced entirely on the server. Unlike an LLM summary, this cannot turn a
 * zero-stock SKU into "stock is available" or treat an absent sales match as zero sales.
 */
export function catalogAuditOwnerReport(rows: CatalogAuditRow[], windowDays = 7): string {
  const audited = catalogAudit(rows)
  if (!audited.length) return '📊 Аудит Uzum\n\nСервер не получил ни одной товарной позиции. Проверьте доступ ключа к магазину.'

  const counts = Object.fromEntries(['scale', 'keep', 'fix', 'pause', 'insufficient_data']
    .map((key) => [key, audited.filter((item) => item.class === key).length])) as Record<CatalogAuditClass, number>
  const priority = audited
    .filter((item) => item.class === 'scale' || item.class === 'fix' || item.class === 'pause')
    .sort((a, b) => priorityOf(a) - priorityOf(b) || (b.stock ?? 0) - (a.stock ?? 0))
    .slice(0, 24)
  const lines = [
    `📊 Аудит магазина Uzum — последние ${windowDays} дней`,
    `Получено позиций: ${audited.length}.`,
    `• Пополнить: ${counts.scale}\n• Проверить карточки: ${counts.fix}\n• Проверить ассортимент: ${counts.pause}\n• Оставить: ${counts.keep}\n• Недостаточно данных: ${counts.insufficient_data}`,
  ]

  if (priority.length) {
    lines.push('', '🎯 Приоритетные позиции')
    for (const item of priority) {
      const sales = item.units == null ? 'продажи не сопоставлены' : `продано ${item.units}`
      const stock = item.stock == null ? 'остаток неизвестен' : `остаток ${item.stock}`
      const price = item.price == null ? '' : `, цена ${item.price}`
      lines.push(`\n### ${CLASS_LABEL[item.class]} — ${item.name}`)
      lines.push(`SKU: ${item.sku || 'не получен'}; ${sales}; ${stock}${price}.`)
      lines.push(`Что сделать: ${item.recommendation}`)
    }
  } else {
    lines.push('', 'Нет позиции с подтверждённым поводом менять карточку или ассортимент в этом периоде.')
  }

  lines.push(
    '',
    'Важно: «проверить карточку» не означает, что карточка плохая. Сервер не получил фото и текущее описание, поэтому их можно только проверить, а новый текст подготовить из подтверждённых характеристик.',
    'Отзывы и комментарии текущий доступ Uzum API не возвращает. Пришлите экспорт отзывов в CSV/TXT или вставьте текст: бот выделит повторяющиеся жалобы, плюсы и гипотезы улучшений. Ничего не меняется без вашего подтверждения.',
  )
  return lines.join('\n')
}

/** The complete fetched catalogue, used only when the owner explicitly asks to list products. */
export function catalogueOwnerReport(rows: CatalogAuditRow[], windowDays = 7): string {
  if (!rows.length) return '📦 Каталог Uzum\n\nСервер не получил товарные позиции.'
  const lines = [`📦 Каталог Uzum: получено ${rows.length} позиций`, `Продажи указаны за ${windowDays} дней; пустое значение означает «неизвестно», а не ноль.`]
  for (const row of rows) {
    const data = [
      row.sku ? `SKU ${row.sku}` : 'SKU не получен',
      row.price == null ? 'цена неизвестна' : `цена ${row.price}`,
      row.stock == null ? 'остаток неизвестен' : `остаток ${row.stock}`,
      row.units == null ? 'продажи не сопоставлены' : `продано ${row.units}`,
    ]
    lines.push(`\n### ${row.name}\n${data.join(' • ')}`)
  }
  return lines.join('\n')
}

/** Compact facts-first report for the owner and the specialist that drafts product-card copy. */
export function catalogAuditBlock(rows: CatalogAuditRow[], windowDays = 7): string {
  const audited = catalogAudit(rows)
  const counts = Object.fromEntries(['scale', 'keep', 'fix', 'pause', 'insufficient_data'].map((key) => [key, audited.filter((item) => item.class === key).length])) as Record<CatalogAuditClass, number>
  const priority = audited
    .filter((item) => item.class === 'fix' || item.class === 'scale' || item.class === 'pause')
    .sort((a, b) => {
      const rank = (item: CatalogAuditItem) => item.class === 'scale' ? 0 : item.class === 'fix' ? 1 : 2
      return rank(a) - rank(b) || (b.stock ?? 0) - (a.stock ?? 0)
    })
    .slice(0, 12)

  if (!audited.length) return ''
  const lines = [
    `=== АУДИТ АССОРТИМЕНТА UZUM: ${windowDays} ДНЕЙ (рассчитано сервером) ===`,
    `Масштабировать: ${counts.scale}; оставить: ${counts.keep}; улучшить карточку: ${counts.fix}; проверить/пауза: ${counts.pause}; недостаточно данных: ${counts.insufficient_data}.`,
  ]
  if (priority.length) {
    lines.push('Приоритетные позиции:')
    for (const item of priority) {
      const facts = [
        item.sku ? `SKU ${item.sku}` : 'SKU не получен',
        item.units != null ? `продано ${item.units}` : 'продажи неизвестны',
        item.stock != null ? `остаток ${item.stock}` : 'остаток неизвестен',
        item.price != null ? `цена ${item.price}` : 'цена неизвестна',
      ]
      lines.push(`• [${item.class}] ${item.name} — ${facts.join(', ')}.`)
      lines.push(`  Факт: ${item.reason}`)
      lines.push(`  Рекомендация: ${item.recommendation}`)
    }
  } else {
    lines.push('Нет позиций с подтверждённым поводом менять карточку в этом окне.')
  }
  lines.push(
    'ПРАВИЛО: не утверждай, что текущее описание или фото плохие — сервер их не получил. Для класса fix предложи план проверки и черновик нового заголовка/описания только из подтверждённого названия. Не придумывай материал, размер, сертификаты, характеристики или эффект товара.',
    'Изменение карточки, цены, остатков, публикация или снятие с продажи возможны только после явного подтверждения владельца.',
    '=== КОНЕЦ АУДИТА ===',
  )
  return lines.join('\n')
}
