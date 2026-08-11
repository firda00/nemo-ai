// Кто имеет право на действие, а кто уже нет.
//
// Триал длится три дня от создания аккаунта. Не от первого платежа и не от первого входа: иначе
// «три дня» начинались бы в момент, который никто не может назвать, и сравнить два аккаунта между
// собой было бы нечем.
//
// ЗАПИРАЮТСЯ ТОЛЬКО НОВЫЕ ДЕЙСТВИЯ. Каталоги, черновики, история решений и юнит-экономика
// остаются читаемыми навсегда. Владелец, который видит, что система насчитала, но не может нажать,
// — это причина заплатить. Владелец, у которого отобрали его же данные, не возвращается.

/** Что именно запирается. Читающие экраны в списке отсутствуют намеренно. */
export type Feature = 'listing_draft' | 'digest' | 'price_action'

export type SubscriptionRow = {
  status: 'trial' | 'active' | 'past_due' | 'cancelled'
  trial_ends_at: string | null
  paid_until: string | null
} | null

export type Verdict = {
  allowed: boolean
  /** Почему отказано. Отказ без причины неотличим от поломки. */
  reason: 'ok' | 'trial_expired' | 'subscription_expired' | 'cancelled'
  /** Сколько дней триала осталось. null — когда триал уже не при чём. */
  trial_days_left: number | null
}

export const TRIAL_DAYS = 3
const DAY = 86_400_000

/**
 * Право на действие.
 *
 * Отсутствие строки подписки — НЕ отказ. Аккаунты, созданные до появления биллинга, строки не
 * имеют, и трактовать их отсутствие как «не оплачено» значило бы в день выката отключить всех
 * существующих клиентов разом. Такой аккаунт получает триал от даты своего создания, а дальше
 * общее правило.
 */
export function entitled(input: {
  subscription: SubscriptionRow
  accountCreatedAt: string | null
  now?: Date
}): Verdict {
  const now = input.now ?? new Date()
  const sub = input.subscription

  if (sub?.status === 'active') {
    // Активная подписка без даты — оплата есть, срок не назван. Это состояние платёжного модуля,
    // а не владельца, и наказывать его отказом за наш пробел нельзя.
    const until = sub.paid_until ? new Date(sub.paid_until) : null
    if (!until || until > now) return { allowed: true, reason: 'ok', trial_days_left: null }
    return { allowed: false, reason: 'subscription_expired', trial_days_left: null }
  }
  if (sub?.status === 'cancelled') return { allowed: false, reason: 'cancelled', trial_days_left: null }
  if (sub?.status === 'past_due') return { allowed: false, reason: 'subscription_expired', trial_days_left: null }

  // Триал: явная дата из подписки, иначе три дня от создания аккаунта.
  const started = input.accountCreatedAt ? new Date(input.accountCreatedAt) : null
  const ends = sub?.trial_ends_at
    ? new Date(sub.trial_ends_at)
    : started
      ? new Date(started.getTime() + TRIAL_DAYS * DAY)
      : null
  // Даты нет вообще — не отказываем. Молчаливый отказ по нашему пробелу дороже дня бесплатного
  // доступа, и увидим мы его по жалобе, а не по логу.
  if (!ends || Number.isNaN(ends.getTime())) return { allowed: true, reason: 'ok', trial_days_left: null }
  if (ends > now) {
    return { allowed: true, reason: 'ok', trial_days_left: Math.max(0, Math.ceil((ends.getTime() - now.getTime()) / DAY)) }
  }
  return { allowed: false, reason: 'trial_expired', trial_days_left: 0 }
}

/** Читает подписку и дату аккаунта и выносит вердикт. Одно место, чтобы не разошлись правила. */
export async function entitlementFor(admin: any, accountId: string, now?: Date): Promise<Verdict> {
  const [{ data: sub }, { data: account }] = await Promise.all([
    admin.from('billing_subscriptions').select('status, trial_ends_at, paid_until').eq('account_id', accountId).maybeSingle(),
    admin.from('accounts').select('created_at').eq('id', accountId).maybeSingle(),
  ])
  return entitled({ subscription: sub ?? null, accountCreatedAt: account?.created_at ?? null, now })
}

const MESSAGES: Record<Verdict['reason'], string> = {
  ok: '',
  trial_expired: 'Пробные три дня закончились. Продлите тариф, чтобы Nemo снова работал за вас.',
  subscription_expired: 'Срок подписки истёк. Продлите тариф для применения решений.',
  cancelled: 'Подписка отменена. Оформите тариф заново, чтобы продолжить.',
}

/**
 * Отказ словами.
 *
 * Данные при этом остаются на месте, и об этом сказано вслух: иначе владелец решит, что потерял
 * каталог, и уйдёт вместо того, чтобы оплатить.
 */
export function lockMessage(verdict: Verdict): string {
  if (verdict.allowed) return ''
  return `${MESSAGES[verdict.reason]} Всё, что уже собрано, остаётся доступным для просмотра.`
}
