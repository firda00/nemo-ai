import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ExternalLink,
  Film,
  Landmark,
  MessageSquareText,
  NotebookTabs,
  Sparkles,
  Users,
  UserRound,
  Workflow,
  Loader2,
  Code2,
  Globe2,
  ShieldCheck,
  Paperclip,
  X,
  FileAudio,
  FileVideo,
  FileText,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'
import { classifyTaskArtifact, explicitlyRequestsBrowserSubmission, type SmartArtifactKind } from '../../lib/smartArtifactIntent'
import { MarketingCampaignStudio } from './MarketingCampaignStudio'
import { FinanceCashFlowDashboard } from '../finance/FinanceCashFlowDashboard'
import { MarginChatCard } from '../finance/MarginChatCard'
import { DocumentChatCard } from '../documents/DocumentChatCard'
import { classifyDocumentChatIntent, type DocumentChatIntent } from '../../lib/documentChatIntent'
import { hasDocumentRecoveryIssue, listRecentDocumentJobs } from '../../lib/documentJobs'
import { useAuth } from '../../context/AuthContext'
import { ResearchNotebookHub } from '../research/ResearchNotebookHub'
import { AutonomousRunner } from './AutonomousRunner'
import { classifyChatEntityIntent, createEntityFromChat, type ChatCreatedEntity } from '../../lib/chatEntityFactory'
import { useAgentStore } from '../../store/useAgentStore'
import { LiveCodeSandboxArtifact } from './LiveCodeSandboxArtifact'
import { runExtensionBrowserTask, type BrowserTaskResult } from '../../lib/extensionLink'
import { DIRECT_ANSWER_MODEL, fetchDirectAnswer } from '../../lib/directAnswer'
import { FRONTIER_MODELS, FRONTIER_EFFORTS, fetchFrontierAnswer, type FrontierEffort } from '../../lib/frontierChatClient'
import { invokeScopedFunction } from '../../lib/scopedFunctionCall'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'
import { Markdown } from '../ui/Markdown'
import { VideoMontageArtifact } from './VideoMontageArtifact'
import { TrialBookingChatCard } from './TrialBookingChatCard'
import { isLocalTrialUrl } from '../../lib/trialBookingClient'
import { hasTrialModelChat, trialModelChat, type TrialChatView } from '../../lib/trialModelChat'
import { trialModelCopy } from '../../i18n/trialModel'
import { trialStatusCopy } from '../../i18n/trialBooking'
import { isCapabilityQuestion, isExplicitCreation, isDiscoveryCancellation, startChatDiscovery, advanceChatDiscovery, nextDiscoveryStep, discoveryPrompt, type DiscoveryState } from '../../lib/chatDiscovery'
import { CHAT_HISTORY_LIMIT, readChatSession, writeChatSession, type SavedChatTurn } from '../../lib/chatSession'
import { chatExperienceCopy } from '../../i18n/chatExperience'
import { resolveChatScope } from '../../lib/chatScope'
import { AttachmentPreview } from '../chat/AttachmentPreview'

type ChatTurn = {
  id: number
  role: 'user' | 'assistant'
  text?: string
  copyKey?: string
  artifact?: SmartArtifactKind
  artifactPrompt?: string
  entity?: ChatCreatedEntity
  teamRunGoal?: string
  error?: boolean
  attachments?: File[]
  direct?: boolean
  model?: string
  marginFiles?: File[]
  trialBooking?: boolean
  trialBookingKey?: string
  trialOperationOnly?: boolean
  // submissionId — UUID момента отправки: идентичность ЭТОГО запроса (ретраи/таймауты держат
  // его), новая отправка даже с тем же текстом — новый id и новый документ
  documentJob?: DocumentChatIntent & { submissionId: string; files?: File[] }
}

const CHAT_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.csv,.tsv,.txt,.md,.json,.mp3,.m4a,.wav,.mp4'
const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024

const fileToDataUrl = (file: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result ?? ''))
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

const imageFileToDataUrl = async (file: File): Promise<string> => {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('image')), 'image/jpeg', 0.84))
  return fileToDataUrl(blob)
}
const CHAT_FILE_LIMIT = 4
const CHAT_FILE_MAX_BYTES = 180 * 1024 * 1024

function attachmentIcon(file: File) {
  if (file.type.startsWith('video/')) return FileVideo
  if (file.type.startsWith('audio/')) return FileAudio
  return FileText
}

function attachmentSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const DISCOVERY_COPY = {
  ru: {
    goal: 'Начнём с цели. Какой конкретный результат должен давать агент или команда?',
    channels: 'С какими каналами, файлами или сервисами нужно работать? Например: Telegram, Google Drive, CRM, CSV или сайт.',
    format: 'Какой формат вам нужен: один узкий агент или команда специалистов?',
    capabilities: `## Что умеет Nemo

Здесь можно обсудить задачу, подготовить материалы и настроить AI-команду под конкретную цель.

- **Вопросы и тексты:** объяснения, черновики и разбор изображений через подключённую модель.
- **Файлы и расчёты:** загрузите исходные данные — в чате откроется подходящий инструмент для анализа или подготовки документа. Поддержка зависит от формата файла и доступного сервиса.
- **AI-команда:** опишите результат и источники. Я помогу создать её конфигурацию; доступ к сервисам и готовность к работе проверяются отдельно.

Telegram, Google Drive и CRM требуют подключения и разрешений владельца. Наличие пункта в интерфейсе не означает, что сервис уже подключён. Выполненное действие подтверждается сохранённым результатом.

Можно начать так: «Объясни этот скриншот», «Проанализируй расходы по выписке» или «Создай команду для подготовки контента».`,
    progress: 'Настройка команды · вопрос {step} из 3',
  },
  uz: {
    goal: 'Maqsaddan boshlaymiz. Agent yoki jamoa qanday aniq natija berishi kerak?',
    channels: 'Qaysi kanallar, fayllar yoki servislar bilan ishlash kerak? Masalan: Telegram, Google Drive, CRM, CSV yoki sayt.',
    format: 'Qaysi format kerak: bitta maxsus agentmi yoki mutaxassislar jamoasimi?',
    capabilities: `## Nemo nimalarni qila oladi

Bu yerda vazifani muhokama qilish, material tayyorlash va aniq maqsad uchun AI-jamoani sozlash mumkin.

- **Savol va matnlar:** ulangan model orqali tushuntirish, qoralama va rasmlarni tahlil qilish.
- **Fayl va hisob-kitoblar:** manba maʼlumotlarini yuklang — chatda tahlil yoki hujjat tayyorlash vositasi ochiladi. Imkoniyatlar fayl formati va servisga bog‘liq.
- **AI-jamoa:** kerakli natija va manbalarni yozing. Jamoa sozlamalari yaratiladi; servisga kirish va ishga tayyorlik alohida tekshiriladi.

Telegram, Google Drive va CRM egasining ulashi va ruxsatini talab qiladi. Menyuda mavjudligi servis ulanganini anglatmaydi. Bajarilgan amal saqlangan natija bilan tasdiqlanadi.

Masalan: «Bu skrinshotni tushuntir», «Ko‘chirmadagi xarajatlarni tahlil qil» yoki «Kontent tayyorlash uchun jamoa yarat».`,
    progress: 'Jamoani sozlash · 3 savoldan {step}-savol',
  },
  en: {
    goal: 'Let’s start with the goal. What concrete outcome should the agent or team deliver?',
    channels: 'Which channels, files, or services should it use? For example: Telegram, Google Drive, CRM, CSV, or a website.',
    format: 'Which format do you need: one focused agent or a team of specialists?',
    capabilities: `## What Nemo can do

Use this chat to discuss a task, prepare materials, and configure an AI team for a specific goal.

- **Questions and writing:** explanations, drafts, and image analysis through a connected model.
- **Files and calculations:** upload source data to open an analysis or document tool in the chat. Support depends on the file format and available service.
- **AI teams:** describe the outcome and sources to create a team configuration. Service access and readiness to work are checked separately.

Telegram, Google Drive, and CRM require connections and owner permissions. A menu entry does not prove a service is connected. Completed actions require a saved result as confirmation.

Try “Explain this screenshot”, “Analyse expenses in this statement”, or “Create a team for content preparation”.`,
    progress: 'Team setup · question {step} of 3',
  },
} as const

