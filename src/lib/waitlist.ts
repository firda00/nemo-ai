import { supabase, isSupabaseEnabled } from './supabase'

export interface WaitlistPayload {
  name?: string
  email: string
  phone?: string
  company?: string
  leads?: string
  note?: string
  source: 'waitlist' | 'auth' | 'pricing'
  /** Honeypot — люди его не видят и не заполняют; заполненное поле = бот. */
  website?: string
}

/** true — заявка принята (или демо-режим без бэкенда); false — не дошла, предложите повторить. */
export async function submitWaitlist(payload: WaitlistPayload): Promise<boolean> {
  if (!isSupabaseEnabled || !supabase) return true // демо: сохранять некуда, экран говорит об этом сам
  try {
    const { data, error } = await supabase.functions.invoke('waitlist', { body: payload })
    if (error) return false
    return Boolean((data as { ok?: boolean } | null)?.ok)
  } catch {
    return false
  }
}
