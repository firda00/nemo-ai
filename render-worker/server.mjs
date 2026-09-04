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
import { createWriteStream } from 'node:fs'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
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
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe'
const MAX_EDIT_BYTES = 180 * 1024 * 1024
const MAX_EDIT_SECONDS = 120

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

// Resolution comes as a quality ENUM validated against the worker's own allowlist —
// never as caller-controlled dimensions. Must mirror QUALITY_CANVAS in src/Reel.tsx.
const QUALITIES = ['720p', '1080p', '4k']

const sanitizeProps = (p = {}, quality = '') => {
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
    quality: QUALITIES.includes(quality) ? quality : '1080p',
    scenes,
  }
}

// ---- single-slot job queue ----
const jobs = new Map() // id -> { status, url, error, at }
const queue = []
let busy = false

const runProcess = (bin, args, timeoutMs = 150000) => new Promise((resolve, reject) => {
  let stderr = ''
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.stderr.on('data', (chunk) => { if (stderr.length < 12000) stderr += chunk.toString() })
  child.on('error', (error) => { clearTimeout(timer); reject(error) })
  child.on('close', (code) => {
    clearTimeout(timer)
    if (code === 0) resolve(undefined)
    else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-1200)}`))
  })
})

const probeVideo = async (file) => {
  let stdout = ''
  await new Promise((resolve, reject) => {
    const child = spawn(FFPROBE_BIN, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file])
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffprobe exit ${code}`)))
  })
  const result = JSON.parse(stdout || '{}')
  const video = (result.streams || []).find((stream) => stream.codec_type === 'video')
  if (!video) throw new Error('source has no video stream')
  return {
    duration: clampNum(result.format?.duration, 0.3, MAX_EDIT_SECONDS, 0),
    width: Number(video.width) || 720,
    height: Number(video.height) || 1280,
    hasAudio: (result.streams || []).some((stream) => stream.codec_type === 'audio'),
  }
}

const assTime = (seconds) => {
  const centis = Math.max(0, Math.round(seconds * 100))
  const cs = centis % 100
  const totalSeconds = Math.floor(centis / 100)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}
const assEscape = (value) => str(value, 2000).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N')
const subtitleChunks = (transcript, duration) => {
  const sentences = str(transcript, 18000).split(/(?<=[.!?])\s+|\n+/u).map((item) => item.trim()).filter(Boolean)
  const chunks = []
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/)
    for (let i = 0; i < words.length; i += 8) chunks.push(words.slice(i, i + 8).join(' '))
  }
  const safe = chunks.slice(0, 160)
  const totalWeight = safe.reduce((sum, item) => sum + Math.max(2, item.split(/\s+/).length), 0) || 1
  let cursor = 0
  return safe.map((text) => {
    const span = duration * Math.max(2, text.split(/\s+/).length) / totalWeight
    const cue = { text, start: cursor, end: Math.min(duration, cursor + Math.max(0.7, span)) }
    cursor = cue.end
    return cue
  })
}
const buildEditAss = ({ transcript, title, duration, width, height, accent }) => {
  const fontSize = height > width ? 54 : 42
  const marginV = Math.round(height * 0.16)
  const events = subtitleChunks(transcript, duration).map((cue) =>
    `Dialogue: 1,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,{\\fad(90,90)\\fscx94\\fscy94\\t(0,120,\\fscx100\\fscy100)}${assEscape(cue.text)}`,
  )
  if (title) events.unshift(`Dialogue: 2,0:00:00.00,${assTime(Math.min(3.4, duration))},Title,,0,0,0,,{\\move(${Math.round(width * .08)},${Math.round(height * .20)},${Math.round(width * .08)},${Math.round(height * .16)},0,420)\\fad(180,350)}${assEscape(title)}`)
  const colour = /^#[0-9a-f]{6}$/i.test(accent || '') ? accent.slice(1) : '20D9E8'
  const bgr = `&H00${colour.slice(4, 6)}${colour.slice(2, 4)}${colour.slice(0, 2)}`
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Arial,${fontSize},&H00FFFFFF,${bgr},&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,4,1,2,55,55,${marginV},1\nStyle: Title,Arial,${Math.round(fontSize * 1.18)},&H00FFFFFF,${bgr},&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,2,0,7,50,50,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`
}

async function downloadEditSource(url, destination) {
  if (!isHttp(url) || !url.startsWith('https://')) throw new Error('invalid source URL')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })
  if (!response.ok || !response.body) throw new Error(`source download ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_EDIT_BYTES) throw new Error('source exceeds 180 MB')
  let received = 0
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length
    callback(received > MAX_EDIT_BYTES ? new Error('source exceeds 180 MB') : null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
}