const ARTIFACT_META = {
  browser: { icon: Globe2, route: null, titleKey: 'smartTaskDesk.browserTitle', tint: 'text-accent-cyan bg-accent-cyan/10' },
  marketing: { icon: Film, route: '/app/content', titleKey: 'smartTaskDesk.marketingTitle', tint: 'text-violet bg-violet/10' },
  finance: { icon: Landmark, route: '/app/finance', titleKey: 'smartTaskDesk.financeTitle', tint: 'text-teal bg-teal/10' },
  research: { icon: NotebookTabs, route: '/app/research', titleKey: 'smartTaskDesk.researchTitle', tint: 'text-accent-cyan bg-accent-cyan/10' },
  'video-edit': { icon: Film, route: null, titleKey: 'smartTaskDesk.videoEditTitle', tint: 'text-violet bg-violet/10' },
  code: { icon: Code2, route: '/app/teams', titleKey: 'smartTaskDesk.codeTitle', tint: 'text-teal bg-teal/10' },
} as const

export function SmartTaskDesk() {
  const { user, loading, sessionGeneration } = useAuth()
  if (loading) return null
  // React discards the entire conversation, draft, files and active context together.
  // Late closures belong to the old instance and cannot append to the next user's chat.
  return <ScopedSmartTaskDesk key={`${user?.id ?? 'anonymous'}:${sessionGeneration}`} userId={user?.id ?? ''} />
}

function ScopedSmartTaskDesk({ userId }: { userId: string }) {
  const { lang } = useI18n()
  const trialMode = import.meta.env.DEV && import.meta.env.VITE_TRIAL_MODEL_CHAT === '1'
  const [scope, setScope] = useState<{ ready: boolean; value: string | null; error: boolean }>({ ready: trialMode, value: null, error: false })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (trialMode) return
    const controller = new AbortController()
    void resolveChatScope(userId, controller.signal).then(value => {
      if (!controller.signal.aborted) setScope({ ready: true, value, error: false })
    }).catch(() => { if (!controller.signal.aborted) setScope({ ready: true, value: null, error: true }) })
    return () => controller.abort()
  }, [userId, trialMode, retry])
  if (!scope.ready) return <p role="status">{chatExperienceCopy[lang].checkingScope}</p>
  if (scope.error) return <div role="alert"><p>{chatExperienceCopy[lang].scopeFailed}</p><button type="button" onClick={() => { setScope({ ready: false, value: null, error: false }); setRetry(value => value + 1) }}>{chatExperienceCopy[lang].retryScope}</button></div>
  return <SessionSmartTaskDesk chatScope={scope.value} />
}

