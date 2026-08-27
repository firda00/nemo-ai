import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ForgeTranscriptionResultSchema } from '../src/types/forge-transcription.ts'
import {
  assertPathInside,
  postProcessWhisperJson,
  sanitizedWhisperEnv,
  toMediaSpeechSegments,
  transcribeLocalClip,
  WhisperAdapterError,
  type LocalCommandRunner,
} from '../agent-hub/media/whisper-adapter.ts'

const CLIP_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b901'
const MODEL_BYTES = new TextEncoder().encode('test-whisper-model')
const MODEL_HASH = createHash('sha256').update(MODEL_BYTES).digest('hex')

const whisperJson = {
  result: { language: 'ru' },
  transcription: [{
    offsets: { from: 0, to: 2_300 },
    text: ' Добрый э день мир',
    tokens: [
      { text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.99 },
      { text: ' Добрый', offsets: { from: 100, to: 500 }, p: 0.98 },
      { text: ' э', offsets: { from: 520, to: 680 }, p: 0.87 },
      { text: ' день', offsets: { from: 700, to: 1_050 }, p: 0.96 },
      // 650 ms gap: above the VAD threshold and therefore a new segment.
      { text: ' мир', offsets: { from: 1_700, to: 2_100 }, p: 0.94 },
      { text: '.', offsets: { from: 2_100, to: 2_220 }, p: 0.91 },
      { text: '[_TT_111]', offsets: { from: 2_300, to: 2_300 }, p: 0.1 },
    ],
  }],
}

const processed = postProcessWhisperJson(whisperJson, {
  clipId: CLIP_ID,
  durationMs: 2_500,
  modelSha256: MODEL_HASH,
})
ForgeTranscriptionResultSchema.parse(processed)
assert.equal(processed.detectedLanguage, 'ru')
assert.equal(processed.removedFillers.length, 1)
assert.equal(processed.removedFillers[0].word, 'э')
assert.equal(processed.pauses.length, 1)
assert.deepEqual(processed.pauses[0], { startMs: 1_050, endMs: 1_700, durationMs: 650 })
assert.equal(processed.segments.length, 3, 'a filler and a long pause must split editable speech ranges')
assert.equal(processed.segments.at(-1)?.text, 'мир.')
assert.equal(toMediaSpeechSegments(processed).at(-1)?.words.at(-1)?.text, '.')

const naturalPause = structuredClone(whisperJson)
naturalPause.transcription[0].tokens[4].offsets.from = 1_350
const natural = postProcessWhisperJson(naturalPause, {
  clipId: CLIP_ID,
  durationMs: 2_500,
  modelSha256: MODEL_HASH,
})
assert.equal(natural.pauses.length, 0, 'a 300 ms pause must remain natural speech')

const env = sanitizedWhisperEnv({
  PATH: 'safe-path', TMPDIR: 'safe-tmp',
  SUPABASE_SERVICE_ROLE_KEY: 'must-not-leak', OPENAI_API_KEY: 'must-not-leak',
})
assert.deepEqual(env, { PATH: 'safe-path', TMPDIR: 'safe-tmp', LC_ALL: 'C' })

const root = await mkdtemp(path.join(tmpdir(), 'nemo-whisper-test-'))
const foreignRoot = await mkdtemp(path.join(tmpdir(), 'nemo-whisper-foreign-'))
try {
  const inputPath = path.join(root, 'clip.mp4')
  const ffmpegPath = path.join(root, 'ffmpeg-test.bin')
  const whisperPath = path.join(root, 'whisper-test.bin')
  const modelPath = path.join(root, 'ggml-test.bin')
  const foreignInput = path.join(foreignRoot, 'foreign.mp4')
  await Promise.all([
    writeFile(inputPath, new Uint8Array(128)),
    writeFile(ffmpegPath, new Uint8Array([1])),
    writeFile(whisperPath, new Uint8Array([1])),
    writeFile(modelPath, MODEL_BYTES),
    writeFile(foreignInput, new Uint8Array(128)),
  ])

  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
  const runner: LocalCommandRunner = async (command, args, options) => {
    calls.push({ command, args, env: options.env })
    if (command === ffmpegPath) {
      await writeFile(String(args.at(-1)), new Uint8Array(128))
    } else {
      const outputPrefix = String(args[args.indexOf('-of') + 1])
      await writeFile(`${outputPrefix}.json`, JSON.stringify(whisperJson))
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }

  const result = await transcribeLocalClip({
    clipId: CLIP_ID,
    inputPath,
    workDirectory: root,
    ffmpegPath,
    whisperPath,
    modelPath,
    expectedModelSha256: MODEL_HASH,
    durationMs: 2_500,
    runner,
  })
  assert.equal(result.words.length, 4)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args.slice(-8), ['-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', path.join(root, `${CLIP_ID}.pcm16.wav`)])
  assert.ok(calls[1].args.includes('-ojf'))
  assert.ok(calls[1].args.includes('-sow'))
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in calls[1].env, false)

  await assert.rejects(
    transcribeLocalClip({
      clipId: CLIP_ID,
      inputPath: foreignInput,
      workDirectory: root,
      ffmpegPath,
      whisperPath,
      modelPath,
      expectedModelSha256: MODEL_HASH,
      durationMs: 2_500,
      runner,
    }),
    (error: unknown) => error instanceof WhisperAdapterError && error.code === 'PATH_DENIED',
  )
  assert.throws(() => assertPathInside(root, path.join(root, '..', 'escape.wav')), /escapes/)

  await assert.rejects(
    transcribeLocalClip({
      clipId: CLIP_ID,
      inputPath,
      workDirectory: root,
      ffmpegPath,
      whisperPath,
      modelPath,
      expectedModelSha256: '0'.repeat(64),
      durationMs: 2_500,
      runner,
    }),
    (error: unknown) => error instanceof WhisperAdapterError && error.code === 'MODEL_INTEGRITY_FAILED',
  )
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(foreignRoot, { recursive: true, force: true })
}

console.log('Forge Whisper adapter passed: local PCM extraction, word timings, VAD, filler cuts, path isolation, model integrity, and env stripping.')

