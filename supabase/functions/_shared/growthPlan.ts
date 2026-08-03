// Deterministic growth plan for a marketplace store.
//
// The owner asks for +20% in a week. No model can promise that, and a generated number would be
// exactly the kind of confident fiction this codebase has spent its recent history removing. What
// CAN be computed from live data is the arithmetic of the target:
//
//   * how many extra units +20% actually means,
//   * how many of those are recoverable from demand the store is already losing (sold-out SKUs),
//   * how much money is frozen in stock that sold nothing,
//   * and how big the remainder is — the part that needs new demand and therefore cannot be
//     computed here at all.
//
// Every number below is arithmetic over rows fetched from the seller API. The model's job is to
// turn them into a proposal, never to produce them.

export interface GrowthRow {
  sku: string
  name: string
  price: number | null
  stock: number | null
  units: number | null // sold in the measured window
}

export interface GrowthPlan {
  windowDays: number
  targetPct: number
  baseUnits: number
  targetUnits: number
  gapUnits: number
  soldOut: Array<{ sku: string; name: string; units: number }>
  recoverableUnits: number
  lowCover: Array<{ sku: string; name: string; units: number; stock: number; coverDays: number }>
  deadStock: Array<{ sku: string; name: string; stock: number; frozen: number | null }>
  frozenMoney: number | null
  remainderUnits: number
}

const round = (n: number): number => Math.round(n * 100) / 100

export function growthPlan(rows: GrowthRow[], targetPct = 20, windowDays = 7): GrowthPlan {
  const measured = rows.filter((r) => r.units != null)
  const baseUnits = measured.reduce((sum, r) => sum + (r.units ?? 0), 0)
  const targetUnits = Math.ceil(baseUnits * (1 + targetPct / 100))
  const gapUnits = Math.max(0, targetUnits - baseUnits)

  // Demand the store is already losing: it sold in the window and has nothing left to sell.
  // Recovering it is the only growth lever whose size is known rather than hoped for.
  const soldOut = measured
    .filter((r) => (r.units ?? 0) > 0 && r.stock === 0)
    .map((r) => ({ sku: r.sku, name: r.name, units: r.units as number }))
    .sort((a, b) => b.units - a.units)
  const recoverableUnits = soldOut.reduce((sum, r) => sum + r.units, 0)

  // Selling now but with less than one window of cover left — the next stockout, still preventable.
  const lowCover = measured
    .filter((r) => (r.units ?? 0) > 0 && (r.stock ?? 0) > 0 && (r.stock as number) < (r.units as number))
    .map((r) => ({
      sku: r.sku,
      name: r.name,
      units: r.units as number,
      stock: r.stock as number,
      coverDays: round(((r.stock as number) / (r.units as number)) * windowDays),
    }))
    .sort((a, b) => a.coverDays - b.coverDays)

  // Stock that produced nothing in the window. Its money is the discount budget, and a markdown
  // here is the cheapest source of extra units — but how many it converts is NOT computable.
  const deadStock = measured
    .filter((r) => (r.units ?? 0) === 0 && (r.stock ?? 0) > 0)
    .map((r) => ({
      sku: r.sku,
      name: r.name,
      stock: r.stock as number,
      frozen: r.price != null ? round((r.stock as number) * r.price) : null,
    }))
    .sort((a, b) => (b.frozen ?? 0) - (a.frozen ?? 0))
  const pricedDead = deadStock.filter((r) => r.frozen != null)
  const frozenMoney = pricedDead.length ? round(pricedDead.reduce((sum, r) => sum + (r.frozen as number), 0)) : null

  return {
    windowDays,
    targetPct,
    baseUnits,
    targetUnits,
    gapUnits,
    soldOut,
    recoverableUnits,
    lowCover,
    deadStock,
    frozenMoney,
    remainderUnits: Math.max(0, gapUnits - recoverableUnits),
  }
}

/** The plan as an evidence block: computed facts plus an explicit boundary on what they prove. */
export function growthPlanBlock(plan: GrowthPlan): string {
  if (!plan.baseUnits && !plan.deadStock.length) return ''
  const lines: string[] = [
    `=== РАСЧЁТ ЦЕЛИ +${plan.targetPct}% (посчитано сервером, не моделью) ===`,
    `Продано за ${plan.windowDays} дн.: ${plan.baseUnits} ед. Цель: ${plan.targetUnits} ед. Нужно дополнительно: ${plan.gapUnits} ед.`,
  ]

  if (plan.soldOut.length) {
    lines.push(
      `Распродано при живом спросе — ${plan.soldOut.length} SKU, теряется до ${plan.recoverableUnits} ед. за ${plan.windowDays} дн.:`,
      ...plan.soldOut.slice(0, 10).map((r) => `  ${r.sku} — ${r.name}: продано ${r.units}, остаток 0`),
      'Это единственный прирост с известным размером: пополнение возвращает спрос, который уже есть.',
    )
  } else {
    lines.push('Распроданных позиций с живым спросом нет — лёгкого возврата потерянных продаж не будет.')
  }

  if (plan.lowCover.length) {
    lines.push(
      `Закончатся в ближайшие дни — ${plan.lowCover.length} SKU:`,
      ...plan.lowCover.slice(0, 10).map((r) => `  ${r.sku} — ${r.name}: остаток ${r.stock}, хватит на ${r.coverDays} дн.`),
    )
  }

  if (plan.deadStock.length) {
    lines.push(
      `Ноль продаж при наличии остатка — ${plan.deadStock.length} SKU${plan.frozenMoney != null ? `, заморожено ${plan.frozenMoney}` : ''}:`,
      ...plan.deadStock.slice(0, 10).map((r) => `  ${r.sku} — ${r.name}: остаток ${r.stock}${r.frozen != null ? `, ${r.frozen}` : ''}`),
    )
  }

  lines.push(
    '',
    `ГРАНИЦА РАСЧЁТА: пополнение покрывает максимум ${Math.min(plan.recoverableUnits, plan.gapUnits)} ед. из ${plan.gapUnits}.`,
    `Оставшиеся ${plan.remainderUnits} ед. должны прийти из нового спроса — скидки, реклама, карточки, трафик.`,
    'Насколько они сработают, из этих данных не следует. Не называй проценты роста от промо как факт:',
    'предложи действия, укажи ожидаемый эффект как гипотезу и способ проверки через неделю.',
    'Без себестоимости и комиссий (Uzum их не отдаёт) прибыль от скидки не считается — только выручка.',
    '=== КОНЕЦ РАСЧЁТА ===',
  )
  return lines.join('\n')
}
