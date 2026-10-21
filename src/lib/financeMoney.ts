// Keep integer minor units exact through display; division as a Number can lose
// the last cent near MAX_SAFE_INTEGER even when the aggregate itself is exact.
export function formatFinanceMoney(minor: number, currency: string, locale = 'ru-RU'): string {
  if (!Number.isSafeInteger(minor)) return '—'
  const absolute = BigInt(Math.abs(minor))
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(absolute / 100n)
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .formatToParts(minor < 0 ? -1 : 1)
    .map(part => part.type === 'integer' ? integer : part.type === 'fraction' ? fraction : part.value).join('')
}
