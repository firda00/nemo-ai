/**
 * The silence watchdog.
 *
 * Every other finding in Commerce is evidence that something is wrong with a product. This one is
 * evidence that the evidence stopped arriving — and it is the only finding that has to be computed
 * without the sync, because the sync is the suspect.
 *
 * Pure on purpose: no Deno, no database, no network, so the rules can be tested outside the edge
 * runtime. The caller supplies rows and the current time.
 */
import { escapeHtml } from './telegramFormat.ts'

/**
 * Three missed cycles. The worker runs every four hours, so a single hiccup — one slow Uzum
 * response, one deploy — must not wake the owner. Twelve hours cannot be a hiccup, and it still
 * leaves the morning digest able to report an outage that began overnight.
 */
export const STALE_AFTER_HOURS = 12

export type CatalogueFreshnessRow = {
  catalog_id: string
  owner_account_id: string
  catalog_name: string
  connected_at: string
  last_observed_at: string | null
  last_sync_error?: string | null
  empty_confirmed_at?: string | null
  empty_notified_at?: string | null
}

/**
 * `empty` — подключённый магазин, в котором продавец ещё не завёл карточки.
 *
 * Отличается от `never` тем, что причина известна: Uzum ответил и отдал ноль карточек. Сторож
 * кричал о таком магазине 77 часов и был прав по своей логике — данных нет. Но «продавец ещё не
 * начал» и «синхронизация сломалась» требуют разного: первое — вежливой подсказки один раз,
 * второе — тревоги, пока не починят.
 */
export type FreshnessState = 'fresh' | 'stale' | 'never' | 'empty'

export type CatalogueFreshness = {
  catalogId: string
  name: string
  state: FreshnessState
  hours: number
  error: string | null
  /** Владелец посмотрел кабинет и подтвердил, что товаров нет. Тогда молчим совсем. */
  emptyConfirmed: boolean
  /** Подсказку «добавьте первые товары» уже отправляли. Вторая такая — спам. */
  emptyNotified: boolean
}

/**
 * Синк дописывает причину пустоты в last_sync_error, поэтому пустой магазин узнаётся по ответу
 * Uzum, а не по догадке. Без этой строки «ноль карточек» и «ключ не видит магазин» неразличимы.
 */
const EMPTY_SHOP_REASON = /вернул 0 карточек/i

function hoursBetween(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return null
  // A clock that disagrees with the database must not produce "не обновлялись -1 часов".
  return Math.max(0, Math.floor((now.getTime() - then) / 3_600_000))
}

/**
 * A catalogue that has never produced a snapshot is not automatically broken — it may have been
 * connected a minute ago. It becomes a finding once it has had the same twelve hours any working
 * catalogue would have used, and then it is the more serious of the two states: the seller believes
 * their shop is being watched and nothing has ever been read from it.
 */
export function catalogueFreshness(row: CatalogueFreshnessRow, now: Date): CatalogueFreshness {
  const name = String(row.catalog_name ?? '').trim() || 'Каталог'
  const error = row.last_sync_error ? String(row.last_sync_error) : null
  const base = {
    catalogId: row.catalog_id,
    name,
    error,
    emptyConfirmed: Boolean(row.empty_confirmed_at),
    emptyNotified: Boolean(row.empty_notified_at),
  }
  const observed = hoursBetween(row.last_observed_at, now)
  if (observed != null) {
    return { ...base, state: observed >= STALE_AFTER_HOURS ? 'stale' : 'fresh', hours: observed }
  }
  const connected = hoursBetween(row.connected_at, now) ?? 0
  if (connected < STALE_AFTER_HOURS) return { ...base, state: 'fresh', hours: connected }

  // Причина известна из ответа Uzum: карточек нет. Это не «синхронизация сломалась», это
  // «продавец ещё не начал», и тревога здесь была бы неправдой о том, что случилось.
  if (error && EMPTY_SHOP_REASON.test(error)) return { ...base, state: 'empty', hours: connected }

  return { ...base, state: 'never', hours: connected }
}

