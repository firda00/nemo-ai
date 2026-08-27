import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  ForgeTranscriptionResultSchema,
  type DetectedPause,
  type ForgeTranscriptionResult,
  type RemovedFiller,
  type TranscriptionLanguage,
  type TranscriptionSegment,
  type WordLevelTiming,
} from '../../src/types/forge-transcription.ts'
import type { SpeechSegment } from '../../src/types/forge-media-intake.ts'
import { killTree } from './ffmpeg-engine.ts'

export const WHISPER_TIMEOUT_MS = 120_000
export const AUDIO_SAMPLE_RATE_HZ = 16_000
export const VAD_PAUSE_THRESHOLD_MS = 400
const MAX_CAPTURE_BYTES = 64 * 1024
const MAX_AUDIO_BYTES = 256 * 1024 * 1024

type CommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type LocalCommandRunner = (command: string, args: readonly string[], options: {
  cwd: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
}) => Promise<CommandResult>

export interface WhisperAdapterOptions {
  clipId: string
  inputPath: string
  workDirectory: string
  ffmpegPath: string
  whisperPath: string
  modelPath: string
  expectedModelSha256: string
  durationMs: number
  language?: 'auto' | 'uz' | 'ru' | 'en'
  pauseThresholdMs?: number
  removeFillers?: boolean
  timeoutMs?: number
  runner?: LocalCommandRunner
}

export class WhisperAdapterError extends Error {
  readonly code: 'PATH_DENIED' | 'MODEL_INTEGRITY_FAILED' | 'AUDIO_EXTRACTION_FAILED' | 'TRANSCRIPTION_FAILED' | 'TRANSCRIPTION_INVALID' | 'TIMEOUT'

  constructor(code: WhisperAdapterError['code'], message: string) {
    super(message)
    this.name = 'WhisperAdapterError'
    this.code = code
  }
}

export function sanitizedWhisperEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH || '/usr/bin:/bin',
    TMPDIR: source.TMPDIR || '/tmp',
    LC_ALL: 'C',
  }
}

export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WhisperAdapterError('PATH_DENIED', 'media path escapes the tenant work directory')
  }
  return resolved
}

async function assertExistingRegularFile(filePath: string, code: WhisperAdapterError['code']): Promise<string> {
  const originalStat = await lstat(filePath).catch(() => null)
  if (!originalStat?.isFile() || originalStat.isSymbolicLink()) throw new WhisperAdapterError(code, 'required local path is not a regular file')
  const resolved = await realpath(filePath).catch(() => null)
  if (!resolved) throw new WhisperAdapterError(code, 'required local file is unavailable')
  const stat = await lstat(resolved)
  if (!stat.isFile()) throw new WhisperAdapterError(code, 'required local path is not a regular file')
  return resolved
}

async function assertTenantInput(root: string, candidate: string): Promise<string> {
  const originalStat = await lstat(candidate).catch(() => null)
  if (!originalStat?.isFile() || originalStat.isSymbolicLink()) throw new WhisperAdapterError('PATH_DENIED', 'input must be a regular non-symlink file')
  const rootReal = await realpath(root).catch(() => null)
  const candidateReal = await realpath(candidate).catch(() => null)
  if (!rootReal || !candidateReal) throw new WhisperAdapterError('PATH_DENIED', 'tenant work path is unavailable')
  assertPathInside(rootReal, candidateReal)
  const stat = await lstat(candidateReal)
  if (!stat.isFile()) throw new WhisperAdapterError('PATH_DENIED', 'input must be a regular non-symlink file')
  return candidateReal
}

function sanitizeProcessMessage(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s"']+/g, '[REDACTED_PATH]')
    .replace(/\/(?:home|Users|var|tmp)\/[^\s"']+/g, '[REDACTED_PATH]')
    .replace(/(token|secret|key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 2_000)
}

export const runLocalCommand: LocalCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  const controller = new AbortController()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: controller.signal,
  })
  child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString('utf8')).slice(-MAX_CAPTURE_BYTES) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_CAPTURE_BYTES) })
  child.on('error', (error) => {
    if (timedOut && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') return
    clearTimeout(timer)
    reject(error)
  })
  child.on('close', async (code) => {
    clearTimeout(timer)
    if (timedOut) await killTree(child.pid)
    resolve({ code: code ?? -1, stdout, stderr, timedOut })
  })
})

function language(value: unknown): TranscriptionLanguage {
  return value === 'uz' || value === 'ru' || value === 'en' ? value : 'und'
}

