/**
 * Routes genuinely small conversational turns around the expensive autonomous
 * goal loop. Anything that needs live data, files, an external action or a
 * substantial deliverable stays with the governed team runtime.
 */
export function isTeamQuickReplyIntent(task: string): boolean {
  const normalized = task.toLowerCase().trim()
  if (!normalized || normalized.length > 320) return false

  const needsRuntime = /(?:файл|вложен|таблиц|pdf|csv|xlsx|видео|аудио|магазин|продаж|остат|заказ|выруч|дашборд|dashboard|интернет|сайт|актуальн|сегодня|последн)|\b(?:file|attachment|spreadsheet|video|audio|store|sales|stock|orders?|revenue|web|website|current|latest|today)\b/i.test(normalized)
  const externalAction = /(?:создай|сделай|построй|подготовь|проанализ|найди|проверь|измени|редакт|загруз|отправ|опубли|удал|запусти|выполни)|\b(?:create|build|prepare|analy[sz]e|find|check|change|edit|upload|send|publish|delete|run|execute)\b/i.test(normalized)
  if (needsRuntime || externalAction) return false

  return /^(?:привет|здравствуй|добрый\s+(?:день|вечер)|спасибо|понял|ок(?:ей)?|кто|что|как|почему|зачем|где|когда|како[йея]|какие|сколько|объясни\s+кратко|можешь\s+ли|hello|hi|thanks|thank\s+you|who|what|how|why|where|when|which|can\s+you|salom|rahmat|kim|nima|qanday|nega|qayerda|qachon)/i.test(normalized)
}
