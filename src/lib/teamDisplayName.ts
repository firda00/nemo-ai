export type TeamNameLanguage = 'ru' | 'uz' | 'en'

type TeamNameInput = {
  name?: string | null
  goal?: string | null
  niche?: string | null
  tasks?: string | null
  lang?: TeamNameLanguage
}

const generatedName = (value: string) =>
  value.length > 52 || /^(?:team|команда|jamoa)\s*:|^(?:создай|создайте|create|build|yarat)/i.test(value)

/** Turn a raw creation prompt into a stable customer-facing team name. */
export function teamDisplayName({ name, goal, niche, tasks, lang = 'en' }: TeamNameInput): string {
  const raw = String(name ?? '').trim()
  if (raw && !generatedName(raw)) return raw

  const context = `${raw} ${goal ?? ''} ${niche ?? ''} ${tasks ?? ''}`.toLowerCase()
  const names = lang === 'ru'
    ? {
        uzum: 'Команда роста Uzum', content: 'Контент-команда', sales: 'Отдел продаж',
        finance: 'Финансовая команда', support: 'Клиентский сервис', dev: 'Команда разработки',
        operations: 'Операционная команда', fallback: 'AI-команда',
      }
    : lang === 'uz'
      ? {
          uzum: 'Uzum o‘sish jamoasi', content: 'Kontent jamoasi', sales: 'Savdo jamoasi',
          finance: 'Moliya jamoasi', support: 'Mijozlar xizmati', dev: 'Dasturlash jamoasi',
          operations: 'Operatsion jamoa', fallback: 'AI jamoa',
        }
      : {
          uzum: 'Uzum Growth Team', content: 'Content Team', sales: 'Sales Team',
          finance: 'Finance Team', support: 'Customer Support Team', dev: 'Development Team',
          operations: 'Operations Team', fallback: 'AI Team',
        }

  if (/uzum|marketplace|маркетплейс|магазин/.test(context)) return names.uzum
  if (/video|reels|content|контент|медиа|marketing|маркет/.test(context)) return names.content
  if (/sales|crm|продаж|лид/.test(context)) return names.sales
  if (/finance|cash|cfo|бухгалтер|финанс/.test(context)) return names.finance
  if (/support|поддерж|клиент/.test(context)) return names.support
  if (/developer|development|software|разработ|код|сайт|приложен/.test(context)) return names.dev
  if (/operations?|операци|задач|workflow/.test(context)) return names.operations
  return names.fallback
}