function isSpecialToken(text: string): boolean {
  const value = text.trim()
  return !value || /^\[_.*_\]$/.test(value) || /^<\|.*\|>$/.test(value)
}

const FILLERS: Record<'uz' | 'ru' | 'en', ReadonlySet<string>> = {
  uz: new Set(['ee', 'eee', 'mmm', 'hm', 'haligi']),
  ru: new Set(['э', 'ээ', 'эм', 'мм', 'м-м']),
  en: new Set(['uh', 'um', 'erm', 'hmm']),
}

function normalizedWord(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '')
}

function rawTokens(document: unknown): Array<{ text: string; from: number; to: number; confidence: number }> {
  if (!document || typeof document !== 'object') throw new WhisperAdapterError('TRANSCRIPTION_INVALID', 'whisper output is not an object')
  const transcription = (document as { transcription?: unknown }).transcription
  if (!Array.isArray(transcription)) throw new WhisperAdapterError('TRANSCRIPTION_INVALID', 'whisper transcription array is missing')
  const output: Array<{ text: string; from: number; to: number; confidence: number }> = []
  for (const segment of transcription) {
    if (!segment || typeof segment !== 'object' || !Array.isArray((segment as { tokens?: unknown }).tokens)) continue
    for (const token of (segment as { tokens: unknown[] }).tokens) {
      if (!token || typeof token !== 'object') continue
      const item = token as { text?: unknown; offsets?: { from?: unknown; to?: unknown }; p?: unknown }
      const text = typeof item.text === 'string' ? item.text : ''
      const from = Number(item.offsets?.from)
      const to = Number(item.offsets?.to)
      const confidence = Number(item.p)
      if (isSpecialToken(text) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
      output.push({ text: text.trim(), from: Math.round(from), to: Math.round(to), confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0 })
    }
  }
  return output.sort((left, right) => left.from - right.from || left.to - right.to)
}

function joinWords(words: readonly WordLevelTiming[]): string {
  return words.reduce((text, word) => {
    if (/^[\p{P}\p{S}]+$/u.test(word.word)) return `${text}${word.word}`
    return text ? `${text} ${word.word}` : word.word
  }, '')
}

export function postProcessWhisperJson(raw: unknown, options: {
  clipId: string
  durationMs: number
  modelSha256: string
  pauseThresholdMs?: number
  removeFillers?: boolean
}): ForgeTranscriptionResult {
  const threshold = options.pauseThresholdMs ?? VAD_PAUSE_THRESHOLD_MS
  if (!Number.isInteger(threshold) || threshold < 100 || threshold > 5_000) {
    throw new WhisperAdapterError('TRANSCRIPTION_INVALID', 'pause threshold must be between 100 and 5000 ms')
  }
  const resultLanguage = language((raw as { result?: { language?: unknown } })?.result?.language)
  const fillerSet = resultLanguage === 'und' ? new Set<string>() : FILLERS[resultLanguage]
  const tokens = rawTokens(raw)
  const pauses: DetectedPause[] = []
  for (let index = 1; index < tokens.length; index += 1) {
    const startMs = tokens[index - 1].to
    const endMs = tokens[index].from
    if (endMs - startMs > threshold) pauses.push({ startMs, endMs, durationMs: endMs - startMs })
  }

  const words: WordLevelTiming[] = []
  const removedFillers: RemovedFiller[] = []
  const segments: TranscriptionSegment[] = []
  let current: WordLevelTiming[] = []
  let previousEnd: number | null = null
  const flush = () => {
    if (!current.length) return
    segments.push({ startMs: current[0].startMs, endMs: current.at(-1)!.endMs, text: joinWords(current), words: current })
    current = []
  }
  for (const token of tokens) {
    const word: WordLevelTiming = { word: token.text, startMs: token.from, endMs: token.to, confidence: token.confidence }
    const isFiller = options.removeFillers !== false && fillerSet.has(normalizedWord(token.text))
    if (isFiller) {
      flush()
      removedFillers.push({ word: token.text, startMs: token.from, endMs: token.to })
      previousEnd = token.to
      continue
    }
    if (previousEnd !== null && token.from - previousEnd > threshold) flush()
    words.push(word)
    current.push(word)
    previousEnd = token.to
  }
  flush()

  const result = {
    clipId: options.clipId,
    detectedLanguage: resultLanguage,
    languageConfidence: null,
    durationMs: options.durationMs,
    words,
    segments,
    pauses,
    removedFillers,
    engine: {
      name: 'whisper.cpp' as const,
      modelSha256: options.modelSha256,
      outputFormat: 'json-full' as const,
      sampleRateHz: AUDIO_SAMPLE_RATE_HZ as 16_000,
      channels: 1 as const,
    },
  }
  const parsed = ForgeTranscriptionResultSchema.safeParse(result)
  if (!parsed.success) {
    throw new WhisperAdapterError('TRANSCRIPTION_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  }
  return parsed.data
}

export function toMediaSpeechSegments(result: ForgeTranscriptionResult): SpeechSegment[] {
  return result.segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    words: segment.words.map((word) => ({
      text: word.word,
      startMs: word.startMs,
      endMs: word.endMs,
      confidence: word.confidence,
    })),
  }))
}

