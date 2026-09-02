export type SmartArtifactKind = 'browser' | 'marketing' | 'finance' | 'research' | 'code'

const INTENT_PATTERNS: Array<[SmartArtifactKind, RegExp]> = [
  ['browser', /(?:(?:uzum|seller\.uzum|кабинет(?:е|а)? продавца).*(?:открой|найди|редакт|измени|обнови|загрузи|добавь|цена|остат|карточк|модерац)|(?:открой|найди|редакт|измени|обнови|загрузи|добавь|отправь).*(?:uzum|seller\.uzum|кабинет продавца))/i],
  ['code', CODE_CREATION_PATTERN],
  ['finance', /выписк|приток|отток|расход|доход|cash\s?flow|transaction|finance|бухгалтер|баланс|pul oqimi|xarajat|kirim|chiqim/i],
  ['research', /созвон|видео|аудио|youtube|таймкод|выжимк|транскрип|meeting|research|notebook|podcast|audio|video|uchrashuv|tadqiqot/i],
  ['marketing', /reels|shorts|карусел|сценари|обложк|контент|маркетинг|campaign|storyboard|hook|post|marketing|reklama|kontent/i],
]

export function classifyTaskArtifact(prompt: string): SmartArtifactKind | null {
  return INTENT_PATTERNS.find(([, pattern]) => pattern.test(prompt))?.[0] ?? null
}

/** Явное поручение пользователя является разрешением именно на финальную отправку этого запуска. */
export function explicitlyRequestsBrowserSubmission(prompt: string): boolean {
  return /(?:отправ(?:ь|ить|ьте)?.{0,45}(?:модерац|публикац)|опубликуй|submit.{0,35}(?:moderation|listing)|moderatsiyaga.{0,35}yubor)/i.test(prompt)
}
import { CODE_CREATION_PATTERN } from './codeCreationIntent'
