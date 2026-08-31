export type SmartArtifactKind = 'marketing' | 'finance' | 'research'

const INTENT_PATTERNS: Array<[SmartArtifactKind, RegExp]> = [
  ['finance', /выписк|приток|отток|расход|доход|cash\s?flow|transaction|finance|бухгалтер|баланс|pul oqimi|xarajat|kirim|chiqim/i],
  ['research', /созвон|видео|аудио|youtube|таймкод|выжимк|транскрип|meeting|research|notebook|podcast|audio|video|uchrashuv|tadqiqot/i],
  ['marketing', /reels|shorts|карусел|сценари|обложк|контент|маркетинг|campaign|storyboard|hook|post|marketing|reklama|kontent/i],
]

export function classifyTaskArtifact(prompt: string): SmartArtifactKind | null {
  return INTENT_PATTERNS.find(([, pattern]) => pattern.test(prompt))?.[0] ?? null
}