export async function transcribeLocalClip(options: WhisperAdapterOptions): Promise<ForgeTranscriptionResult> {
  const workDirectory = await realpath(options.workDirectory).catch(() => null)
  if (!workDirectory) throw new WhisperAdapterError('PATH_DENIED', 'tenant work directory is unavailable')
  const inputPath = await assertTenantInput(workDirectory, options.inputPath)
  const ffmpegPath = await assertExistingRegularFile(options.ffmpegPath, 'AUDIO_EXTRACTION_FAILED')
  const whisperPath = await assertExistingRegularFile(options.whisperPath, 'TRANSCRIPTION_FAILED')
  const modelPath = await assertExistingRegularFile(options.modelPath, 'MODEL_INTEGRITY_FAILED')
  const expectedHash = options.expectedModelSha256.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new WhisperAdapterError('MODEL_INTEGRITY_FAILED', 'expected model hash is invalid')
  const modelBytes = await readFile(modelPath)
  if (createHash('sha256').update(modelBytes).digest('hex') !== expectedHash) {
    throw new WhisperAdapterError('MODEL_INTEGRITY_FAILED', 'local whisper model hash does not match the configured digest')
  }

  const wavPath = assertPathInside(workDirectory, path.join(workDirectory, `${options.clipId}.pcm16.wav`))
  const outputPrefix = assertPathInside(workDirectory, path.join(workDirectory, `${options.clipId}.whisper`))
  const outputJson = `${outputPrefix}.json`
  const runner = options.runner ?? runLocalCommand
  const timeoutMs = options.timeoutMs ?? WHISPER_TIMEOUT_MS
  const processOptions = { cwd: workDirectory, timeoutMs, env: sanitizedWhisperEnv() }
  const extracted = await runner(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-i', inputPath,
    '-vn', '-acodec', 'pcm_s16le', '-ar', String(AUDIO_SAMPLE_RATE_HZ), '-ac', '1', wavPath,
  ], processOptions)
  if (extracted.timedOut) throw new WhisperAdapterError('TIMEOUT', 'audio extraction timed out')
  if (extracted.code !== 0) throw new WhisperAdapterError('AUDIO_EXTRACTION_FAILED', sanitizeProcessMessage(extracted.stderr))
  const wavStat = await lstat(wavPath).catch(() => null)
  if (!wavStat?.isFile() || wavStat.isSymbolicLink() || wavStat.size <= 44 || wavStat.size > MAX_AUDIO_BYTES) {
    throw new WhisperAdapterError('AUDIO_EXTRACTION_FAILED', 'extracted PCM audio is missing or exceeds its limit')
  }

  const transcribed = await runner(whisperPath, [
    '-m', modelPath, '-f', wavPath, '-ojf', '-of', outputPrefix,
    '-l', options.language ?? 'auto', '-sow', '-ml', '1', '-wt', '0.01', '-np',
  ], processOptions)
  if (transcribed.timedOut) throw new WhisperAdapterError('TIMEOUT', 'local transcription timed out')
  if (transcribed.code !== 0) throw new WhisperAdapterError('TRANSCRIPTION_FAILED', sanitizeProcessMessage(transcribed.stderr))
  const jsonPath = assertPathInside(workDirectory, outputJson)
  const jsonStat = await lstat(jsonPath).catch(() => null)
  if (!jsonStat?.isFile() || jsonStat.isSymbolicLink() || jsonStat.size > 64 * 1024 * 1024) {
    throw new WhisperAdapterError('TRANSCRIPTION_INVALID', 'whisper JSON output is missing or exceeds its limit')
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(jsonPath, 'utf8'))
  } catch {
    throw new WhisperAdapterError('TRANSCRIPTION_INVALID', 'whisper JSON output cannot be parsed')
  }
  return postProcessWhisperJson(raw, {
    clipId: options.clipId,
    durationMs: options.durationMs,
    modelSha256: expectedHash,
    pauseThresholdMs: options.pauseThresholdMs,
    removeFillers: options.removeFillers,
  })
}
