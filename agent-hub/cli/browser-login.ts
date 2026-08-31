/*
 * Browser OAuth for the installed CLI.
 *
 * Tokens never travel in a URL. The web page POSTs them to a short-lived server bound only to
 * 127.0.0.1. A random state ties that POST to this exact CLI process, and the access token is
 * verified with Supabase before anything is persisted.
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { APP_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from './defaults.ts'
import type { Session } from './auth.ts'

const CALLBACK_PATH = '/callback'
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

interface BrowserPayload {
  state?: unknown
  access_token?: unknown
  refresh_token?: unknown
  expires_at?: unknown
  email?: unknown
  name?: unknown
}

interface SupabaseUser {
  email?: string
  user_metadata?: { name?: string; full_name?: string }
}

export interface BrowserSession extends Session {
  name?: string
}

export interface BrowserLoginDeps {
  appUrl?: string
  timeoutMs?: number
  say?: (line: string) => void
  openUrl?: (url: string) => void | Promise<void>
  validate?: (payload: BrowserPayload) => Promise<BrowserSession>
  state?: string
}

export type BrowserLoginResult =
  | { ok: true; session: BrowserSession }
  | { ok: false; error: string }

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>, origin: string): void {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<BrowserPayload> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('payload_too_large')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrowserPayload
  } catch {
    throw new Error('invalid_json')
  }
}

function requiredString(value: unknown, field: string, max = 16_384): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`invalid_${field}`)
  return value
}

/** Verify the browser session with Supabase and derive identity from the verified user response. */
export async function validateBrowserSession(payload: BrowserPayload): Promise<BrowserSession> {
  const accessToken = requiredString(payload.access_token, 'access_token')
  const refreshToken = requiredString(payload.refresh_token, 'refresh_token')
  let expiresAt = 0
  try {
    const encoded = accessToken.split('.')[1]
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as { exp?: unknown }
    expiresAt = Number(claims.exp)
  } catch {
    throw new Error('invalid_access_token')
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('invalid_expiry')
  }

  const response = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  })
  const user = (await response.json().catch(() => ({}))) as SupabaseUser
  if (!response.ok || !user.email) throw new Error('session_verification_failed')

  const claimedEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (claimedEmail && claimedEmail !== user.email.toLowerCase()) throw new Error('email_mismatch')
  const name = user.user_metadata?.name || user.user_metadata?.full_name
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    email: user.email,
    ...(name ? { name: String(name).slice(0, 120) } : {}),
  }
}

export function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Start one loopback listener, open the browser, and resolve after a verified callback.
 * The operating system selects a free port, avoiding collisions between simultaneous CLI sessions.
 */
export async function loginWithBrowser(deps: BrowserLoginDeps = {}): Promise<BrowserLoginResult> {
  const say = deps.say ?? (() => {})
  const state = deps.state ?? randomBytes(32).toString('base64url')
  const validate = deps.validate ?? validateBrowserSession
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let appOrigin: string
  try {
    appOrigin = new URL(deps.appUrl ?? APP_URL).origin
  } catch {
    return { ok: false, error: 'адрес веб-панели Nemo настроен неверно' }
  }

  return await new Promise<BrowserLoginResult>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (result: BrowserLoginResult) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      server.close(() => resolve(result))
    }

    const server = http.createServer(async (request, response) => {
      const origin = request.headers.origin ?? ''
      if (origin !== appOrigin) {
        json(response, 403, { ok: false, error: 'origin_denied' }, appOrigin)
        return
      }
      if (request.method === 'OPTIONS') {
        json(response, 204, {}, appOrigin)
        return
      }
      if (request.method !== 'POST' || request.url !== CALLBACK_PATH) {
        json(response, 404, { ok: false, error: 'not_found' }, appOrigin)
        return
      }
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
        json(response, 415, { ok: false, error: 'json_required' }, appOrigin)
        return
      }

      try {
        const payload = await readJson(request)
        if (typeof payload.state !== 'string' || !safeEqual(payload.state, state)) {
          json(response, 403, { ok: false, error: 'state_mismatch' }, appOrigin)
          return
        }
        const session = await validate(payload)
        json(response, 200, { ok: true }, appOrigin)
        finish({ ok: true, session })
      } catch (error) {
        const message = String((error as Error).message || 'callback_failed').slice(0, 120)
        json(response, 400, { ok: false, error: message }, appOrigin)
      }
    })

    server.on('error', (error) => finish({ ok: false, error: `локальный callback не запущен: ${error.message}` }))
    server.listen(0, '127.0.0.1', async () => {
      const port = (server.address() as AddressInfo).port
      const callback = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const authUrl = new URL('/cli/auth', appOrigin)
      authUrl.searchParams.set('callback', callback)
      authUrl.searchParams.set('state', state)
      say('Открываю безопасный вход Nemo в браузере…')
      try {
        await (deps.openUrl ?? openSystemBrowser)(authUrl.toString())
      } catch {
        say(`Браузер не открылся. Откройте ссылку вручную:\n${authUrl.toString()}`)
      }
    })

    timeout = setTimeout(() => finish({ ok: false, error: 'время авторизации истекло — запустите nemo login ещё раз' }), timeoutMs)
    timeout.unref?.()
  })
}
