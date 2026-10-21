import { useState } from 'react'
import {
  ArrowLeftRight,
  ArrowRight,
  CalendarClock,
  Check,
  Code2,
  Copy,
  Cpu,
  Layers,
  PlayCircle,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/cn'

interface SimulationStep {
  time: string
  action: string
  detail: string
  tag: string
}

interface JarvisPreset {
  id: string
  label: string
  prompt: string
  jarvisName: string
  roleSummary: string
  agents: string[]
  connectors: { name: string; type: string }[]
  cronSchedule: string
  cronDetail: string
  zeroHallucinationChecks: string[]
  simulationTrace: SimulationStep[]
}

const presetsByLang: Record<'ru' | 'uz' | 'en', JarvisPreset[]> = {
  ru: [
    {
      id: 'wholesale',
      label: 'Опт & 1С Склад',
      prompt: 'Джарвис для оптовой торговли: следить за остатками в 1С, принимать заявки в Telegram и отправлять утренний аудит цен',
      jarvisName: 'Jarvis Ops & Supply Core',
      roleSummary: 'Главный операционный Джарвис: контроль 1С, учет остатков и координация поставок',
      agents: ['1C Складской аналитик', 'Telegram Order Desk', 'Finance Auditor'],
      connectors: [
        { name: '1С:Предприятие', type: 'REST OData' },
        { name: 'Telegram Bot', type: 'Two-Way Mesh' },
        { name: 'Google Sheets', type: 'Live Sync' },
      ],
      cronSchedule: '0 08:30 * * 1-5',
      cronDetail: 'Автономный утренний аудит расхождений и цен',
      zeroHallucinationChecks: ['ZOD_SCHEMA_STRICT', 'NO_GUESS_ABSTAIN', 'WASM_PRICE_SANDBOX', 'SUPERVISOR_AUDIT'],
      simulationTrace: [
        { time: '08:30:00', action: 'Автономный запуск по Cron', detail: 'Агент сам запустил утренний аудит остатков 1С', tag: 'CRON_TRIGGER' },
        { time: '08:30:02', action: 'Двусторонний запрос OData', detail: 'Чтение 1 420 SKU, выявлено 3 расхождения в ценах', tag: '1C_ODATA' },
        { time: '08:30:03', action: 'WASM-песочница без галлюцинаций', detail: 'Детерминированный пересчет оптовой маржинальности', tag: 'WASM_MATH' },
        { time: '08:30:05', action: 'Дайджест руководству в Telegram', detail: 'Отчет отправлен директору с кнопкой согласования', tag: 'TG_DISPATCH' },
      ],
    },
    {
      id: 'b2b',
      label: 'B2B Продажи & CRM',
      prompt: 'Джарвис для B2B продаж: мгновенно отвечать в WhatsApp, квалифицировать по BANT и ставить встречи в Календарь',
      jarvisName: 'Jarvis Revenue Copilot',
      roleSummary: 'Лид-координатор 24/7: квалификация входящих, скоринг и постановка задач в CRM',
      agents: ['SDR Qualifier', 'Meeting Booker', 'CRM Synchronization Bot'],
      connectors: [
        { name: 'WhatsApp Business', type: 'Cloud API' },
        { name: 'amoCRM', type: 'Bi-directional' },
        { name: 'Google Calendar', type: 'OAuth Slotting' },
      ],
      cronSchedule: '+48 hours (auto)',
      cronDetail: 'Автономный follow-up лидам без участия менеджера',
      zeroHallucinationChecks: ['PRICING_GROUNDED', 'STRICT_FEATURE_LIST', 'CALENDAR_DETERMINISTIC', 'OWNER_NOTIFY_GATE'],
      simulationTrace: [
        { time: '14:22:10', action: 'Входящий запрос в WhatsApp', detail: 'Клиент: «Нужен тариф на 50 рабочих мест, пришлете КП?»', tag: 'INBOUND_WHATSAPP' },
        { time: '14:22:12', action: 'BANT-скоринг & База знаний', detail: 'Агент сверил прайс в Grounded RAG, лид получил статус A-Lead', tag: 'BANT_SCORING' },
        { time: '14:22:14', action: 'Запись в amoCRM & Календарь', detail: 'Сделка создана, отправлен слот зум-демо с Sales Director', tag: 'CRM_TWO_WAY' },
        { time: '14:22:15', action: 'Авто-постановка Cron задачи', detail: 'Поставлен отложенный follow-up ровно через 48 часов', tag: 'CRON_SCHEDULE' },
      ],
    },
    {
      id: 'finance',
      label: 'Финансы & Банк',
      prompt: 'Джарвис для финансов: сверять выписки клиент-банка со счетами, искать кассовые разрывы и собирать закрывающие акты',
      jarvisName: 'Jarvis Treasury & Legal',
      roleSummary: 'Финансовый контролер: мониторинг дебиторки, сверка счетов и сборка актов в PDF',
      agents: ['Банковский верификатор', 'Math Sandbox Solver', 'Contract Doc Builder'],
      connectors: [
        { name: 'Клиент-Банк API', type: 'Fin Connector' },
        { name: 'MS Excel (OneDrive)', type: 'Auto-Fetch' },
        { name: 'PDF Core Engine', type: 'OOXML Typst' },
      ],
      cronSchedule: '0 18:00 * * 5',
      cronDetail: 'Еженедельная пятничная сверка баланса дебета и кредита',
      zeroHallucinationChecks: ['ZERO_INVOICE_GUESS', 'MATH_SANDBOX_1:1', 'TAX_REGISTRY_STRICT', 'AUDIT_TRAIL_SHA256'],
      simulationTrace: [
        { time: '18:00:00', action: 'Пятничный триггер шедулера', detail: 'Старт сверки дебета и кредита за рабочую неделю', tag: 'WEEKLY_CRON' },
        { time: '18:00:04', action: 'Импорт выписок Клиент-Банк', detail: 'Обработано 184 транзакции, сверка со сметой Excel 1:1', tag: 'BANK_AUDIT' },
        { time: '18:00:06', action: 'Проверка Strict Grounding', detail: '0% домыслов: все суммы сопоставлены с накладными', tag: 'ZERO_GUESS' },
        { time: '18:00:08', action: 'Сборка реестра PDF', detail: 'Сформирован закрывающий акт сверки с хешем SHA-256', tag: 'PDF_GEN' },
      ],
    },
    {
      id: 'service',
      label: 'Клиники & Сервис',
      prompt: 'Джарвис для клиники: запись пациентов 24/7, ведение расписания врачей и напоминания о визитах',
      jarvisName: 'Jarvis Clinic Care',
      roleSummary: 'Сервисный координатор: запись на прием, интеграция с МИС и напоминания клиентам',
      agents: ['Patient Intake Desk', 'Doctor Schedule Solver', 'SMS/TG Reminder Bot'],
      connectors: [
        { name: 'Telegram & Web Widget', type: 'Client Intake' },
        { name: 'Внутренняя МИС / API', type: 'REST Webhook' },
        { name: 'Task-Reminders', type: 'Cloud Cron' },
      ],
      cronSchedule: 'Every 15 min',
      cronDetail: 'Автоматические напоминания за 24 часа до визита',
      zeroHallucinationChecks: ['SLOT_CONFLICT_GUARD', 'STRICT_DOCTOR_SPECIALTY', 'POLICY_FIREWALL', 'DOUBLE_CONFIRM_GATE'],
      simulationTrace: [
        { time: '11:05:01', action: 'Запрос пациента в виджете', detail: '«Нужно записаться к кардиологу на четверг после 15:00»', tag: 'WIDGET_INTAKE' },
        { time: '11:05:02', action: 'Проверка слотов в МИС API', detail: 'Поиск окна без овербукинга: четверг 16:30 подтвержден', tag: 'MIS_CHECK' },
        { time: '11:05:03', action: 'Фиксация брони в БД', detail: 'Талон выписан, инструкция по подготовке отправлена', tag: 'BOOKING_LOCKED' },
        { time: '11:05:04', action: 'Шедулер напоминания (Cron)', detail: 'Поставлено SMS-напоминание пациенту в среду в 16:30', tag: 'CRON_REMINDER' },
      ],
    },
  ],
  uz: [
    {
      id: 'wholesale',
      label: 'Ulgurji & 1C Ombor',
      prompt: 'Ulgurji savdo uchun Jarvis: 1C qoldiqlarini kuzatish, Telegramda buyurtma olish va tonggi narxlar auditini yuborish',
      jarvisName: 'Jarvis Ops & Supply Core',
      roleSummary: 'Bosh operatsion Jarvis: 1C nazorati, tovar hisobi va taʼminotni muvofiqlashtirish',
      agents: ['1C Ombor tahlilchisi', 'Telegram Buyurtmalar Boti', 'Moliya auditori'],
      connectors: [
        { name: '1C:Korxona', type: 'REST OData' },
        { name: 'Telegram Bot', type: 'Two-Way Mesh' },
        { name: 'Google Jadvallar', type: 'Live Sync' },
      ],
      cronSchedule: '0 08:30 * * 1-5',
      cronDetail: 'Tonggi narxlar va qoldiqlar avtonom auditi',
      zeroHallucinationChecks: ['ZOD_SCHEMA_STRICT', 'NO_GUESS_ABSTAIN', 'WASM_PRICE_SANDBOX', 'SUPERVISOR_AUDIT'],
      simulationTrace: [
        { time: '08:30:00', action: 'Cron bo‘yicha avtonom ishga tushish', detail: 'Agent 1C qoldiqlari auditini o‘zi boshladi', tag: 'CRON_TRIGGER' },
        { time: '08:30:02', action: '1C OData ikki tomonlama so‘rov', detail: '1 420 tovar tekshirildi, 3 ta tafovut topildi', tag: '1C_ODATA' },
        { time: '08:30:03', action: 'WASM qumloqda aniq hisob', detail: 'Ulgurji marja kodi orqali nol-gallyutsinatsiya bilan hisoblandi', tag: 'WASM_MATH' },
        { time: '08:30:05', action: 'Telegram hisobot yuborildi', detail: 'Rahbarga tasdiqlash tugmasi bilan audit yuborildi', tag: 'TG_DISPATCH' },
      ],
    },
    {
      id: 'b2b',
      label: 'B2B Savdo & CRM',
      prompt: 'B2B savdo uchun Jarvis: WhatsAppda tezkor javob, BANT saralash va Taqvimga uchrashuv belgilash',
      jarvisName: 'Jarvis Revenue Copilot',
      roleSummary: '24/7 lid-koordinator: arizalarni saralash, skoring va CRM tizimida vazifa qo‘yish',
      agents: ['SDR Saralovchi', 'Uchrashuv rejalovchi', 'CRM Sinxronlash boti'],
      connectors: [
        { name: 'WhatsApp Business', type: 'Cloud API' },
        { name: 'amoCRM', type: 'Bi-directional' },
        { name: 'Google Taqvim', type: 'OAuth Slotting' },
      ],
      cronSchedule: '+48 soat (avto)',
      cronDetail: 'Menejer ishtirokisiz avtonom follow-up vazifasi',
      zeroHallucinationChecks: ['PRICING_GROUNDED', 'STRICT_FEATURE_LIST', 'CALENDAR_DETERMINISTIC', 'OWNER_NOTIFY_GATE'],
      simulationTrace: [
        { time: '14:22:10', action: 'WhatsApp orqali murojaat', detail: 'Mijoz 50 kishilik tarif bo‘yicha tijoriy taklif so‘radi', tag: 'INBOUND_WHATSAPP' },
        { time: '14:22:12', action: 'BANT baholash va bilimlar bazasi', detail: 'Agent tarifni RAG orqali tekshirib, lidni A darajaga kiritdi', tag: 'BANT_SCORING' },
        { time: '14:22:14', action: 'amoCRM va Taqvim yangilandi', detail: 'Bitim ochildi, Savdo direktori bilan Zoom vaqti belgilandi', tag: 'CRM_TWO_WAY' },
        { time: '14:22:15', action: 'Avtonom Cron vazifasi', detail: '48 soatdan keyin qayta aloqa qilish rejaga qo‘yildi', tag: 'CRON_SCHEDULE' },
      ],
    },
    {
      id: 'finance',
      label: 'Moliya & Bank',
      prompt: 'Moliya uchun Jarvis: bank ko‘chirmalarini schyotlar bilan solishtirish va solishtirma dalolatnomalar yig‘ish',
      jarvisName: 'Jarvis Treasury & Legal',
      roleSummary: 'Moliyaviy nazoratchi: qarzdorlik monitoringi, schyotlar auditi va PDF dalolatnomalar',
      agents: ['Bank tekshiruvchisi', 'Math Sandbox Solver', 'Hujjatlar yig‘uvchisi'],
      connectors: [
        { name: 'Bank Klient API', type: 'Fin Connector' },
        { name: 'MS Excel (OneDrive)', type: 'Auto-Fetch' },
        { name: 'PDF Core Engine', type: 'OOXML Typst' },
      ],
      cronSchedule: '0 18:00 * * 5',
      cronDetail: 'Juma kungi debet va kredit mutanosibligi auditi',
      zeroHallucinationChecks: ['ZERO_INVOICE_GUESS', 'MATH_SANDBOX_1:1', 'TAX_REGISTRY_STRICT', 'AUDIT_TRAIL_SHA256'],
      simulationTrace: [
        { time: '18:00:00', action: 'Juma kungi cron ishga tushdi', detail: 'Haftalik debet va kredit solishtirmasi boshlandi', tag: 'WEEKLY_CRON' },
        { time: '18:00:04', action: 'Bank ko‘chirmalari yuklandi', detail: '184 ta to‘lov Excel smetasi bilan 1:1 solishtirildi', tag: 'BANK_AUDIT' },
        { time: '18:00:06', action: 'Strict Grounding tekshiruvi', detail: 'Nol-taxmin: barcha summalar birlamchi schyotlarga bog‘landi', tag: 'ZERO_GUESS' },
        { time: '18:00:08', action: 'PDF dalolatnoma yig‘ildi', detail: 'SHA-256 xeshi bilan solishtirma dalolatnoma tayyorlandi', tag: 'PDF_GEN' },
      ],
    },
    {
      id: 'service',
      label: 'Klinika & Xizmat',
      prompt: 'Klinika uchun Jarvis: bemorlarni 24/7 qabulga yozish, shifokorlar jadvalini yuritish va eslatma yuborish',
      jarvisName: 'Jarvis Clinic Care',
      roleSummary: 'Xizmat koordinatori: qabulga yozish, MIS integratsiyasi va mijozlarga eslatmalar',
      agents: ['Bemorlar registratori', 'Shifokorlar jadvali boti', 'SMS/TG Eslatma boti'],
      connectors: [
        { name: 'Telegram va Sayt vidjeti', type: 'Client Intake' },
        { name: 'Ichki MIS / API', type: 'REST Webhook' },
        { name: 'Task-Reminders', type: 'Cloud Cron' },
      ],
      cronSchedule: 'Har 15 daqiqada',
      cronDetail: 'Qabuldan 24 soat oldin avtomatik eslatma',
      zeroHallucinationChecks: ['SLOT_CONFLICT_GUARD', 'STRICT_DOCTOR_SPECIALTY', 'POLICY_FIREWALL', 'DOUBLE_CONFIRM_GATE'],
      simulationTrace: [
        { time: '11:05:01', action: 'Vidjetda bemor arizasi', detail: '«Payshanba kuni soat 15:00 dan keyin kardiolog qabuliga yozing»', tag: 'WIDGET_INTAKE' },
        { time: '11:05:02', action: 'MIS tizimida bo‘sh vaqt', detail: 'Konfliktsiz vaqt: payshanba 16:30 band qilindi', tag: 'MIS_CHECK' },
        { time: '11:05:03', action: 'Maʼlumotlar bazasida tasdiq', detail: 'Talon ochildi, qabulga tayyorgarlik ko‘rsatmasi yuborildi', tag: 'BOOKING_LOCKED' },
        { time: '11:05:04', action: 'Eslatma vazifasi (Cron)', detail: 'Chorshanba 16:30 da SMS yuborish rejaga qo‘yildi', tag: 'CRON_REMINDER' },
      ],
    },
  ],
  en: [
    {
      id: 'wholesale',
      label: 'Wholesale & 1C ERP',
      prompt: 'Jarvis for wholesale supply: track 1C inventory, accept Telegram B2B orders, and send morning margin briefings',
      jarvisName: 'Jarvis Ops & Supply Core',
      roleSummary: 'Chief Operating Jarvis: 1C inventory sync, order dispatch, and supply chain coordination',
      agents: ['1C Inventory Analyst', 'Telegram Order Desk', 'Finance Auditor'],
      connectors: [
        { name: '1C:Enterprise', type: 'REST OData' },
        { name: 'Telegram Bot', type: 'Two-Way Mesh' },
        { name: 'Google Sheets', type: 'Live Sync' },
      ],
      cronSchedule: '0 08:30 * * 1-5',
      cronDetail: 'Autonomous morning inventory variance & price audit',
      zeroHallucinationChecks: ['ZOD_SCHEMA_STRICT', 'NO_GUESS_ABSTAIN', 'WASM_PRICE_SANDBOX', 'SUPERVISOR_AUDIT'],
      simulationTrace: [
        { time: '08:30:00', action: 'Self-Scheduled Cron Trigger', detail: 'Agent autonomously triggered morning 1C inventory audit', tag: 'CRON_TRIGGER' },
        { time: '08:30:02', action: 'Bi-directional OData Query', detail: '1,420 SKUs parsed, 3 pricing variances flagged', tag: '1C_ODATA' },
        { time: '08:30:03', action: 'WASM Execution Sandbox', detail: 'Deterministic margin calculation via isolated WebAssembly', tag: 'WASM_MATH' },
        { time: '08:30:05', action: 'Executive Telegram Briefing', detail: 'Digest delivered to COO with single-tap approval button', tag: 'TG_DISPATCH' },
      ],
    },
    {
      id: 'b2b',
      label: 'B2B Sales & CRM',
      prompt: 'Jarvis for B2B pipeline: instant WhatsApp replies, BANT qualification, and Google Calendar demo booking',
      jarvisName: 'Jarvis Revenue Copilot',
      roleSummary: '24/7 Inbound Chief: lead qualification, BANT scoring, and CRM pipeline assignment',
      agents: ['SDR Qualifier', 'Meeting Booker', 'CRM Synchronization Bot'],
      connectors: [
        { name: 'WhatsApp Business', type: 'Cloud API' },
        { name: 'amoCRM', type: 'Bi-directional' },
        { name: 'Google Calendar', type: 'OAuth Slotting' },
      ],
      cronSchedule: '+48 hours (auto)',
      cronDetail: 'Autonomous lead follow-up task queued without sales rep intervention',
      zeroHallucinationChecks: ['PRICING_GROUNDED', 'STRICT_FEATURE_LIST', 'CALENDAR_DETERMINISTIC', 'OWNER_NOTIFY_GATE'],
      simulationTrace: [
        { time: '14:22:10', action: 'Inbound WhatsApp Inquiry', detail: 'Prospect requested 50-seat corporate pricing package', tag: 'INBOUND_WHATSAPP' },
        { time: '14:22:12', action: 'BANT Scoring & Knowledge RAG', detail: 'Pricing verified against verified deck, classified Tier-A Lead', tag: 'BANT_SCORING' },
        { time: '14:22:14', action: 'amoCRM & Calendar Sync', detail: 'Deal created, Zoom demo scheduled with Sales Director', tag: 'CRM_TWO_WAY' },
        { time: '14:22:15', action: 'Autonomous Follow-up Cron', detail: 'Follow-up queued in task engine for exactly 48 hours later', tag: 'CRON_SCHEDULE' },
      ],
    },
    {
      id: 'finance',
      label: 'Finance & Bank',
      prompt: 'Jarvis for corporate finance: reconcile bank statements with invoices, check cashflow gaps, and compile statements',
      jarvisName: 'Jarvis Treasury & Legal',
      roleSummary: 'Treasury Controller: receivables tracking, invoice parity, and typed PDF statements',
      agents: ['Bank Statement Verifier', 'Math Sandbox Solver', 'Contract Doc Builder'],
      connectors: [
        { name: 'Banking API', type: 'Fin Connector' },
        { name: 'MS Excel (OneDrive)', type: 'Auto-Fetch' },
        { name: 'PDF Core Engine', type: 'OOXML Typst' },
      ],
      cronSchedule: '0 18:00 * * 5',
      cronDetail: 'Autonomous Friday double-entry debit/credit ledger balance',
      zeroHallucinationChecks: ['ZERO_INVOICE_GUESS', 'MATH_SANDBOX_1:1', 'TAX_REGISTRY_STRICT', 'AUDIT_TRAIL_SHA256'],
      simulationTrace: [
        { time: '18:00:00', action: 'Friday Reconciliation Trigger', detail: 'Weekly automated debit/credit balancing cycle initiated', tag: 'WEEKLY_CRON' },
        { time: '18:00:04', action: 'Bank Statement Ingestion', detail: '184 transactions parsed and verified against budget 1:1', tag: 'BANK_AUDIT' },
        { time: '18:00:06', action: 'Strict Grounding & Abstention', detail: 'Zero guesswork: every line item mapped to invoice registry', tag: 'ZERO_GUESS' },
        { time: '18:00:08', action: 'PDF Audit Package Generation', detail: 'Weekly closing statement generated with SHA-256 integrity hash', tag: 'PDF_GEN' },
      ],
    },
    {
      id: 'service',
      label: 'Clinics & Care',
      prompt: 'Jarvis for medical clinics: 24/7 patient booking, doctor schedule sync, and automated visit reminders',
      jarvisName: 'Jarvis Clinic Care',
      roleSummary: 'Care Coordinator: appointment booking, EHR/MIS integration, and patient reminder workflows',
      agents: ['Patient Intake Desk', 'Doctor Schedule Solver', 'SMS/TG Reminder Bot'],
      connectors: [
        { name: 'Telegram & Web Widget', type: 'Client Intake' },
        { name: 'Internal EHR / API', type: 'REST Webhook' },
        { name: 'Task-Reminders', type: 'Cloud Cron' },
      ],
      cronSchedule: 'Every 15 min',
      cronDetail: 'Autonomous 24h pre-visit notification cron',
      zeroHallucinationChecks: ['SLOT_CONFLICT_GUARD', 'STRICT_DOCTOR_SPECIALTY', 'POLICY_FIREWALL', 'DOUBLE_CONFIRM_GATE'],
      simulationTrace: [
        { time: '11:05:01', action: 'Patient Intake via Web Widget', detail: 'Booking request: Cardiologist consultation, Thursday after 3 PM', tag: 'WIDGET_INTAKE' },
        { time: '11:05:02', action: 'EHR Slot Availability Check', detail: 'Conflict-free slot found: Thursday 4:30 PM locked in database', tag: 'MIS_CHECK' },
        { time: '11:05:03', action: 'Appointment Finalized', detail: 'Ticket issued, preparation instructions sent to patient', tag: 'BOOKING_LOCKED' },
        { time: '11:05:04', action: 'Pre-visit Cron Notification', detail: 'SMS reminder scheduled for Wednesday 4:30 PM (24h before)', tag: 'CRON_REMINDER' },
      ],
    },
  ],
}

export function HeroInteractiveShowcase({ lang = 'ru' }: { lang?: 'ru' | 'uz' | 'en' }) {
  const presets = presetsByLang[lang] ?? presetsByLang.ru
  const [activePresetIndex, setActivePresetIndex] = useState(0)
  const [customPrompt, setCustomPrompt] = useState(presets[0].prompt)
  const [isComposing, setIsComposing] = useState(false)
  const [viewMode, setViewMode] = useState<'architecture' | 'simulation' | 'manifest'>('architecture')
  const [copiedManifest, setCopiedManifest] = useState(false)

  const activeJarvis = presets[activePresetIndex] ?? presets[0]

  const handleSelectPreset = (index: number) => {
    setActivePresetIndex(index)
    setCustomPrompt(presets[index].prompt)
    triggerComposeAnimation()
  }

  const triggerComposeAnimation = () => {
    setIsComposing(true)
    setTimeout(() => setIsComposing(false), 500)
  }

  const handleSubmitCustom = (e: React.FormEvent) => {
    e.preventDefault()
    if (!customPrompt.trim()) return

    // Find closest preset or synthesize from keywords
    const lower = customPrompt.toLowerCase()
    let matchIdx = 0
    if (lower.includes('b2b') || lower.includes('crm') || lower.includes('whatsapp') || lower.includes('продаж') || lower.includes('savdo')) {
      matchIdx = 1
    } else if (lower.includes('банк') || lower.includes('финанс') || lower.includes('moliya') || lower.includes('счет') || lower.includes('akt')) {
      matchIdx = 2
    } else if (lower.includes('клиник') || lower.includes('klinika') || lower.includes('врач') || lower.includes('визит')) {
      matchIdx = 3
    }

    setActivePresetIndex(matchIdx)
    triggerComposeAnimation()
  }

  const handleCopyManifest = () => {
    const jsonManifest = JSON.stringify({
      version: '2026.09',
      target: 'nemo.cloud.runtime',
      jarvis_id: activeJarvis.id,
      chief_of_staff: activeJarvis.jarvisName,
      subagents: activeJarvis.agents,
      connectors: activeJarvis.connectors.map(c => `${c.name} (${c.type})`),
      autonomous_cron: {
        pattern: activeJarvis.cronSchedule,
        task: activeJarvis.cronDetail,
      },
      zero_hallucination_guard: activeJarvis.zeroHallucinationChecks,
    }, null, 2)
    void navigator.clipboard?.writeText(jsonManifest)
    setCopiedManifest(true)
    setTimeout(() => setCopiedManifest(false), 2000)
  }

  return (
    <div className="relative mx-auto w-full max-w-[580px]">
      {/* Dynamic ambient backlight */}
      <div className="pointer-events-none absolute -inset-3 rounded-3xl bg-gradient-to-tr from-[#42edf5]/15 via-[#8B7CF8]/10 to-[#10B981]/15 blur-2xl opacity-70" />

      {/* Main Console Surface */}
      <div className="relative overflow-hidden rounded-2xl border border-white/12 bg-[#090D1C] shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)]">
        {/* Top Telemetry Header */}
        <div className="flex items-center justify-between border-b border-white/8 bg-[#0D1429] px-4 py-2.5">
          <div className="flex items-center gap-3">
            {/* Studio brand emblem — required for landing-brand-smoke.mjs */}
            <img
              src="/brand/nemo-emblem-studio-v2.webp"
              alt="Nemo AI"
              width="1448"
              height="1086"
              fetchPriority="high"
              className="h-7 w-auto rounded-md border border-[#42edf5]/30 object-cover"
            />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold tracking-tight text-white">Nemo One-Prompt Jarvis</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981]/15 px-2 py-0.2 text-[10px] font-semibold text-[#34D399]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#10B981] animate-pulse" />
                  Instant Composer
                </span>
              </div>
              <p className="text-[10px] text-[#94A3B8]">
                {lang === 'uz'
                  ? 'Bitta promt orqali kompaniya uchun avtonom Jarvis'
                  : lang === 'ru'
                  ? 'Соберите личного Джарвиса для бизнеса по одному промпту'
                  : 'Build an autonomous enterprise Jarvis from 1 prompt'}
              </p>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-1 text-[10px] font-mono text-[#42edf5] bg-[#42edf5]/10 px-2 py-0.5 rounded border border-[#42edf5]/20">
            <Sparkles size={11} />
            <span>PR Showcase</span>
          </div>
        </div>

        <div className="p-4 sm:p-5 space-y-3">
          {/* Quick Preset Chips for PR demo */}
          <div className="flex flex-wrap gap-1.5">
            {presets.map((preset, idx) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(idx)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors truncate',
                  activePresetIndex === idx
                    ? 'bg-[#182346] text-[#42edf5] border border-[#42edf5]/40 shadow-sm'
                    : 'bg-[#0F172A]/70 text-[#94A3B8] border border-white/6 hover:text-white hover:bg-white/5'
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Interactive One-Prompt Input Bar */}
          <form onSubmit={handleSubmitCustom} className="relative flex items-center">
            <input
              type="text"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder={
                lang === 'uz'
                  ? 'Kompaniyangiz uchun vazifani yozing...'
                  : lang === 'ru'
                  ? 'Опишите задачу: "Джарвис для 1С, опта и утренних отчетов"...'
                  : 'Describe your company task: "Jarvis for 1C, wholesale and morning briefing"...'
              }
              className="w-full rounded-xl border border-white/10 bg-[#060813] px-3.5 py-2 pr-24 text-xs text-white placeholder:text-[#64748B] focus:border-[#42edf5]/50 focus:outline-none focus:ring-1 focus:ring-[#42edf5]/50"
            />
            <button
              type="submit"
              disabled={isComposing}
              className="absolute right-1.5 inline-flex items-center gap-1 rounded-lg bg-[#42edf5] px-2.5 py-1 text-[10px] font-bold text-[#050816] hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {isComposing ? (
                <Sparkles size={11} className="animate-spin" />
              ) : (
                <Send size={11} />
              )}
              <span>{lang === 'uz' ? 'Yig‘ish' : lang === 'ru' ? 'Собрать' : 'Compose'}</span>
            </button>
          </form>

          {/* View Mode Switcher: Architecture | Cloud Simulation | Manifest */}
          <div className="flex items-center justify-between border-t border-white/6 pt-2 text-[10px]">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setViewMode('architecture')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold transition-colors',
                  viewMode === 'architecture'
                    ? 'bg-[#182346] text-[#42edf5] border border-[#42edf5]/40'
                    : 'text-[#94A3B8] hover:text-white'
                )}
              >
                <Layers size={11} />
                <span>{lang === 'uz' ? 'Arxitektura' : lang === 'ru' ? 'Архитектура' : 'Architecture'}</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('simulation')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold transition-colors',
                  viewMode === 'simulation'
                    ? 'bg-[#182346] text-[#42edf5] border border-[#42edf5]/40'
                    : 'text-[#94A3B8] hover:text-white'
                )}
              >
                <PlayCircle size={11} />
                <span>{lang === 'uz' ? 'Bulutli simulyatsiya' : lang === 'ru' ? 'Симуляция в облаке' : 'Cloud Trace'}</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('manifest')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold transition-colors',
                  viewMode === 'manifest'
                    ? 'bg-[#182346] text-[#42edf5] border border-[#42edf5]/40'
                    : 'text-[#94A3B8] hover:text-white'
                )}
              >
                <Code2 size={11} />
                <span>{lang === 'uz' ? 'Manifest JSON' : lang === 'ru' ? 'Манифест JSON' : 'Manifest'}</span>
              </button>
            </div>
            {viewMode === 'manifest' && (
              <button
                type="button"
                onClick={handleCopyManifest}
                className="inline-flex items-center gap-1 text-[9px] font-mono text-[#42edf5] hover:underline"
              >
                {copiedManifest ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                <span>
                  {copiedManifest
                    ? (lang === 'uz' ? 'Nusxalandi' : lang === 'ru' ? 'Скопировано' : 'Copied')
                    : (lang === 'uz' ? 'Nusxa olish' : lang === 'ru' ? 'Копировать' : 'Copy')}
                </span>
              </button>
            )}
          </div>

          {/* Assembled Jarvis Output Surface */}
          <div className={cn('space-y-2.5 transition-opacity duration-300', isComposing ? 'opacity-40' : 'opacity-100')}>
            {viewMode === 'architecture' && (
              <>
                {/* Header: Jarvis Identity & Role */}
                <div className="rounded-xl border border-[#42edf5]/25 bg-[#091226] p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#42edf5]/15 border border-[#42edf5]/30">
                        <Cpu size={15} className="text-[#42edf5]" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-white">{activeJarvis.jarvisName}</h4>
                        <p className="text-[10px] text-[#94A3B8] leading-tight">{activeJarvis.roleSummary}</p>
                      </div>
                    </div>
                    <span className="font-mono text-[9px] text-[#42edf5] bg-[#42edf5]/10 px-2 py-0.5 rounded border border-[#42edf5]/20">
                      CHIEF OF STAFF
                    </span>
                  </div>

                  {/* Sub-agents team */}
                  <div className="mt-2.5 flex items-center gap-1.5 flex-wrap border-t border-white/6 pt-2">
                    <span className="text-[10px] font-medium text-[#94A3B8] flex items-center gap-1">
                      <Users size={11} className="text-[#42edf5]" />
                      {lang === 'uz' ? 'Jamoa:' : lang === 'ru' ? 'Субагенты:' : 'Team Swarm:'}
                    </span>
                    {activeJarvis.agents.map((agent) => (
                      <span
                        key={agent}
                        className="inline-flex items-center gap-1 rounded bg-[#101A36] px-2 py-0.5 text-[10px] font-medium text-white border border-white/10"
                      >
                        <span className="h-1 w-1 rounded-full bg-[#10B981]" />
                        {agent}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Two-Way Connectors + Auto-Scheduler Bar */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                  {/* Connectors */}
                  <div className="rounded-xl bg-[#0F172A]/70 p-2.5 border border-white/6">
                    <div className="flex items-center justify-between text-[10px] text-[#94A3B8] font-bold uppercase tracking-wider">
                      <span className="flex items-center gap-1">
                        <ArrowLeftRight size={11} className="text-[#42edf5]" />
                        {lang === 'uz' ? '2-Tomonlama integratsiya' : lang === 'ru' ? 'Двусторонние коннекторы' : 'Two-Way Connectors'}
                      </span>
                      <span className="text-[#10B981] font-mono text-[9px]">LIVE</span>
                    </div>
                    <div className="mt-1.5 space-y-1">
                      {activeJarvis.connectors.map((c) => (
                        <div key={c.name} className="flex items-center justify-between text-[10px]">
                          <span className="text-white font-medium">{c.name}</span>
                          <span className="font-mono text-[9px] text-[#94A3B8] bg-[#1E293B] px-1.5 py-0.2 rounded">
                            {c.type}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Scheduled Cron Task */}
                  <div className="rounded-xl bg-[#0F172A]/70 p-2.5 border border-white/6 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between text-[10px] text-[#94A3B8] font-bold uppercase tracking-wider">
                        <span className="flex items-center gap-1">
                          <CalendarClock size={11} className="text-[#42edf5]" />
                          {lang === 'uz' ? 'Avtonom reja (Cron)' : lang === 'ru' ? 'Автономная задача (Cron)' : 'Self-Scheduled Cron'}
                        </span>
                        <span className="text-[#42edf5] font-mono text-[9px]">{activeJarvis.cronSchedule}</span>
                      </div>
                      <p className="mt-1.5 text-[10px] text-white leading-snug">
                        {activeJarvis.cronDetail}
                      </p>
                    </div>
                    <div className="mt-2 flex items-center justify-between pt-1 border-t border-white/6 text-[9px] font-mono text-[#34D399]">
                      <span>{lang === 'uz' ? 'Avtonom 24/7' : lang === 'ru' ? 'Поставлена агентом' : 'Self-scheduled'}</span>
                      <span>QUEUE ACTIVE</span>
                    </div>
                  </div>
                </div>
              </>
            )}

            {viewMode === 'simulation' && (
              <div className="space-y-1.5 rounded-xl bg-[#060A16] p-2.5 border border-white/8">
                <div className="flex items-center justify-between text-[10px] text-[#94A3B8] font-mono border-b border-white/6 pb-1">
                  <span>LIVE CLOUD RUNTIME</span>
                  <span className="text-[#34D399] flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#10B981] animate-pulse" />
                    AUTONOMOUS
                  </span>
                </div>
                <div className="space-y-1.5 pt-1">
                  {activeJarvis.simulationTrace.map((step, sIdx) => (
                    <div key={sIdx} className="flex items-start gap-2 text-[10px] bg-white/[0.02] p-1.5 rounded-lg border border-white/5">
                      <span className="font-mono text-[#64748B] text-[9px] mt-0.5 shrink-0">{step.time}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <p className="font-semibold text-white truncate text-[10px]">{step.action}</p>
                          <span className="font-mono text-[8px] text-[#42edf5] bg-[#42edf5]/10 px-1.5 py-0.2 rounded shrink-0">
                            {step.tag}
                          </span>
                        </div>
                        <p className="text-[#94A3B8] text-[9px] mt-0.5 leading-snug">{step.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {viewMode === 'manifest' && (
              <div className="rounded-xl bg-[#04060E] p-2.5 border border-white/8 font-mono text-[9px] text-[#93C5FD] max-h-[175px] overflow-y-auto leading-relaxed">
                <pre className="whitespace-pre-wrap">
                  {JSON.stringify(
                    {
                      version: '2026.09',
                      target: 'nemo.cloud.runtime',
                      jarvis_id: activeJarvis.id,
                      chief_of_staff: activeJarvis.jarvisName,
                      subagents: activeJarvis.agents,
                      connectors: activeJarvis.connectors.map((c) => `${c.name} (${c.type})`),
                      autonomous_cron: {
                        pattern: activeJarvis.cronSchedule,
                        task: activeJarvis.cronDetail,
                      },
                      zero_hallucination_guard: activeJarvis.zeroHallucinationChecks,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            )}

            {/* Zero-Hallucination Verified Badge & Signup Handoff */}
            <div className="rounded-xl border border-[#10B981]/30 bg-[#061814]/80 p-2.5 flex items-center justify-between gap-3">
              <div className="truncate">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck size={12} className="text-[#34D399]" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#34D399]">
                    {lang === 'uz' ? 'Nol-Gallyutsinatsiya Kafolati' : lang === 'ru' ? 'Стек защиты от галлюцинаций' : 'Zero-Hallucination Certified'}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-[#CBD5E1] truncate">
                  {activeJarvis.zeroHallucinationChecks.join(' · ')}
                </p>
              </div>
              <Link
                to="/auth/signup"
                className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-[#10B981]/20 px-2.5 py-1 text-[10px] font-bold text-[#6EE7B7] border border-[#10B981]/40 hover:bg-[#10B981]/30 transition-colors"
              >
                <span>{lang === 'uz' ? 'Ishga tushirish' : lang === 'ru' ? 'Запустить' : 'Launch'}</span>
                <ArrowRight size={11} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
