export interface ExecutionPlan {
  version: 1
  path: 'quick' | 'team'
  reason: string
  maxLogicalLlmCalls: number
  maxSpecialists: number
  maxReviewRounds: number
}

interface ArtifactInput { content?: string }

const EXACT_OUTPUT_RE = /^(?:return exactly .{1,240} and no other text|верни ровно .{1,240} и больше ничего)\.?$/i
const ATTACHED_TRANSFORM_RE = /^(?:(?:please\s+)?(?:summarize|rewrite|proofread|reformat|convert) the attached (?:file|document|data|text)|(?:please\s+)?translate the attached (?:file|document|text) into (?:english|russian|uzbek)|(?:пожалуйста[,\s]+)?(?:суммаризируй|перепиши|проверь|переформатируй) приложенн(?:ый файл|ый документ|ые данные|ый текст)|(?:пожалуйста[,\s]+)?переведи приложенн(?:ый файл|ый документ|ый текст) на (?:русский|английский|узбекский)|(?:iltimos[,\s]+)?(?:qisqa xulosa qil|formatla) (?:biriktirilgan|ilova qilingan) (?:fayl|hujjat)|(?:iltimos[,\s]+)?(?:biriktirilgan|ilova qilingan) (?:fayl|hujjat)ni (?:ingliz|rus|o'zbek) tiliga tarjima qil)\.?$/i

function hasBoundedQuickShape(goal: string, hasArtifacts: boolean): boolean {
  if (EXACT_OUTPUT_RE.test(goal)) return true
  if (hasArtifacts && ATTACHED_TRANSFORM_RE.test(goal)) return true
  return false
}
const CURRENT_OR_WEB_RE = /\b(research|web|internet|search online|current|latest|today|news|competitors?|market research)\b|(?:исслед|найди в интернете|поищи|актуальн|последн(?:ие|яя)|сегодня|новост|конкурент|рынок)|(?:internetdan|hozirgi|so'nggi|bozor|raqobatch)/i
const MUTATION_RE = /\b(send|publish|post|contact|email|message|call|book|schedule|pay|refund|order|purchase|delete|update|edit|upload|create (?:a )?(?:ticket|issue|lead)|write to crm)\b|(?:отправ|опубли|свяж|напиш[иь].{0,20}клиент|позвон|заброни|назнач|оплат|верни деньги|закаж|закуп|удал|обнов|измени|загрузи|создай.{0,20}(?:задач|лид)|запиши.{0,20}crm)/i
const CONSEQUENTIAL_RE = /\b(strategy|recommend|decision|forecast|legal|medical|diagnos|insurance|hiring|fire|accounting|tax|financial advice|investment|pricing|budget|roadmap|campaign|purchase order|inventory|marketplace|uzum|code|implement|debug|architecture)\b|(?:стратег|рекоменд|решени|прогноз|юрид|медицин|диагноз|страхов|найм|уволь|бухгалтер|налог|финансов|инвестиц|ценообраз|бюджет|роадмап|кампани|закуп|остатк|маркетплейс|uzum|код|реализ|исправь баг|архитект)|(?:strateg|tavsiya|qaror|yuridik|tibbiy|soliq|moliya|investits|byudjet|xarid|ombor|dastur|kod)/i
const HIGH_IMPACT_RE = /\b(approve|reject|eligible|eligibility|rank|prioriti[sz]e|risk score|dosage|dose|pills?|medication|symptoms?|invoice|payment|charge|refund|contract|compliance|credit|loan|fraud|candidate|employee)\b|(?:одобр|отклон|допусти|ранжир|приорит|оцен[ик].{0,15}риск|дозиров|доз[ау]|таблет|лекар|симптом|сч[её]т|инвойс|плат[её]ж|списани|возврат|договор|комплаенс|кредит|за[её]м|мошенн|кандидат|сотрудник)|(?:tasdiq|rad et|ustuvor|xavf|doza|dori|alomat|hisob-faktura|to'lov|tolov|qaytar|shartnoma|kredit|firibgar|nomzod|xodim)/i
const SECOND_INTENT_RE = /\b(tell me (?:if|whether|which|who|what)|should (?:i|we)|can (?:i|we)|pick|choose|select|decide|which one|best one|safe to|allowed to)\b|(?:скажи.{0,20}(?:можно|стоит|какой|кто|что)|можно ли|стоит ли|следует ли|выбери|выбор|определи.{0,20}(?:кого|какой|можно)|лучший|подписать|принять)|(?:ayt.{0,20}(?:qaysi|mumkin)|tanla|eng yaxshi|kerakmi|mumkinmi)/i
const REGULATED_CONTEXT_RE = /\b(nda|agreement|bloodwork|blood test|lab results?|metformin|prescription|applications?|applicants?|resumes?|curriculum vitae)\b|(?:анализ[ыа].{0,15}кров|лаборатор|метформин|рецепт|заявк[аи]|резюме|соглашени|подпис[ьы])|(?:qon tahlil|laborator|retsept|ariza|rezyume|kelishuv)/i
const TRANSFER_RE = /(?:\b\d+(?:[.,]\d+)?\s*(?:usd|eur|uzs|sum|сум|руб|₽|\$|€).{0,40}(?:\bto\b|для|алине|кому|ga\b))|(?:переведи\s+\d)/i

export function chooseExecutionPlan(input: {
  goal: string
  orchestratedGoal?: string
  artifacts?: ArtifactInput[]
  hasPreset?: boolean
  hasDepartment?: boolean
}): ExecutionPlan {
  const team = (reason: string): ExecutionPlan => ({ version: 1, path: 'team', reason, maxLogicalLlmCalls: 32, maxSpecialists: 5, maxReviewRounds: 2 })
  if (input.hasPreset) return team('preset_team')
  if (input.hasDepartment) return team('saved_department')

  const goal = String(input.goal ?? '').trim()
  const fullGoal = String(input.orchestratedGoal ?? goal).trim()
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : []
  const artifactChars = artifacts.reduce((sum, item) => sum + String(item?.content ?? '').length, 0)
  if (goal.length > 1_200 || fullGoal.length > 4_000 || artifacts.length > 2 || artifactChars > 12_000) return team('input_too_large')
  const inspectedText = `${fullGoal}\n${artifacts.map((item) => String(item?.content ?? '')).join('\n')}`
  if (CURRENT_OR_WEB_RE.test(inspectedText) || MUTATION_RE.test(inspectedText) || CONSEQUENTIAL_RE.test(inspectedText) || HIGH_IMPACT_RE.test(inspectedText) || SECOND_INTENT_RE.test(inspectedText) || REGULATED_CONTEXT_RE.test(inspectedText) || TRANSFER_RE.test(inspectedText)) return team('complex_or_sensitive')
  if (!hasBoundedQuickShape(goal, artifacts.length > 0)) return team('no_bounded_transform_intent')
  return { version: 1, path: 'quick', reason: 'bounded_read_only_transform', maxLogicalLlmCalls: 1, maxSpecialists: 0, maxReviewRounds: 0 }
}
