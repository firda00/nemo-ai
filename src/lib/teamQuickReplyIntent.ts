/**
 * Routes genuinely small conversational turns around the expensive autonomous
 * goal loop. Anything that needs live data, files, an external action or a
 * substantial deliverable stays with the governed team runtime.
 */
export function isTeamQuickReplyIntent(task: string): boolean {
  const normalized = task.toLowerCase().trim()
  if (!normalized || normalized.length > 320) return false

  const needsRuntime = /(?:файл|вложен|таблиц|pdf|csv|xlsx|видео|аудио|магазин|продаж|остат|заказ|выруч|дашборд|dashboard|интернет|сайт|актуальн|сегодня|последн)|\b(?:file|attachment|spreadsheet|video|audio|store|sales|stock|orders?|revenue|web|website|current|latest|today)\b/i.test(normalized)
  const substantialWork = /(?:стратег|полный\s+отч[её]т|подробн|исслед|аудит|план\s+на|проанализ|разработ|реализ|создай\s+(?:кампани|приложен|сайт|систем)|подготовь\s+(?:стратег|отч[её]т|план))|\b(?:strategy|detailed|research|audit|analy[sz]e|implement|develop|build\s+(?:an?\s+)?(?:app|website|system)|prepare\s+(?:a\s+)?(?:strategy|report|plan))\b/i.test(normalized)
  const externalAction = /(?:загруз|отправ|опубли|удал|запусти|позвон|оплат|закаж|измени.{0,24}(?:аккаунт|цена|остат|настройк))|\b(?:upload|send|publish|delete|run|call|pay|purchase|change.{0,24}(?:account|price|stock|settings))\b/i.test(normalized)
  if (needsRuntime || substantialWork || externalAction) return false

  return /^(?:а\s+|и\s+|но\s+)?(?:привет|здравствуй|добрый\s+(?:день|вечер)|спасибо|понял|ок(?:ей)?|кто|что|как|почему|зачем|где|когда|како[йея]|какие|сколько|объясни|сократи|перефразируй|переведи|исправь\s+текст|дай\s+(?:до\s+)?\d+\s+(?:иде|вариант)|придумай\s+(?:коротк|\d+)|сделай\s+(?:короче|понятнее|заголовок)|можешь\s+ли|hello|hi|thanks|thank\s+you|who|what|how|why|where|when|which|explain|shorten|rewrite|translate|give\s+(?:up\s+to\s+)?\d+|can\s+you|salom|rahmat|kim|nima|qanday|nega|qayerda|qachon)/i.test(normalized)
}
