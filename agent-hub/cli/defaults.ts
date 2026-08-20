/*
 * Боевые адреса, зашитые в собранный CLI.
 *
 * ЗДЕСЬ ТОЛЬКО ПУБЛИЧНОЕ. Собранный файл уезжает на чужие машины: всё, что в нём лежит, доступно
 * каждому, кто его получил. Публикуемый ключ Supabase на это и рассчитан — он ограничен политиками
 * RLS. Служебному ключу, ключу OpenRouter и перцу токенов здесь не место ни при каких условиях,
 * и проверка в контрактах за этим следит.
 *
 * Значения переопределяются переменными окружения: разработчику нужно уметь направить CLI на свой
 * стенд, не пересобирая его.
 */

const pick = (name: string, fallback: string): string => {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : fallback
}

/** Адрес проекта Supabase — вход и данные. */
export const SUPABASE_URL = pick('NEMO_SUPABASE_URL', "https://ogfmyjiuqmgroobckdyw.supabase.co")

/**
 * Публикуемый ключ (anon). ПУБЛИЧЕН ПО ЗАМЫСЛУ: он уходит в браузер на каждой загрузке сайта.
 * Единственное, что он даёт, — право обратиться к API от имени анонима, где всё ограничено RLS.
 */
export const SUPABASE_ANON_KEY = pick(
  'NEMO_SUPABASE_ANON_KEY',
  "sb_publishable_QvdG3S1oMAgXWv53R2_hpQ_osQd_s8_",
)

/** Веб-панель: туда CLI отправляет за тарифами и настройками. */
export const APP_URL = pick('NEMO_APP_URL', 'https://nemo-ai-firda00s-projects.vercel.app')

/** Шлюз: виджет и служебные ручки. */
export const GATEWAY_URL = pick('NEMO_GATEWAY_URL', 'https://nemo.185.8.213.144.sslip.io')
