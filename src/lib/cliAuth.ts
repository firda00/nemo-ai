export interface CliAuthRequest {
  callback: string
  state: string
}

/** Only a loopback callback created by Nemo CLI may receive the browser session. */
export function parseCliAuthRequest(search: string): CliAuthRequest | null {
  const params = new URLSearchParams(search)
  const rawCallback = params.get('callback') ?? ''
  const state = params.get('state') ?? ''
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return null

  try {
    const callback = new URL(rawCallback)
    const loopback = callback.hostname === '127.0.0.1' || callback.hostname === 'localhost' || callback.hostname === '[::1]'
    const port = Number(callback.port)
    if (
      callback.protocol !== 'http:' || !loopback || !Number.isInteger(port) || port < 1024 || port > 65_535
      || callback.pathname !== '/callback' || callback.username || callback.password || callback.search || callback.hash
    ) return null
    return { callback: callback.toString(), state }
  } catch {
    return null
  }
}