function SessionSmartTaskDesk({ chatScope }: { chatScope: string | null }) {
  const { t, lang } = useI18n()
  const { user: authUser } = useAuth()
  const trialMode = import.meta.env.DEV && import.meta.env.VITE_TRIAL_MODEL_CHAT === '1'
  const [restored] = useState(() => {
    try { return readChatSession(trialMode ? '' : chatScope ?? '', sessionStorage) }
    catch { return { turns: [], discovery: null, model: 'fast', effort: 'low', historyFrom: 0, continuation: undefined } }
  })
  const experienceCopy = chatExperienceCopy[lang]
  const [storageFailed, setStorageFailed] = useState(false)
  const [sessionRevision, setSessionRevision] = useState(0)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const addAgent = useAgentStore((state) => state.addAgent)
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>(restored.turns)
  const [activeArtifactId, setActiveArtifactId] = useState<number | null>(null)
  const [activeEntity, setActiveEntity] = useState<ChatCreatedEntity | null>(null)
  const [creating, setCreating] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [answerModel, setAnswerModel] = useState(restored.model)
  const [answerEffort, setAnswerEffort] = useState<FrontierEffort>(restored.effort as FrontierEffort)
  const continuation = useRef<string | undefined>(restored.continuation)
  const historyFrom = useRef(restored.historyFrom)
  const answerRequest = useRef<AbortController | null>(null)
  const checkingScope = useRef(false)
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(restored.discovery)
  const [attachments, setAttachments] = useState<File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const turnId = useRef(Math.max(0, ...restored.turns.map(turn => turn.id)))
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const discoveryStartedFromUrl = useRef(false)
  const discoveryCopy = DISCOVERY_COPY[lang]
  const modelMounted = useRef(true)
  useEffect(() => {
    if (trialMode || !authUser?.id || !chatScope) return
    const savedTurns: SavedChatTurn[] = turns.flatMap(turn => turn.text && turn.id > 0 && !turn.error && !turn.trialBooking && !turn.artifact && !turn.entity && !turn.documentJob && !turn.marginFiles
      ? [{ id: turn.id, role: turn.role, text: turn.text, direct: true as const, ...(turn.model ? { model: turn.model } : {}) }] : []).slice(-CHAT_HISTORY_LIMIT)
    try { setStorageFailed(!writeChatSession(chatScope, { turns: savedTurns, discovery, model: answerModel, effort: answerEffort, historyFrom: historyFrom.current, continuation: continuation.current }, sessionStorage)) }
    catch { setStorageFailed(true) }
  }, [turns, discovery, answerModel, answerEffort, authUser?.id, trialMode, sessionRevision, chatScope])
  const showTrialConversation = (view: TrialChatView) => {
    if (!modelMounted.current) return
    setTurns([...view.messages.map((m, index) => ({ id: index + 1, role: m.role, text: m.content, direct: true })),
      ...(view.error ? [{ id: 9000, role: 'assistant' as const, text: view.error === 'WAITING_FOR_HUMAN_APPROVAL' ? trialStatusCopy[lang].waiting_for_approval : trialModelCopy[lang].stopped, direct: true }] : []),
      { id: 9001, role: 'assistant', trialBooking: true, trialOperationOnly: true, trialBookingKey: view.operation?.operation_id ?? view.chatId, direct: true }])
  }
  useEffect(() => {
    modelMounted.current = true
    if (trialMode && authUser?.id && hasTrialModelChat(authUser.id)) {
      void trialModelChat(authUser.id).then(showTrialConversation).catch(() => {
        if (modelMounted.current) setAttachmentError(trialModelCopy[lang].failure)
      })
    }
    return () => { modelMounted.current = false }
    // The parent remounts this entire desk for every auth generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const lifetime = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort(); answerRequest.current?.abort() }
  }, [])
  const documentsRestoredFor = useRef<string | null>(null)

  useEffect(() => {
    // восстановление после перезагрузки: недавние документные отправки этого пользователя
    // возвращаются карточками, которые ОПРАШИВАЮТ существующие задания по сохранённым
    // метаданным (submissionId+jobId) — не перегенерируют. Один раз на личность, только в
    // пустой чат; ходы чата по-прежнему не персистентны — восстанавливаются ЗАДАНИЯ.
    const identity = authUser?.id ?? null
    if (!identity || documentsRestoredFor.current === identity) return
    documentsRestoredFor.current = identity
    const recent = listRecentDocumentJobs(identity)
    const recoveryIssue = hasDocumentRecoveryIssue(identity)
    if (!recent.length && !recoveryIssue) return
    const restored: ChatTurn[] = recent.map((job, index) => ({
      // отрицательные id не сталкиваются со счётчиком новых ходов
      id: -(index + 1) * 2,
      role: 'assistant' as const,
      copyKey: 'smartTaskDesk.documentRestored',
      documentJob: { kind: job.kind, title: job.title, brief: job.brief, submissionId: job.submissionId },
    }))
    if (recoveryIssue) restored.push({ id: -999, role: 'assistant', error: true, text: {
      ru: 'Часть сохранённых запросов файлов недоступна или повреждена. Автоматическая повторная генерация остановлена. Пришлите исходный материал, если нужен новый файл.',
      uz: 'Saqlangan fayl so‘rovlarining bir qismi mavjud emas yoki buzilgan. Avtomatik qayta generatsiya to‘xtatildi. Yangi fayl kerak bo‘lsa, asl materialni yuboring.',
      en: 'Some saved file requests are unavailable or damaged. Automatic regeneration has stopped. Send the original material if you need a new file.',
    }[lang] })
    setTurns((current) => [...current, ...restored.filter(turn => !turn.documentJob || !current.some(existing => existing.documentJob?.submissionId === turn.documentJob?.submissionId))])
  }, [authUser?.id, lang])

  const askDiscoveryQuestion = (copy: string) => {
    const id = ++turnId.current
    setTurns((current) => [...current.slice(-(CHAT_HISTORY_LIMIT - 1)), { id, role: 'assistant', text: copy }])
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }

  const startDiscovery = (requestedKind: 'team' | 'agent' | null, initialRequest = '') => {
    setActiveEntity(null)
    const state = startChatDiscovery(requestedKind, initialRequest)
    setDiscovery(state)
    askDiscoveryQuestion(discoveryCopy[state.step])
  }

  useEffect(() => {
    const create = searchParams.get('create')
    if (create !== 'team' && create !== 'agent') {
      discoveryStartedFromUrl.current = false
      return
    }
    if (discoveryStartedFromUrl.current) return
    discoveryStartedFromUrl.current = true
    startDiscovery(create, '')
    const next = new URLSearchParams(searchParams)
    next.delete('create')
    setSearchParams(next, { replace: true })
    // This effect intentionally reacts only to the one-shot URL command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams])

  const suggestions = useMemo(() => [
    { kind: 'browser' as const, label: t('smartTaskDesk.suggestionBrowser') },
    { kind: 'marketing' as const, label: t('smartTaskDesk.suggestionMarketing') },
    { kind: 'finance' as const, label: t('smartTaskDesk.suggestionFinance') },
    { kind: 'research' as const, label: t('smartTaskDesk.suggestionResearch') },
  ], [t])

  const runTask = async (text: string, forcedKind?: SmartArtifactKind) => {
    const selectedFiles = attachments
    const value = text.trim() || (selectedFiles.length ? t('smartTaskDesk.analyzeAttachments') : '')
    if (!value || creating || answering || checkingScope.current) return
    if (chatScope && !trialMode) {
      checkingScope.current = true
      setAnswering(true)
      try {
        const current = await resolveChatScope(authUser?.id ?? '', lifetime.current!.signal)
        if (lifetime.current?.signal.aborted) return
        if (current !== chatScope) { setAttachmentError(experienceCopy.scopeChanged); return }
      } catch {
        if (!lifetime.current?.signal.aborted) setAttachmentError(experienceCopy.scopeFailed)
        return
      } finally {
        checkingScope.current = false
        if (!lifetime.current?.signal.aborted) setAnswering(false)
      }
    }
    const entityIntent = isExplicitCreation(value) ? classifyChatEntityIntent(value) : null
    const hasVideo = selectedFiles.some((file) => file.type.startsWith('video/') || /\.mp4$/i.test(file.name))
    const asksForVideoEdit = /монтаж|смонтир|субтитр|motion|моушн|нарежь|обработай видео|edit (?:the )?video/i.test(value)
    const hasResearchSource = selectedFiles.some((file) => file.type.startsWith('audio/') || /\.(pdf|docx|xlsx|csv|txt|md|json)$/i.test(file.name))
    const artifact = forcedKind ?? (hasVideo && asksForVideoEdit ? 'video-edit' : hasVideo || hasResearchSource ? 'research' : classifyTaskArtifact(value, { hasAttachments: selectedFiles.length > 0 }))
    const documentIntent = !forcedKind && !activeEntity ? classifyDocumentChatIntent(value) : null
    const directRoute = !discovery && !entityIntent && !activeEntity && !artifact && !documentIntent && isSupabaseEnabled
    const preparingImages = directRoute && selectedFiles.length > 0
    if (preparingImages && (selectedFiles.length > 2 || selectedFiles.some(file=>!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > CHAT_IMAGE_MAX_BYTES))) {
      setAttachmentError(t('frontierChat.imagesLimit'))
      return
    }
    const stamp = turnId.current += 2
    setTurns((current) => [...current.slice(-(CHAT_HISTORY_LIMIT - 2)), { id: stamp, role: 'user', text: value, attachments: selectedFiles }])
    if (!preparingImages) { setDraft(''); setAttachments([]) }
    setAttachmentError('')
    // Informational questions never become tool calls or answers to intake,
    // including while an existing trial operation awaits human approval.
    if (isCapabilityQuestion(value) && selectedFiles.length === 0) {
      setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: discoveryCopy.capabilities, direct: true }])
      window.setTimeout(() => composerRef.current?.focus(), 0)
      return
    }
    if (trialMode && authUser?.id && (hasTrialModelChat(authUser.id) || /пробн[а-я]*\s+занят|trial\s+lesson|sinov\s+dars/i.test(value))) {
      setAnswering(true)
      try { showTrialConversation(await trialModelChat(authUser.id, value)) }
      catch { if (modelMounted.current) setAttachmentError(trialModelCopy[lang].failure) }
      finally { if (modelMounted.current) setAnswering(false) }
      return
    }
    if (import.meta.env.DEV && isLocalTrialUrl(String(import.meta.env.VITE_SUPABASE_URL)) && /пробн[а-я]*\s+занят|trial\s+lesson|sinov\s+dars/i.test(value)) {
      setTurns(current => [...current, { id: stamp + 1, role: 'assistant', trialBooking: true, direct: true }])
      return
    }
    if (discovery && isDiscoveryCancellation(value)) {
      setDiscovery(null)
      setTurns(current => [...current, { id: stamp + 1, role: 'assistant', text: experienceCopy.setupCancelled, direct: true }])
      return
    }
    if (discovery || entityIntent) {
      const state = discovery ? advanceChatDiscovery(discovery, value) : startChatDiscovery(entityIntent, value)
      const missing = nextDiscoveryStep(state)
      if (missing) {
        setDiscovery(state)
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: discoveryCopy[missing] }])
        window.setTimeout(() => composerRef.current?.focus(), 0)
        return
      }
      const creationPrompt = discoveryPrompt(state)
      setDiscovery(null)
      setCreating(true)
      try {
        const entity = await createEntityFromChat(creationPrompt, addAgent, deleteAgent)
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', copyKey: `smartTaskDesk.${entity.kind}Created`, entity }])
      } catch (error) {
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: error instanceof Error ? error.message : t('smartTaskDesk.creationFailed'), error: true }])
      } finally {
        setCreating(false)
      }
      return
    }
    // Explicit file creation takes precedence over a margin preview. Pass the entire batch;
    // the document card either extracts every supported file or stops with a visible error.
    if (documentIntent) {
      setTurns((current) => [...current, {
        id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.documentReady',
        documentJob: { ...documentIntent, submissionId: crypto.randomUUID(), files: selectedFiles },
      }])
      setActiveArtifactId(null)
      return
    }
    // margin intent + .xlsx wins BEFORE the generic routes: an active entity must not swallow
    // the file, and the research classifier must not claim it. A spreadsheet WITHOUT margin
    // words still goes to research as before. The branch claims the turn only when EVERY
    // attachment is an .xlsx — each one gets its own card, nothing is silently discarded; a
    // mixed batch falls through to research, which handles all the files together.
    const marginIntent = /марж|рентабельн|прибыл|margin|profitab|marja|rentabel|foyda/i.test(value)
    const marginXlsx = selectedFiles.filter((file) => /\.xlsx$/i.test(file.name))
    if (!forcedKind && marginIntent && marginXlsx.length > 0) {
      if (marginXlsx.length === selectedFiles.length) {
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.marginReady', marginFiles: marginXlsx }])
        setActiveArtifactId(null)
        return
      }
      // mixed batch: research below takes ALL the files — say so out loud instead of silently
      // losing the margin route the user asked for
      const noteId = turnId.current += 2
      setTurns((current) => [...current, { id: noteId, role: 'assistant', copyKey: 'smartTaskDesk.marginMixedNote', direct: true }])
    }
    if (!activeEntity && !artifact && isSupabaseEnabled) {
      const controller = new AbortController()
      answerRequest.current = controller
      const alive = () => !lifetime.current?.signal.aborted && !controller.signal.aborted && answerRequest.current === controller
      setAnswering(true)
      let imagesPrepared = false
      try {
        if (!supabase) throw new Error('auth')
        const history = turns.flatMap((turn) => turn.id > historyFrom.current && !turn.error && turn.text ? [{ role: turn.role, content: turn.text }] : []).slice(-(CHAT_HISTORY_LIMIT - 1))
        const imageFiles = selectedFiles
        const userContent = imageFiles.length
          ? [{ type: 'text', text: value }, ...await Promise.all(imageFiles.map(async (file) => ({ type: 'image_url', image_url: { url: await imageFileToDataUrl(file) } })))]
          : value
        // bounded: a hung function (or a hung error body) must release the answering state
        // with an honest failure — this is a fast conversational call, not file processing
        if (!alive() || !controller) return
        const frontierModel = FRONTIER_MODELS.find(model => model.model === answerModel)
        if (frontierModel && Array.isArray(userContent) && userContent.some(part=>'image_url' in part && part.image_url!.url.length > 400_000)) throw new Error('IMAGE_LIMIT')
        imagesPrepared = true
        if (preparingImages) { setDraft(current=>current===text ? '' : current); setAttachments(current=>current===selectedFiles ? [] : current) }
        if (frontierModel) {
          const selection = { provider: frontierModel.provider, model: frontierModel.model, effort: answerEffort }
          const direct = await fetchFrontierAnswer(() => invokeScopedFunction(supabase!, 'cli-chat',
            { selection, messages: [{role:'user',content:userContent}], tools:[], ...(continuation.current ? {continuation:continuation.current} : {}) },
            {userId:authUser?.id ?? '',alive,signal:controller.signal},90_000), selection)
          if (!alive()) return
          if (!direct.ok) {
            const reason = ['NEED_KEY','KEY_UNAVAILABLE','KEY_REJECTED'].includes(direct.code) ? 'needKey' : direct.code === 'UNSUPPORTED_CAPABILITY' ? 'unsupported' : ['INVALID_CONTINUATION','CONTEXT_LIMIT'].includes(direct.code) ? 'newConversation' : 'failed'
            if (reason === 'newConversation') continuation.current = undefined
            setTurns(current=>[...current,{id:stamp+1,role:'assistant',text:t(`frontierChat.${reason}`),error:true,direct:true,model:selection.model}])
            return
          }
          continuation.current = direct.continuation
          setTurns(current=>[...current,{id:stamp+1,role:'assistant',text:direct.text,direct:true,model:direct.model}])
          return
        }
        const direct = await fetchDirectAnswer(() => invokeScopedFunction(supabase!, 'cli-chat',
          { model: DIRECT_ANSWER_MODEL, messages: [...history, { role: 'user', content: userContent }], tools: [], ...(chatScope && !chatScope.startsWith('demo:') ? { contextAccountId: chatScope.split(':').at(-2) } : {}) },
          { userId: authUser?.id ?? '', alive, signal: controller.signal }, 45_000))
        if (!alive()) return
        if (!direct.ok) throw new Error('answer')
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: direct.text, direct: true }])
      } catch {
        if (!alive()) return
        if (preparingImages && !imagesPrepared) {
          setAttachmentError(t('frontierChat.imagesLimit'))
          setTurns(current=>current.filter(turn=>turn.id!==stamp))
          return
        }
        setTurns((current) => [...current, { id: stamp + 1, role: 'assistant', text: t('smartTaskDesk.answerFailed'), error: true, direct: true }])
      } finally {
        if (answerRequest.current === controller) { answerRequest.current = null; setAnswering(false) }
      }
      return
    }
    const response: ChatTurn = activeEntity
      ? { id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.teamRunReady', entity: activeEntity, teamRunGoal: value }
      : artifact
        ? { id: stamp + 1, role: 'assistant', copyKey: `smartTaskDesk.${artifact}Ready`, artifact, artifactPrompt: value, attachments: selectedFiles }
        : { id: stamp + 1, role: 'assistant', copyKey: 'smartTaskDesk.generalReady' }
    setTurns((current) => [...current, response])
    setActiveArtifactId(artifact ? stamp + 1 : null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void runTask(draft)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void runTask(draft)
    }
  }

  const appendAttachments = (incoming: File[]) => {
    if (!incoming.length) return
    const supported = incoming.filter((file) => file.size > 0 && file.size <= CHAT_FILE_MAX_BYTES)
    setAttachments((current) => [...current, ...supported].slice(0, CHAT_FILE_LIMIT))
    setAttachmentError(
      supported.length !== incoming.length
        ? t('smartTaskDesk.fileRejected')
        : attachments.length + supported.length > CHAT_FILE_LIMIT
          ? t('smartTaskDesk.fileLimit', { count: CHAT_FILE_LIMIT })
        : '',
    )
  }

  const selectAttachments = (files: FileList | null) => {
    if (!files?.length) return
    appendAttachments(Array.from(files))
  }

  const onComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    const pastedImages = items.length ? items : Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))

    // Keep ordinary text paste native. Only image clipboard items become chat attachments.
    if (!pastedImages.length) return
    event.preventDefault()
    const pastedText = event.clipboardData.getData('text/plain')
    if (pastedText) {
      const { selectionStart, selectionEnd } = event.currentTarget
      setDraft(current => current.slice(0, selectionStart) + pastedText + current.slice(selectionEnd))
    }
    const stamp = Date.now()
    appendAttachments(pastedImages.map((file, index) => {
      if (file.name) return file
      const extension = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      return new File([file], `clipboard-image-${stamp}-${index + 1}.${extension}`, { type: file.type, lastModified: file.lastModified })
    }))
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }

  return (
    <section className="overflow-hidden rounded-[28px] border border-ice/[0.09] bg-panel/70 shadow-[0_24px_80px_-48px_rgba(6,182,212,0.55)] backdrop-blur-xl" aria-labelledby="smart-task-desk-title">
      <header className="border-b border-ice/[0.07] px-4 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-flow-gradient text-white shadow-lg shadow-violet/15">
            <Sparkles size={19} />
            <span className="absolute inset-0 animate-pulse bg-white/[0.05]" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-accent-cyan">{t('smartTaskDesk.eyebrow')}</p>
            <h1 id="smart-task-desk-title" className="mt-1 text-2xl font-extrabold tracking-[-0.035em] text-text sm:text-3xl">{t('smartTaskDesk.title')}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{t('smartTaskDesk.subtitle')}</p>
          </div>
        </div>
      </header>

      <div className="min-h-[300px] space-y-5 px-3 py-5 sm:px-6">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.06] text-accent-cyan"><Bot size={15} /></span>
          <div className="max-w-3xl rounded-2xl rounded-tl-md border border-ice/[0.07] bg-card/[0.035] px-4 py-3 text-sm leading-6 text-muted">
            {t('smartTaskDesk.welcome')}
          </div>
        </div>

        {activeEntity && <div className="ml-11 flex flex-wrap items-center gap-2 rounded-xl border border-teal/20 bg-teal/[0.06] px-3 py-2 text-xs text-muted">
          <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-teal" /></span>
          <strong className="text-text">{activeEntity.name}</strong>
          <span>{t('smartTaskDesk.activeContext')}</span>
          <button type="button" onClick={() => setActiveEntity(null)} className="ml-auto font-semibold text-teal hover:text-text">{t('smartTaskDesk.leaveContext')}</button>
        </div>}

        {turns.map((turn) => (
          <div key={turn.id} className={cn('flex items-start gap-3 animate-fadeIn', turn.role === 'user' && 'justify-end')}>
            {turn.role === 'assistant' && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.06] text-accent-cyan"><Bot size={15} /></span>}
            <div className={cn('min-w-0', turn.artifact ? 'w-[calc(100%-44px)]' : 'max-w-3xl')}>
              <div className={cn(
                'rounded-2xl px-4 py-3 text-sm leading-6',
                turn.role === 'user' ? 'rounded-tr-md bg-accent-indigo text-white' : 'rounded-tl-md border border-ice/[0.07] bg-card/[0.035] text-muted',
              )}>
                {turn.direct && turn.role === 'assistant' && turn.text
                  ? <Markdown content={turn.text} />
                  : (turn.text ?? (turn.copyKey ? t(turn.copyKey) : ''))}
                {turn.model && <p className="mt-2 text-[10px] text-fog">{FRONTIER_MODELS.find(model=>model.model===turn.model)?.label ?? turn.model}</p>}
                {!!turn.attachments?.length && <div className="mt-2 flex flex-wrap gap-2">{turn.attachments.map((file, index) => {
                  const Icon = attachmentIcon(file)
                  return <span key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-black/15 px-2 py-1 text-[10px] text-white/90"><Icon size={12} /><span className="max-w-48 truncate">{file.name}</span><span className="text-white/60">{attachmentSize(file.size)}</span></span>
                })}</div>}
              </div>
              {turn.artifact && (
                <ArtifactCard
                  runKey={turn.id}
                  kind={turn.artifact}
                  prompt={turn.artifactPrompt ?? ''}
                  attachments={turn.attachments}
                  expanded={activeArtifactId === turn.id}
                  onToggle={() => setActiveArtifactId((current) => current === turn.id ? null : turn.id)}
                />
              )}
              {turn.marginFiles?.map((file, index) => <MarginChatCard key={`${turn.id}:${index}`} runKey={turn.id * 8 + index} file={file} />)}
              {turn.documentJob && <DocumentChatCard runKey={turn.id} kind={turn.documentJob.kind} title={turn.documentJob.title} brief={turn.documentJob.brief} submissionId={turn.documentJob.submissionId} files={turn.documentJob.files} />}
              {turn.trialBooking && <TrialBookingChatCard key={turn.trialBookingKey} operationOnly={turn.trialOperationOnly} />}
              {turn.entity && !turn.teamRunGoal && <TeamArtifact entity={turn.entity} onOpen={() => navigate(turn.entity!.kind === 'team' ? `/app/teams/${turn.entity!.id}` : `/app/agents/${turn.entity!.id}`)} onWorkHere={() => setActiveEntity(turn.entity ?? null)} />}
              {turn.entity && turn.teamRunGoal && <TeamRunArtifact entity={turn.entity} goal={turn.teamRunGoal} />}
              {!turn.artifact && !turn.entity && !turn.marginFiles && !turn.documentJob && !turn.direct && turn.role === 'assistant' && !turn.error && (
                <Link to="/app/teams" className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-ice/[0.08] px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent-cyan/25 hover:text-text">
                  <Users size={14} />{t('smartTaskDesk.openTeams')}
                </Link>
              )}
            </div>
          </div>
        ))}
        {creating && <div className="flex items-center gap-3 animate-fadeIn"><span className="flex h-8 w-8 items-center justify-center rounded-xl border border-violet/20 bg-violet/10 text-violet"><Loader2 size={15} className="animate-spin" /></span><div className="rounded-2xl rounded-tl-md border border-ice/[0.07] bg-card/[0.035] px-4 py-3 text-sm text-muted"><span className="mr-2 inline-flex gap-1 align-middle"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-cyan" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet [animation-delay:150ms]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal [animation-delay:300ms]" /></span>{t('smartTaskDesk.assembling')}</div></div>}
        {answering && <div className="flex items-center gap-3 animate-fadeIn"><span className="flex h-8 w-8 items-center justify-center rounded-xl border border-accent-cyan/20 bg-accent-cyan/10 text-accent-cyan"><Loader2 size={15} className="animate-spin" /></span><div className="rounded-2xl rounded-tl-md border border-ice/[0.07] bg-card/[0.035] px-4 py-3 text-sm text-muted"><span className="mr-2 inline-flex gap-1 align-middle"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-cyan" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet [animation-delay:150ms]" /><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal [animation-delay:300ms]" /></span>{t('smartTaskDesk.answering')}</div></div>}
      </div>

      <div className="border-t border-ice/[0.07] bg-bg/20 p-3 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-2 text-muted">{t('frontierChat.model')}
            <select aria-label={t('frontierChat.model')} value={answerModel} disabled={trialMode || answering || creating} onChange={event=>{setAnswerModel(event.target.value);continuation.current=undefined;historyFrom.current=turnId.current+1}} className="max-w-full rounded-lg border border-ice/15 bg-bg px-2 py-2 text-text">
              <option value="fast">{t('frontierChat.fast')}</option>
              {FRONTIER_MODELS.map(model=><option key={model.model} value={model.model}>{model.label}</option>)}
            </select>
          </label>
          {trialMode && <span className="text-xs text-muted" data-testid="trial-model-identity">OpenRouter · openai/gpt-4o-mini · OpenAI</span>}
          {trialMode && <p className="w-full text-xs text-muted">{trialModelCopy[lang].note}</p>}
          {answerModel !== 'fast' && <>
            <select aria-label={t('frontierChat.effort')} value={answerEffort} disabled={answering || creating} onChange={event=>{setAnswerEffort(event.target.value as FrontierEffort);continuation.current=undefined;historyFrom.current=turnId.current+1}} className="rounded-lg border border-ice/15 bg-bg px-2 py-2 text-text">
              {FRONTIER_EFFORTS.map(effort=><option key={effort} value={effort}>{t(`frontierChat.${effort}`)}</option>)}
            </select>
            <Link to="/app/providers" className="text-cyan underline underline-offset-2">{t('frontierChat.connect')}</Link>
            <button type="button" disabled={answering} onClick={()=>{continuation.current=undefined;historyFrom.current=turnId.current+1;setSessionRevision(value=>value+1)}} className="text-muted underline underline-offset-2">{t('frontierChat.reset')}</button>
            <p className="w-full text-[11px] leading-relaxed text-muted">{t('frontierChat.scope')}</p>
          </>}
          {answering && !trialMode && <button type="button" onClick={()=>{answerRequest.current?.abort();answerRequest.current=null;setAnswering(false);setTurns(current=>[...current,{id:++turnId.current,role:'assistant',text:t('frontierChat.stopped'),direct:true,error:true}])}} className="rounded-lg border border-ice/20 px-3 py-2 text-text">{t('frontierChat.stop')}</button>}
        </div>
        {discovery && <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-violet/20 bg-violet/[0.06] px-3 py-2 text-[11px] font-semibold text-violet"><Sparkles size={13} />{experienceCopy.clarifying}: {discoveryCopy[discovery.step]}<button type="button" className="ml-auto underline" onClick={() => setDiscovery(null)}>{experienceCopy.cancelSetup}</button></div>}
        {(answering || creating) && <p role="status" aria-live="polite" className="mb-2 text-xs text-muted">{creating ? experienceCopy.creating : experienceCopy.answering}</p>}
        {!turns.length && <div className="mb-3 flex flex-wrap gap-2">
          {suggestions.map((suggestion) => <button key={suggestion.kind} type="button" onClick={() => void runTask(suggestion.label, suggestion.kind)} className="rounded-xl border border-ice/[0.08] bg-card/[0.025] px-3 py-2 text-left text-xs text-muted transition hover:-translate-y-0.5 hover:border-accent-cyan/25 hover:text-text">{suggestion.label}</button>)}
        </div>}
        <form onSubmit={submit} className="relative rounded-2xl border border-ice/[0.1] bg-card/[0.04] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus-within:border-accent-cyan/30 focus-within:ring-2 focus-within:ring-accent-cyan/[0.06]">
          {!!attachments.length && <div className="flex flex-wrap gap-2 px-2 pb-1">{attachments.map((file, index) => {
            const Icon = attachmentIcon(file)
            return <span key={`${file.name}-${index}`} className="inline-flex min-w-0 items-center gap-2 rounded-xl border border-accent-cyan/15 bg-accent-cyan/[0.06] px-2.5 py-2 text-[11px] text-text"><AttachmentPreview file={file} /><Icon size={14} className="shrink-0 text-accent-cyan" /><span className="max-w-48 truncate">{file.name}</span><span className="text-fog">{attachmentSize(file.size)}</span><button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="rounded-md p-0.5 text-fog hover:bg-white/[0.06] hover:text-text" aria-label={t('smartTaskDesk.removeFile')}><X size={12} /></button></span>
          })}</div>}
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            rows={2}
            placeholder={t('smartTaskDesk.placeholder')}
            className="min-h-16 w-full resize-none bg-transparent px-2 py-2 pb-10 pr-12 text-sm leading-6 text-text outline-none placeholder:text-fog"
          />
          <input ref={fileInputRef} type="file" multiple accept={CHAT_FILE_ACCEPT} className="hidden" onChange={(event) => { selectAttachments(event.target.files); event.target.value = '' }} />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={creating || answering || attachments.length >= CHAT_FILE_LIMIT} aria-label={t('smartTaskDesk.attachFile')} className="absolute bottom-3 left-3 inline-flex h-9 items-center gap-2 rounded-xl border border-ice/[0.08] px-3 text-[11px] font-semibold text-muted transition hover:border-accent-cyan/25 hover:text-text disabled:opacity-35"><Paperclip size={15} /><span className="hidden sm:inline">{t('smartTaskDesk.attach')}</span></button>
          <button type="submit" disabled={(!draft.trim() && !attachments.length) || creating || answering} aria-label={t('smartTaskDesk.send')} className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-xl bg-accent-cyan text-bg transition hover:brightness-105 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-35"><ArrowUp size={17} /></button>
        </form>
        {attachmentError && <p role="alert" className="mt-2 px-1 text-[10px] text-amber">{attachmentError}</p>}
        {!trialMode && <div className="mt-3 space-y-1 text-[11px] leading-5 text-muted">
          {storageFailed || !chatScope ? <p role="alert">{experienceCopy.storageFailed}</p> : <p>{experienceCopy.memory}</p>}
          {restored.turns.length > 0 && <p>{experienceCopy.restored}</p>}
          {turns.length > 0 && !turns.some(turn => turn.artifact || turn.entity || turn.documentJob || turn.trialBooking || turn.marginFiles) && <button type="button" className="underline underline-offset-2" disabled={answering || creating} onClick={() => { continuation.current = undefined; historyFrom.current = 0; setTurns([]); setDiscovery(null); setDraft(''); setAttachments([]) }}>{experienceCopy.newConversation}</button>}
        </div>}
        <p className="mt-2 flex items-center gap-1.5 px-1 text-[10px] text-fog"><MessageSquareText size={12} />{t('smartTaskDesk.routingHint')}</p>
      </div>
    </section>
  )
}

