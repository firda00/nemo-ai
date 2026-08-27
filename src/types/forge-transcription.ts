import { z } from 'zod'

export const TranscriptionLanguageSchema = z.enum(['uz', 'ru', 'en', 'und'])

export const WordLevelTimingSchema = z.object({
  word: z.string().trim().min(1).max(120),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  confidence: z.number().min(0).max(1),
}).strict().refine((word) => word.endMs > word.startMs, {
  message: 'word end must follow word start',
  path: ['endMs'],
})

export const DetectedPauseSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  durationMs: z.number().int().positive(),
}).strict().superRefine((pause, context) => {
  if (pause.endMs <= pause.startMs || pause.durationMs !== pause.endMs - pause.startMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'pause duration must match its bounds' })
  }
})

export const RemovedFillerSchema = z.object({
  word: z.string().min(1).max(120),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
}).strict().refine((item) => item.endMs > item.startMs, 'filler end must follow start')

export const TranscriptionSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1).max(2_000),
  words: z.array(WordLevelTimingSchema).min(1).max(300),
}).strict().superRefine((segment, context) => {
  if (segment.endMs <= segment.startMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'segment end must follow start', path: ['endMs'] })
  }
  let previousEnd = segment.startMs
  for (const [index, word] of segment.words.entries()) {
    if (word.startMs < segment.startMs || word.endMs > segment.endMs || word.startMs < previousEnd) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'words must be ordered inside the segment', path: ['words', index] })
    }
    previousEnd = word.endMs
  }
})

export const ForgeTranscriptionResultSchema = z.object({
  clipId: z.string().uuid(),
  detectedLanguage: TranscriptionLanguageSchema,
  languageConfidence: z.number().min(0).max(1).nullable(),
  durationMs: z.number().int().positive(),
  words: z.array(WordLevelTimingSchema).max(20_000),
  segments: z.array(TranscriptionSegmentSchema).max(4_000),
  pauses: z.array(DetectedPauseSchema).max(20_000),
  removedFillers: z.array(RemovedFillerSchema).max(4_000),
  engine: z.object({
    name: z.literal('whisper.cpp'),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
    outputFormat: z.literal('json-full'),
    sampleRateHz: z.literal(16_000),
    channels: z.literal(1),
  }).strict(),
}).strict().superRefine((result, context) => {
  for (const [index, word] of result.words.entries()) {
    if (word.endMs > result.durationMs) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'word exceeds media duration', path: ['words', index] })
    }
  }
})

export type TranscriptionLanguage = z.infer<typeof TranscriptionLanguageSchema>
export type WordLevelTiming = z.infer<typeof WordLevelTimingSchema>
export type DetectedPause = z.infer<typeof DetectedPauseSchema>
export type RemovedFiller = z.infer<typeof RemovedFillerSchema>
export type TranscriptionSegment = z.infer<typeof TranscriptionSegmentSchema>
export type ForgeTranscriptionResult = z.infer<typeof ForgeTranscriptionResultSchema>

