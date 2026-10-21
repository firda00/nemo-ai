export type SmartArtifactKind = 'browser' | 'marketing' | 'finance' | 'research' | 'video-edit' | 'code'

// A topic mention is not an instruction to launch that topic's workflow. Keep this
// bypass deliberately narrow: definitions and explanations, with no attached data,
// URL, requested action or account-specific/current information.
const EXPLANATION_OPENING = /^(?:(?:пожалуйста|please|iltimos)[,\s]+)?(?:что\s+(?:такое|значит|означает)|в\s+ч[её]м\s+(?:разница|отличие)|чем\s+отлич|как\s+(?:работает|устроен)|объясни(?:те)?\s+(?:мне\s+)?(?:что|как|разниц|значени|поняти|термин)|what\s+(?:is|are|does)|how\s+(?:does|do)|explain\s+(?:to\s+me\s+)?(?:what|how|(?:the\s+)?(?:difference|meaning|concept|term)))/iu
const UZ_EXPLANATION = /^.{1,100}\s+(?:nima(?:\s+degani)?|qanday\s+ishlaydi|nimani\s+anglatadi)\s*[?.!]*$/iu
const REQUESTED_ACTION = /(?:^|[^\p{L}\p{N}_])(?:создай|сделай|построй|собери|напиши|проанализируй|рассчитай|посчитай|найди|поищи|открой|перейди|скачай|загрузи|добавь|измени|обнови|удали|отправь|опубликуй|смонтируй|нарежь|сохрани|выполни|запусти|create|build|make|write|analy[sz]e|calculate|find|search|open|visit|browse|download|upload|add|edit|update|delete|send|publish|render|save|execute|run|book|schedule|yarat|tuz|yoz|hisobla|top|och|yukla|o['‘’ʻʼ]zgartir|yangila|o['‘’ʻʼ]chir|yubor|saqla|bajar)(?=$|[^\p{L}\p{N}_])|\bpost\s+(?:this|that|it|the|a|an|to|on)\b|\btahlil\s+qil\b/iu
const DATA_OR_CURRENT_REQUEST = /https?:\/\/|www\.|(?:^|[^\p{L}\p{N}_])(?:мой|мои|моих|мо[её]й|наши|наших|нашей|приложенн\p{L}*|прикрепл[её]нн\p{L}*|сегодня|сейчас|актуальн\p{L}*|последни\p{L}*|my|our|attached|uploaded|current|latest|today|now|mening|bizning|biriktirilgan|bugun|hozirgi)(?=$|[^\p{L}\p{N}_])/iu

function isPlainExplanation(prompt: string): boolean {
  const text = prompt.trim()
  return text.length <= 420
    && (EXPLANATION_OPENING.test(text) || UZ_EXPLANATION.test(text))
    && !REQUESTED_ACTION.test(text)
    && !DATA_OR_CURRENT_REQUEST.test(text)
}

const INTENT_PATTERNS: Array<[SmartArtifactKind, RegExp]> = [
  ['browser', /(?:https?:\/\/|(?:(?:uzum|seller\.uzum|кабинет(?:е|а)? продавца).*(?:открой|найди|редакт|измени|обнови|загрузи|добавь|цена|остат|карточк|модерац))|(?:(?:открой|перейди|зайди|найди|поищи|редакт|измени|обнови|загрузи|добавь|отправь).*(?:uzum|seller\.uzum|сайт|страниц|браузер|в интернете|google))|(?:open|visit|browse|search).*(?:website|page|browser|google)|(?:sayt|brauzer).*(?:och|top|o‘t))/i],
  ['code', CODE_CREATION_PATTERN],
  ['finance', /выписк|приток|отток|расход|доход|cash\s?flow|transaction|finance|бухгалтер|баланс|pul oqimi|xarajat|kirim|chiqim/i],
  ['video-edit', /монтаж|смонтир|субтитр|motion|моушн|нарежь|обработай видео|edit (?:the )?video/i],
  ['research', /созвон|видео|аудио|youtube|таймкод|выжимк|транскрип|meeting|research|notebook|podcast|audio|video|uchrashuv|tadqiqot/i],
  ['marketing', /reels|shorts|карусел|сценари|обложк|контент|маркетинг|campaign|storyboard|hook|post|marketing|reklama|kontent/i],
]

export function classifyTaskArtifact(prompt: string, context: { hasAttachments?: boolean } = {}): SmartArtifactKind | null {
  if (!context.hasAttachments && isPlainExplanation(prompt)) return null
  return INTENT_PATTERNS.find(([, pattern]) => pattern.test(prompt))?.[0] ?? null
}

/** Явное поручение пользователя является разрешением именно на финальную отправку этого запуска. */
export function explicitlyRequestsBrowserSubmission(prompt: string): boolean {
  return /(?:отправ(?:ь|ить|ьте)?.{0,45}(?:модерац|публикац)|опубликуй|submit.{0,35}(?:moderation|listing)|moderatsiyaga.{0,35}yubor)/i.test(prompt)
}
import { CODE_CREATION_PATTERN } from './codeCreationIntent'
