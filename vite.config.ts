import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Переменные, без которых продакшн-сборка бессмысленна.
 *
 * Пустое значение приравнено к отсутствию НАМЕРЕННО. Приложение при пустом VITE_SUPABASE_URL не
 * падает, а уходит в демо-режим и показывает подставные данные — то есть выглядит работающим. Такая
 * сборка, выложенная на боевой домен, обманывает молча: человек регистрируется, видит «своих»
 * агентов и не понимает, почему ничего не сохраняется.
 */
const REQUIRED_FOR_PRODUCTION = [
  ['VITE_SUPABASE_URL', 'адрес проекта Supabase — без него приложение уходит в демо-режим'],
  ['VITE_SUPABASE_ANON_KEY', 'публикуемый ключ Supabase — без него не будет ни входа, ни данных'],
  ['VITE_API_GATEWAY_URL', 'адрес шлюза — без него клиенту нечего вставить себе на сайт'],
] as const

/** Обход проверки. Нужен там, где сборка — это проверка компиляции, а не выкладываемый артефакт. */
const BYPASS = 'NEMO_ALLOW_DEMO_BUILD'

const enabled = (value: unknown) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())

/**
 * Жёсткая проверка нужна на хостинге и в CI, но не при обычном локальном `npm run build`.
 * Vite всегда использует mode=production для build, поэтому один mode не отличает локальную
 * проверку компиляции от реального деплоя. На Vercel присутствует VERCEL/VERCEL_ENV, в CI — CI.
 * NEMO_STRICT_BUILD_ENV оставлен как явный переключатель для другого production-контура.
 */
const isHostedProductionBuild = (env: Record<string, string | undefined>) =>
  enabled(env.VERCEL) || Boolean(env.VERCEL_ENV?.trim()) || enabled(env.CI) || enabled(env.NEMO_STRICT_BUILD_ENV)

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') {
    const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
    const missing = REQUIRED_FOR_PRODUCTION.filter(([name]) => !String(env[name] ?? '').trim())

    const bypassed = enabled(env[BYPASS])
    const strict = isHostedProductionBuild(env)

    if (missing.length && strict && !bypassed) {
      const lines = missing.map(([name, why]) => `  ${name} — ${why}`).join('\n')
      throw new Error(
        `\nПродакшн-сборка остановлена: не заданы переменные окружения.\n\n${lines}\n\n` +
        `Образец — .env.production.example. На Vercel: Settings → Environment Variables.\n` +
        `Если это сборка ради проверки компиляции, а не для выкладки, поставьте ${BYPASS}=1.\n`,
      )
    }

    // Обход поставлен — собираем, но говорим об этом громко. Демо-сборка, принятая за боевую, и есть
    // тот случай, ради которого проверка написана.
    if (missing.length) {
      const reason = bypassed ? `${BYPASS}=1` : 'локальная сборка'
      console.warn(
        `\n[!] ${reason}: собирается ДЕМО-сборка. Не выкладывайте её на боевой домен.\n` +
        `    Не задано: ${missing.map(([name]) => name).join(', ')}\n`,
      )
    }
  }

  return { plugins: [react()] }
})
