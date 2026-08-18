// Запуск голосового воркера. Единственное место, где он встречается с настоящими Supabase, Telegram и CRM.
//
// Отделено от voice-worker.ts по той же причине, что main.ts отделён от gateway.ts: там логика, которую
// проверяют настоящим WebSocket-клиентом без сети и без базы, здесь — подключения и остановка.

import { createClient } from '@supabase/supabase-js'
import { resolveVoiceProviders } from './providers.ts'
import { startVoiceWorker } from './voice-worker.ts'
import type { PersistDeps } from './analytics.ts'

const PORT = Number(process.env.VOICE_PORT ?? 8080)

const url = process.env.SUPABASE_URL
  ?? (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : '')
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? ''

const missing: string[] = []
if (!url) missing.push('SUPABASE_URL (или SUPABASE_PROJECT_REF)')
if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY (или SUPABASE_SECRET_KEY)')
if (missing.length) {
  // Без базы звонок некуда записать. Поднимать воркер в таком виде значит проговорить с человеком три
  // минуты и потерять весь разговор — вместе с потраченными на него деньгами за телефонию и модель.
  console.error(`[voice] не заданы переменные: ${missing.join(', ')}`)
  process.exit(1)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const providers = resolveVoiceProviders()

/**
 * Карточка менеджеру после звонка.
 *
 * Тот же TelegramNotificationService, что и у SDR-прогона, — и это важно: у менеджера один поток
 * карточек, а не два разных формата из двух подсистем. Загрузка ленивая: grammY не нужен, пока не
 * закончился первый звонок.
 */
const sendCard: PersistDeps['sendCard'] | undefined = process.env.SDR_TELEGRAM_BOT_TOKEN
  && (process.env.VOICE_MANAGER_CHAT_ID ?? process.env.SDR_TELEGRAM_CHAT_ID)
  ? async (card) => {
    try {
      const { TelegramNotificationService } = await import('../telegram/bot-service.ts')
      const service = new TelegramNotificationService(process.env.SDR_TELEGRAM_BOT_TOKEN!)
      const chatId = process.env.VOICE_MANAGER_CHAT_ID ?? process.env.SDR_TELEGRAM_CHAT_ID!
      const result = await service.sendLeadCardToManager(chatId, card)
      return { ok: result.ok, error: result.ok ? undefined : result.error }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  : undefined

/**
 * Событие в CRM после звонка.
 *
 * Через тот же вебхук, что и горячие лиды SDR: приёмником может быть Make, n8n или собственный
 * эндпоинт. Отдельного клиента amoCRM/HubSpot здесь нет — их подписи и форматы не проверены, и
 * писать их наугад значит отправлять в чужую CRM то, что она молча отвергнет.
 */
const pushToCrm: PersistDeps['pushToCrm'] | undefined = process.env.CRM_WEBHOOK_URL
  ? async (call, analytics) => {
    try {
      const response = await fetch(process.env.CRM_WEBHOOK_URL!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.CRM_BEARER_TOKEN ? { Authorization: `Bearer ${process.env.CRM_BEARER_TOKEN}` } : {}),
          // Ключ идемпотентности: вебхук повторяется при сетевом сбое, и без него по одному звонку
          // создастся две сделки.
          'Idempotency-Key': `call:${call.callId}`,
        },
        body: JSON.stringify({ source: 'nemo-voice', call, analytics }),
        signal: AbortSignal.timeout(5_000),
      })
      return { ok: response.ok, error: response.ok ? undefined : `HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  : undefined

const worker = await startVoiceWorker({
  port: PORT,
  providers,
  persist: { admin: admin as unknown as PersistDeps['admin'], sendCard, pushToCrm },
})

console.log(`[voice] готов принимать звонки на порту ${worker.port}`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[voice] ${signal}: завершаю активные звонки (${worker.activeCalls()})`)
    // Активные звонки завершаются штатно: их разбор и запись в базу успевают пройти. Убить процесс
    // сразу значит потерять разговоры, которые шли в этот момент.
    worker.close().then(() => process.exit(0)).catch(() => process.exit(1))
  })
}