function TeamArtifact({ entity, onOpen, onWorkHere }: { entity: ChatCreatedEntity; onOpen(): void; onWorkHere(): void }) {
  const { t } = useI18n()
  const Icon = entity.kind === 'team' ? Users : UserRound
  return <section className="mt-3 overflow-hidden rounded-2xl border border-accent-cyan/20 bg-gradient-to-br from-accent-cyan/[0.07] via-bg/50 to-violet/[0.07] shadow-[0_18px_60px_-42px_rgba(34,211,238,0.7)]">
    <div className="flex items-center gap-3 border-b border-ice/[0.07] p-4"><span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-flow-gradient text-white shadow-lg shadow-violet/20"><Icon size={19} /></span><div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-accent-cyan">{t(entity.kind === 'team' ? 'smartTaskDesk.teamArtifact' : 'smartTaskDesk.agentArtifact')}</p><h2 className="truncate text-base font-bold text-text">{entity.name}</h2></div><span className="rounded-full border border-teal/20 bg-teal/10 px-2.5 py-1 text-[10px] font-semibold text-teal">{t('smartTaskDesk.ready')}</span></div>
    <div className="p-4"><div className="grid gap-2 sm:grid-cols-3">{entity.members.map((member, index) => <div key={`${member.name}-${index}`} className="relative overflow-hidden rounded-xl border border-ice/[0.08] bg-black/10 p-3"><span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-teal shadow-[0_0_12px_rgba(45,212,191,0.9)]" /><p className="truncate text-xs font-semibold text-text">{member.name}</p><p className="mt-1 truncate text-[10px] text-muted">{member.role}</p></div>)}</div>
      {entity.members.length > 1 && <div className="my-4 flex items-center gap-2 text-[10px] text-fog"><Workflow size={13} className="text-violet" /><span className="h-px flex-1 overflow-hidden bg-gradient-to-r from-violet via-accent-cyan to-teal"><span className="block h-px w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] bg-white" /></span>{t('smartTaskDesk.a2aReady')}</div>}
      <div className="flex flex-col gap-2 sm:flex-row"><button type="button" onClick={onOpen} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent-cyan px-4 py-2.5 text-xs font-bold text-bg transition hover:brightness-105"><ExternalLink size={14} />{t(entity.kind === 'team' ? 'smartTaskDesk.openLobby' : 'smartTaskDesk.openAgent')}</button><button type="button" onClick={onWorkHere} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-ice/[0.1] bg-white/[0.03] px-4 py-2.5 text-xs font-bold text-text transition hover:border-violet/30 hover:bg-violet/[0.06]"><MessageSquareText size={14} />{t('smartTaskDesk.workHere')}</button></div>
    </div>
  </section>
}

function TeamRunArtifact({ entity, goal }: { entity: ChatCreatedEntity; goal: string }) {
  const { t } = useI18n()
  return <section className="mt-3 overflow-hidden rounded-2xl border border-violet/20 bg-bg/45"><div className="flex items-center gap-3 border-b border-ice/[0.07] px-4 py-3"><span className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-violet/10 text-violet"><Workflow size={16} /><span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-teal" /></span><div><p className="text-xs font-bold text-text">{entity.name}</p><p className="text-[10px] text-muted">{t('smartTaskDesk.teamRunHandoff')}</p></div></div><div className="p-3 sm:p-4"><AutonomousRunner defaultGoal={goal} departmentId={entity.departmentId} contextKey={`chat:${entity.id}`} presetSpecs={entity.members.map((member) => ({ name: member.name, role: member.role, skills: member.skills, prompt: member.prompt }))} /></div></section>
}

function ArtifactCard({ runKey, kind, prompt, attachments, expanded, onToggle }: { runKey: number; kind: SmartArtifactKind; prompt: string; attachments?: File[]; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const meta = ARTIFACT_META[kind]
  const Icon = meta.icon

  return <section className="mt-3 overflow-hidden rounded-2xl border border-ice/[0.09] bg-bg/35">
    <div className="flex flex-wrap items-center gap-3 border-b border-ice/[0.07] px-3 py-3 sm:px-4">
      <span className={cn('flex h-9 w-9 items-center justify-center rounded-xl', meta.tint)}><Icon size={16} /></span>
      <div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-fog">{t('smartTaskDesk.interactiveArtifact')}</p><h2 className="truncate text-sm font-bold text-text">{t(meta.titleKey)}</h2></div>
      {meta.route && <Link to={meta.route} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] font-semibold text-muted transition hover:bg-white/[0.04] hover:text-text"><ExternalLink size={13} />{t('smartTaskDesk.openFull')}</Link>}
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="inline-flex items-center gap-1.5 rounded-lg border border-ice/[0.08] px-2.5 py-2 text-[11px] font-semibold text-muted transition hover:bg-white/[0.04] hover:text-text"><ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />{expanded ? t('smartTaskDesk.collapse') : t('smartTaskDesk.expand')}</button>
    </div>
    {kind === 'browser' && <div className={cn('max-h-[760px] overflow-auto p-3 sm:p-5', expanded ? 'animate-fadeIn' : 'hidden')}>
      <BrowserControlArtifact runKey={runKey} prompt={prompt} />
    </div>}
    {expanded && kind !== 'browser' && <div className="max-h-[760px] overflow-auto p-3 sm:p-5 animate-fadeIn">
      {kind === 'marketing' && <MarketingCampaignStudio />}
      {kind === 'finance' && <FinanceCashFlowDashboard />}
      {kind === 'research' && <ResearchNotebookHub initialFiles={attachments} autoAnalyze />}
      {kind === 'video-edit' && <VideoMontageArtifact file={attachments?.find((file) => file.type.startsWith('video/') || /\.mp4$/i.test(file.name))} prompt={prompt} />}
      {kind === 'code' && <LiveCodeSandboxArtifact prompt={prompt} />}
    </div>}
  </section>
}

// React Strict Mode дважды монтирует компоненты в разработке. Один и тот же turn должен запустить
// браузер ровно один раз — повторный клик способен дважды изменить цену или создать дубль.
const browserTaskRuns = new Map<number, Promise<BrowserTaskResult>>()

function BrowserControlArtifact({ runKey, prompt }: { runKey: number; prompt: string }) {
  const { t } = useI18n()
  const [result, setResult] = useState<BrowserTaskResult | null>(null)
  const [running, setRunning] = useState(true)

  const execute = (confirmRisky = false, force = false) => {
    setRunning(true)
    const run = confirmRisky
      ? runExtensionBrowserTask(prompt, true)
      : !force && browserTaskRuns.get(runKey) || runExtensionBrowserTask(prompt, false)
    if (!confirmRisky) browserTaskRuns.set(runKey, run)
    void run.then((answer) => setResult(answer)).finally(() => setRunning(false))
  }

  useEffect(() => {
    const run = browserTaskRuns.get(runKey)
      ?? runExtensionBrowserTask(prompt, explicitlyRequestsBrowserSubmission(prompt))
    browserTaskRuns.set(runKey, run)
    void run.then((answer) => setResult(answer)).finally(() => setRunning(false))
  }, [prompt, runKey])

  const reason = result?.reason ? t(`browserControl.reasons.${result.reason}`) : ''
  return <div className="space-y-3">
    <div className="flex items-start gap-3 rounded-2xl border border-accent-cyan/15 bg-accent-cyan/[0.05] p-4">
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
        {running ? <Loader2 size={18} className="animate-spin" /> : <Globe2 size={18} />}
        {running && <span className="absolute inset-0 animate-ping rounded-xl border border-accent-cyan/30" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-text">{running ? t('browserControl.running') : result?.submitted ? t('browserControl.submitted') : result?.ok ? t('browserControl.completed') : t('browserControl.stopped')}</p>
        <p className="mt-1 text-xs leading-5 text-muted">{running ? t('browserControl.runningHint') : result?.note || reason || t('browserControl.completedHint')}</p>
      </div>
      {!running && result && <span className="rounded-full border border-ice/[0.08] px-2.5 py-1 text-[10px] font-semibold text-muted">{t('browserControl.actions', { count: result.done })}</span>}
    </div>

    {result?.needsConfirmation && !running && <div className="flex flex-col gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4 sm:flex-row sm:items-center">
      <ShieldCheck size={18} className="shrink-0 text-amber-300" />
      <p className="flex-1 text-xs leading-5 text-muted">{t('browserControl.confirmHint')}</p>
      <button type="button" onClick={() => execute(true)} className="rounded-xl bg-amber-300 px-4 py-2.5 text-xs font-bold text-slate-950 transition hover:brightness-105">{t('browserControl.confirm')}</button>
    </div>}

    {!running && result && !result.ok && !result.needsConfirmation && <button type="button" onClick={() => execute(false, true)} className="rounded-xl border border-ice/[0.1] px-4 py-2.5 text-xs font-semibold text-text transition hover:border-accent-cyan/30 hover:bg-accent-cyan/[0.05]">{t('browserControl.retry')}</button>}
  </div>
}
