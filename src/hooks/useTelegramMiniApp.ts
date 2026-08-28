import { useEffect, useState } from 'react'

type TelegramWebApp = {
  initData?: string
  ready(): void
  expand(): void
  enableClosingConfirmation?(): void
}

/**
 * Возвращает объект Mini App только когда страница действительно открыта внутри Telegram:
 * пустой initData у клиента вне Telegram, поэтому он и служит признаком.
 */
function readTelegramWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined
  const telegram = (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp
  return telegram?.initData ? telegram : undefined
}

export function useTelegramMiniApp(): boolean {
  // Признак читается лениво при первом рендере, а не через setState внутри эффекта: иначе
  // страница успевает отрисоваться в «обычном» виде и мигает на переключении.
  const [insideTelegram] = useState(() => Boolean(readTelegramWebApp()))
  useEffect(() => {
    const telegram = readTelegramWebApp()
    if (!telegram) return
    telegram.ready()
    telegram.expand()
    telegram.enableClosingConfirmation?.()
  }, [])
  return insideTelegram
}
