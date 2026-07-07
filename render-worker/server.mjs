// Nemo Content Factory — video render worker.
// Runs on the VPS behind nginx (/render-api/ -> 127.0.0.1:PORT), isolated via systemd.
// Renders a vertical short from {scenes, title, images, audio} with Remotion, uploads the
// MP4 to Supabase Storage, and returns a public URL. Single-slot queue + hard caps keep the
// shared box safe. Auth: every request must carry the RENDER_SECRET header.
import express from 'express'
import { bundle } from '@remotion/bundler'
import { selectComposition, renderMedia, ensureBrowser } from '@remotion/renderer'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

// Deno binary for the code sandbox (installed to /usr/local/bin on the VPS).
const DENO_BIN = process.env.DENO_BIN || '/usr/local/bin/deno'

const PORT = Number(process.env.PORT || 4020)
const HOST = process.env.HOST || '127.0.0.1'
const SECRET = process.env.RENDER_SECRET || ''
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const BUCKET = process.env.MEDIA_BUCKET || 'media'
const MAX_SCENES = 8

if (!SECRET || !SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing env: RENDER_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(__dirname, 'src', 'index.ts')

// ---- bundle once, reuse for every render ----
let serveUrlPromise = null
const getServeUrl = () => {
  if (!serveUrlPromise) {
    serveUrlPromise = bundle({ entryPoint: ENTRY, onProgress: () => {} }).catch((e) => {
      serveUrlPromise = null
      throw e
    })
  }
  return serveUrlPromise
}

// ---- input hardening: never trust the caller's props ----
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max)
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : '#8B7CF8')

const sanitizeProps = (p = {}) => {
  const scenesIn = Array.isArray(p.scenes) ? p.scenes.slice(0, MAX_SCENES) : []
  const scenes = scenesIn.map((s) => ({
    imageUrl: isHttp(s?.imageUrl) ? s.imageUrl : undefined,
    caption: str(s?.caption, 140),
    durationSec: clampNum(s?.durationSec, 1.5, 6, 3),
  }))
  if (!scenes.length) scenes.push({ caption: str(p.title, 140) || 'Nemo', durationSec: 3 })
  return {
    title: str(p.title, 90) || undefined,
    brand: str(p.brand, 40) || undefined,
    accent: hex(p.accent),
    audioUrl: isHttp(p.audioUrl) ? p.audioUrl : undefined,
    scenes,
  }
}

// ---- single-slot job queue ----
const jobs = new Map() // id -> { status, url, error, at }
const queue = []
let busy = false

const pruneJobs = () => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [id, j] of jobs) if (j.at < cutoff) jobs.delete(id)
}

async function processNext() {
  if (busy) return
  const id = queue.shift()
  if (!id) return
  busy = true
  const job = jobs.get(id)
  const outFile = path.join(os.tmpdir(), `${id}.mp4`)
  try {
    job.status = 'rendering'
    const serveUrl = await getServeUrl()
    const composition = await selectComposition({ serveUrl, id: 'Reel', inputProps: job.props })
    await renderMedia({
      serveUrl,
      composition,
      codec: 'h264',
      outputLocation: outFile,
      inputProps: job.props,
      concurrency: 1,
      offthreadVideoCacheSizeInBytes: 64 * 1024 * 1024,
      timeoutInMilliseconds: 120000,
      logLevel: 'error',
    })
    const buf = await readFile(outFile)
    const key = `videos/${job.accountId}/${id}.mp4`
    const up = await supabase.storage.from(BUCKET).upload(key, buf, { contentType: 'video/mp4', upsert: true })
    if (up.error) throw new Error(`upload: ${up.error.message}`)
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(key)
    job.url = data.publicUrl
    job.status = 'done'
    job.bytes = buf.length
  } catch (e) {
    job.status = 'error'
    job.error = String(e?.message || e).slice(0, 400)
    console.error(`[render ${id}] failed:`, job.error)
  } finally {
    await unlink(outFile).catch(() => {})
    busy = false
    pruneJobs()
    setImmediate(processNext)
  }
}

// ---- code sandbox: run untrusted JS/TS with Deno's deny-all model ----
// The script (from stdin) gets NO permissions: no net, no file read/write, no env, no
// subprocess (`--no-prompt` auto-denies instead of hanging). Only compute + console.log.
// Wall-clock timeout + output cap + a memory-limited V8 keep the shared box safe.
function runSandbox(code, timeoutMs) {
  return new Promise((resolve) => {
    const maxOut = 20000
    let out = '', err = '', done = false
    let child
    try {
      child = spawn(DENO_BIN, ['run', '--no-prompt', '--quiet', '--v8-flags=--max-old-space-size=128', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.tmpdir(), DENO_DIR: path.join(os.tmpdir(), 'deno_cache'), NO_COLOR: '1' },
      })
    } catch (e) {
      return resolve({ ok: false, error: 'sandbox unavailable: ' + String(e?.message || e), output: '' })
    }
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); try { child.kill('SIGKILL') } catch { /* already gone */ } resolve(r) } }
    const timer = setTimeout(() => finish({ ok: false, error: `timeout (${Math.round(timeoutMs / 1000)}s)`, output: out.slice(0, maxOut) }), timeoutMs)
    child.stdout.on('data', (d) => { if (out.length < maxOut) out += d.toString() })
    child.stderr.on('data', (d) => { if (err.length < maxOut) err += d.toString() })
    child.on('error', (e) => finish({ ok: false, error: 'spawn: ' + String(e?.message || e), output: '' }))
    child.on('close', (codeExit) => finish({ ok: codeExit === 0, output: out.slice(0, maxOut), error: codeExit === 0 ? '' : (err.slice(0, 2000) || `exit ${codeExit}`) }))
    try { child.stdin.write(String(code)); child.stdin.end() } catch { /* stdin closed */ }
  })
}

// ---- http ----
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  if (req.path === '/health') return next()
  if ((req.header('x-render-secret') || '') !== SECRET) return res.status(401).json({ error: 'unauthorized' })
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true, busy, queued: queue.length }))

app.post('/render', (req, res) => {
  const accountId = str(req.body?.accountId, 64) || 'anon'
  const props = sanitizeProps(req.body?.props)
  if (queue.length > 20) return res.status(429).json({ error: 'queue full' })
  const id = randomUUID()
  jobs.set(id, { status: 'queued', url: null, error: null, at: Date.now(), accountId, props })
  queue.push(id)
  setImmediate(processNext)
  res.status(202).json({ jobId: id, status: 'queued' })
})

app.get('/render/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'not found' })
  res.json({ status: job.status, url: job.url, error: job.error, bytes: job.bytes })
})

// Synchronous code sandbox (JS/TS via Deno, no I/O). Used by the run_code agent tool.
app.post('/run-code', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.slice(0, 20000) : ''
  if (!code.trim()) return res.status(400).json({ ok: false, error: 'no code' })
  const timeoutMs = clampNum(req.body?.timeoutMs, 1000, 15000, 8000)
  const r = await runSandbox(code, timeoutMs)
  res.json(r)
})

async function main() {
  await ensureBrowser()
  // warm the bundle so the first real render is fast
  getServeUrl().catch((e) => console.error('bundle warm failed:', e?.message || e))
  app.listen(PORT, HOST, () => console.log(`nemo-render-worker listening on ${HOST}:${PORT}`))
}
main()