/**
 * Что заслуживает внимания.
 *
 * Подтверждённо пустой магазин выпадает совсем: владелец посмотрел кабинет и знает. Пустой,
 * которого ещё не подтверждали, остаётся — но как подсказка, а не как авария (см. emptyNotice).
 */
export function staleCatalogues(rows: CatalogueFreshnessRow[], now: Date): CatalogueFreshness[] {
  return rows
    .map((row) => catalogueFreshness(row, now))
    .filter((item) => item.state !== 'fresh')
    .filter((item) => !(item.state === 'empty' && item.emptyConfirmed))
}

/** Аварии — то, о чём стоит тревожить. Пустой магазин сюда не входит ни при каких условиях. */
export const brokenCatalogues = (items: CatalogueFreshness[]) => items.filter((item) => item.state !== 'empty')

/**
 * Вежливая подсказка вместо тревоги.
 *
 * Отправляется один раз: продавец, который ещё не завёл карточки, знает это и без нас, а
 * ежедневное напоминание об этом — повод отключить уведомления совсем.
 */
export function emptyNotice(items: CatalogueFreshness[], options: { multiShop: boolean }): string | null {
  const fresh = items.filter((item) => item.state === 'empty' && !item.emptyConfirmed && !item.emptyNotified)
  if (!fresh.length) return null
  const lines = ['🌱 <b>Магазин подключён, товаров пока нет</b>', '']
  for (const item of fresh) {
    lines.push(options.multiShop
      ? `<b>${escapeHtml(item.name)}</b>: Nemo подключился, но в кабинете Uzum ещё нет ни одной карточки.`
      : 'Nemo подключился, но в кабинете Uzum ещё нет ни одной карточки.')
  }
  lines.push(
    '',
    'Добавьте первые товары — и Nemo сразу посчитает комиссию, логистику и минимальную цену по каждому.',
    // Сказано прямо, чтобы «тишина» не читалась как поломка и чтобы никто не ждал второго письма.
    '<i>Это не ошибка и не требует ответа. Больше об этом магазине не напомним — начнём считать, как только товары появятся.</i>',
  )
  return lines.join('\n')
}

/** 1 час, 2 часа, 5 часов, 21 час — a broken plural reads as a broken system. */
export function hoursWord(count: number): string {
  const abs = Math.abs(Math.trunc(count))
  const tail = abs % 10
  const teen = abs % 100
  if (teen >= 11 && teen <= 14) return 'часов'
  if (tail === 1) return 'час'
  if (tail >= 2 && tail <= 4) return 'часа'
  return 'часов'
}

export const staleHoursPhrase = (hours: number) => `${hours} ${hoursWord(hours)}`

/**
 * The warning that opens the digest, and stands alone as an alert.
 *
 * Named per catalogue when the seller has several: "синхронизация приостановлена" is frightening
 * and useless if three of their four shops are fine. The stored sync error is quoted when there is
 * one, because "проверьте API-ключ" is a guess and `401 Unauthorized` is an answer.
 */
export function staleWarningText(items: CatalogueFreshness[], options: { multiShop: boolean; allStale: boolean }): string | null {
  if (!items.length) return null
  const lines: string[] = ['⚠️ <b>Синхронизация приостановлена</b>', '']

  for (const item of items) {
    const shop = options.multiShop ? `<b>${escapeHtml(item.name)}</b>: ` : ''
    lines.push(item.state === 'never'
      ? `${shop}с момента подключения не пришло ни одного товара (${staleHoursPhrase(item.hours)}).`
      : `${shop}данные Uzum не обновлялись ${staleHoursPhrase(item.hours)}.`)
    if (item.error) lines.push(`  Ответ Uzum: <code>${escapeHtml(item.error.slice(0, 120))}</code>`)
  }

  lines.push('', 'Проверьте API-ключ или статус кабинета продавца.')

  // The scope of the warning must match the scope of the breakage. One dead shop out of four does
  // not make the other three untrustworthy, and a watchdog that overstates the damage gets muted
  // exactly like one that understates it.
  lines.push(options.allStale
    ? '<i>Пока данные не идут, цифры Nemo устарели — на них нельзя опираться.</i>'
    : '<i>Остальные магазины обновляются нормально — их цифры актуальны.</i>')
  return lines.join('\n')
}