async function renderEdit(job, outFile) {
  const inputFile = path.join(os.tmpdir(), `${job.id}-source.mp4`)
  const assFile = path.join(os.tmpdir(), `${job.id}.ass`)
  try {
    await downloadEditSource(job.sourceUrl, inputFile)
    const probe = await probeVideo(inputFile)
    const start = clampNum(job.options?.trimStart, 0, Math.max(0, probe.duration - 0.3), 0)
    const duration = clampNum(job.options?.maxDuration, 0.3, Math.min(MAX_EDIT_SECONDS, probe.duration - start), Math.min(MAX_EDIT_SECONDS, probe.duration - start))
    const ratio = ['9:16', '16:9', '1:1', 'original'].includes(job.options?.ratio) ? job.options.ratio : '9:16'
    const frame = ratio === '16:9' ? [1280, 720] : ratio === '1:1' ? [1080, 1080] : ratio === 'original'
      ? [Math.max(2, probe.width - probe.width % 2), Math.max(2, probe.height - probe.height % 2)] : [720, 1280]
    await writeFile(assFile, buildEditAss({ transcript: job.transcript, title: job.title, duration, width: frame[0], height: frame[1], accent: job.options?.accent }), 'utf8')
    const assPath = assFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    const fadeOut = Math.max(0, duration - 0.3).toFixed(3)
    const videoFilter = `scale=${frame[0]}:${frame[1]}:force_original_aspect_ratio=increase,crop=${frame[0]}:${frame[1]},fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.3,subtitles='${assPath}'`
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', inputFile, '-t', String(duration), '-vf', videoFilter]
    if (probe.hasAudio) args.push('-af', `loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.2,afade=t=out:st=${fadeOut}:d=0.3`)
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart')
    if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k')
    else args.push('-an')
    args.push(outFile)
    await runProcess(FFMPEG_BIN, args, 170000)
  } finally {
    await Promise.all([unlink(inputFile).catch(() => {}), unlink(assFile).catch(() => {})])
  }
}

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
    if (job.kind === 'edit') await renderEdit({ ...job, id }, outFile)
    else {
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
        timeoutInMilliseconds: job.props?.quality === '4k' ? 300000 : 120000,
        logLevel: 'error',
      })
    }
    const buf = await readFile(outFile)
    const key = `${job.kind === 'edit' ? 'edits' : 'videos'}/${job.accountId}/${id}.mp4`
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
  const props = sanitizeProps(req.body?.props, str(req.body?.quality, 8))
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

app.post('/edit', (req, res) => {
  const accountId = str(req.body?.accountId, 64)
  const sourceUrl = str(req.body?.sourceUrl, 2400)
  if (!accountId || !sourceUrl || !isHttp(sourceUrl)) return res.status(400).json({ error: 'invalid edit source' })
  if (queue.length > 20) return res.status(429).json({ error: 'queue full' })
  const id = randomUUID()
  jobs.set(id, {
    kind: 'edit', status: 'queued', url: null, error: null, at: Date.now(), accountId, sourceUrl,
    transcript: str(req.body?.transcript, 18000), title: str(req.body?.title, 90), options: req.body?.options || {},
  })
  queue.push(id)
  setImmediate(processNext)
  res.status(202).json({ jobId: id, status: 'queued' })
})

app.get('/edit/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job || job.kind !== 'edit') return res.status(404).json({ error: 'not found' })
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
