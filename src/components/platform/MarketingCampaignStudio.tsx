import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  WandSparkles,
} from 'lucide-react'
import { useI18n } from '../../i18n'
import type { Lang } from '../../types'
import { cn } from '../../lib/cn'
import { getAccessToken, isSupabaseEnabled, supabase } from '../../lib/supabase'
import { Button } from '../ui/Button'
import {
  BrandKitSchema,
  MarketingOutputSchema,
  VISUAL_PRESETS,
  type BrandKit,
  type MarketingOutput,
} from '../../../supabase/functions/_shared/marketingCampaign'

type Format = 'short_video' | 'carousel' | 'post'
type Goal = 'lead_gen' | 'reach' | 'sales' | 'expert_authority'
type Preset = keyof typeof VISUAL_PRESETS

const FORMAT_CONFIG: Record<Format, { platform: 'reels' | 'instagram_carousel' | 'telegram'; ratio: '9:16' | '4:5' | '1:1' }> = {
  short_video: { platform: 'reels', ratio: '9:16' },
  carousel: { platform: 'instagram_carousel', ratio: '4:5' },
  post: { platform: 'telegram', ratio: '1:1' },
}

const PREVIEW_BRAND: BrandKit = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Nemo Preview',
  colors: ['#06B6D4', '#6366F1'],
  fonts: { heading: 'Manrope', body: 'Inter' },
  tone_of_voice: 'Конкретно, уверенно и без рекламных клише.',
  stop_words: ['революционный', 'лучший на рынке'],
  visual_preset: 'minimal_tech_ui',
  custom_visual_rules: '',
}

const PREVIEW_CAMPAIGN: MarketingOutput = {
  audit: {
    target_segment: 'Владельцы малого бизнеса, которые вручную координируют маркетинг и продажи',
    angle: 'Показать стоимость потерянного времени через один конкретный рабочий сценарий',
    core_pain: 'Задачи распределены между чатами, таблицами и подрядчиками — статус приходится собирать вручную',
  },
  hooks: [
    { id: 'preview-provocation', type: 'provocation', text: 'Если маркетинг держится на ваших напоминаниях — это не система.', rationale: 'Сразу называет операционную проблему владельца.' },
    { id: 'preview-mistake', type: 'mistake', text: 'Главная ошибка — автоматизировать публикацию до того, как собран процесс согласования.', rationale: 'Разворачивает привычный порядок действий.' },
    { id: 'preview-case', type: 'case_study', text: 'Разберём путь: бриф → сценарий → визуал → согласование в одном окне.', rationale: 'Показывает проверяемый процесс без выдуманных цифр.' },
  ],
  timeline: [
    { step: 1, timestamp_or_slide: '00:00–00:03', visual_description: 'Крупный план: пять открытых рабочих чатов, курсор переключается между ними', script_text: 'Сколько вкладок нужно открыть, чтобы понять статус одной кампании?', on_screen_text: '5 вкладок. 1 задача.' },
    { step: 2, timestamp_or_slide: '00:03–00:08', visual_description: 'Чистый интерфейс Nemo: бриф раскладывается на три последовательных шага', script_text: 'Контент-стратег собирает бриф, варианты хуков и сценарий в одной структуре.', on_screen_text: 'Бриф → хуки → сценарий' },
    { step: 3, timestamp_or_slide: '00:08–00:14', visual_description: 'Storyboard с выделенным кадром и карточкой визуального промпта', script_text: 'Каждый кадр связан с текстом и точным visual prompt — без потери контекста.', on_screen_text: 'Один контекст для команды' },
  ],
  cta: { action_type: 'open_campaign', copy: 'Соберите первый сценарий под свой Brand Kit.' },
  visual_spec: {
    prompt: 'Premium SaaS workspace showing a structured content workflow, clean editorial composition, cyan accent, precise interface details, soft daylight',
    negative_prompt: 'fake metrics, illegible text, excessive glow, stock photo posing, watermark',
    recommended_ratio: '9:16',
    style_preset: 'minimal_tech_ui',
  },
}

const COPY: Record<Lang, Record<string, string>> = {
  ru: {
    eyebrow: 'Marketing engine 2.0', title: 'Контент-стратег', subtitle: 'От брифа до сценария и visual prompt — в структуре, готовой для команды.',
    brandKit: 'Brand Kit', tone: 'Tone of Voice', format: 'Формат', short_video: 'Reels / Shorts', carousel: 'Карусель', post: 'Пост',
    topic: 'Что нужно продвигать?', topicPh: 'Например: новый тариф для малого бизнеса, запуск курса или сезонная акция', context: 'Контекст и подтверждённые факты', contextPh: 'Преимущества, ограничения, цены и факты, которые можно использовать. Ничего не будет додумано.',
    goal: 'Цель', lead_gen: 'Лиды', reach: 'Охват', sales: 'Продажи', expert_authority: 'Экспертность', generate: 'Собрать кампанию', generating: 'Собираем стратегию',
    preview: 'Демо-превью · не сгенерировано', liveResult: 'Результат OpenRouter', audit: 'Стратегический фокус', audience: 'Сегмент', angle: 'Угол', pain: 'Боль',
    hooks: 'Выберите хук', hookHint: 'Активный вариант войдёт в рабочий сценарий.', provocation: 'Провокация', mistake: 'Ошибка', case_study: 'Кейс', copied: 'Скопировано', copy: 'Копировать',
    storyboard: 'Storyboard', storyboardHint: 'Покадровый сценарий с B-roll и текстом.', scene: 'Сцена', timing: 'Таймкод / слайд', visual: 'Визуал / B-roll', voice: 'Озвучка', onScreen: 'На экране',
    visualStudio: 'Visual Studio', visualHint: 'Промпт готов для генерации изображения.', preset: 'Стиль', prompt: 'Точный prompt', negative: 'Исключить', regenerate: 'Создать изображение', regenerating: 'Создаём изображение', noImage: 'Изображение ещё не создано', promptReady: 'Prompt ready', ratio: 'Формат',
    cta: 'Призыв к действию', emptyTitle: 'Начните с короткого брифа', emptyText: 'Выберите Brand Kit и формат. Движок вернёт три хука, storyboard и visual prompt по строгой схеме.',
    noBrandTitle: 'Нужен Brand Kit', noBrandText: 'Создайте первый набор: название, Tone of Voice, цвета и визуальный стиль.', newBrand: 'Новый Brand Kit', createBrand: 'Сохранить Brand Kit', cancel: 'Отмена', brandName: 'Название', brandNamePh: 'Например: Nemo Product', brandTonePh: 'Как бренд говорит с аудиторией', stopWords: 'Стоп-слова через запятую', primaryColor: 'Основной цвет', accentColor: 'Акцент',
    loadError: 'Не удалось загрузить Brand Kits.', createError: 'Не удалось сохранить Brand Kit.', generateError: 'Кампания не сгенерирована. Проверьте подключение и лимит токенов.', imageError: 'Изображение не создано. Проверьте подключённый media provider.', liveOnly: 'Генерация доступна после подключения backend.',
  },
  uz: {
    eyebrow: 'Marketing engine 2.0', title: 'Kontent strategi', subtitle: 'Brifdan ssenariy va visual promptgacha — jamoa uchun tayyor tuzilmada.',
    brandKit: 'Brand Kit', tone: 'Tone of Voice', format: 'Format', short_video: 'Reels / Shorts', carousel: 'Karusel', post: 'Post',
    topic: 'Nimani targ‘ib qilish kerak?', topicPh: 'Masalan: kichik biznes tarifi, kurs yoki mavsumiy aksiya', context: 'Kontekst va tasdiqlangan faktlar', contextPh: 'Ishlatish mumkin bo‘lgan afzalliklar, cheklovlar, narxlar va faktlar.',
    goal: 'Maqsad', lead_gen: 'Lidlar', reach: 'Qamrov', sales: 'Savdo', expert_authority: 'Ekspertlik', generate: 'Kampaniya tuzish', generating: 'Strategiya tuzilmoqda',
    preview: 'Demo ko‘rinish · generatsiya emas', liveResult: 'OpenRouter natijasi', audit: 'Strategik fokus', audience: 'Segment', angle: 'Yondashuv', pain: 'Muammo',
    hooks: 'Hook tanlang', hookHint: 'Faol variant ishchi ssenariyga kiradi.', provocation: 'Provokatsiya', mistake: 'Xato', case_study: 'Keys', copied: 'Nusxalandi', copy: 'Nusxalash',
    storyboard: 'Storyboard', storyboardHint: 'B-roll va matn bilan kadrma-kadr ssenariy.', scene: 'Sahna', timing: 'Taymkod / slayd', visual: 'Vizual / B-roll', voice: 'Ovoz matni', onScreen: 'Ekranda',
    visualStudio: 'Visual Studio', visualHint: 'Prompt tasvir yaratish uchun tayyor.', preset: 'Uslub', prompt: 'Aniq prompt', negative: 'Istisnolar', regenerate: 'Tasvir yaratish', regenerating: 'Tasvir yaratilmoqda', noImage: 'Tasvir hali yaratilmagan', promptReady: 'Prompt tayyor', ratio: 'Format',
    cta: 'Harakatga chaqiriq', emptyTitle: 'Qisqa brifdan boshlang', emptyText: 'Brand Kit va formatni tanlang. Dvigatel qatʼiy sxema bo‘yicha uch hook, storyboard va visual prompt qaytaradi.',
    noBrandTitle: 'Brand Kit kerak', noBrandText: 'Birinchi to‘plamni yarating: nom, Tone of Voice, ranglar va vizual uslub.', newBrand: 'Yangi Brand Kit', createBrand: 'Brand Kit saqlash', cancel: 'Bekor qilish', brandName: 'Nomi', brandNamePh: 'Masalan: Nemo Product', brandTonePh: 'Brend auditoriya bilan qanday gaplashadi', stopWords: 'Vergul bilan stop-so‘zlar', primaryColor: 'Asosiy rang', accentColor: 'Aksent',
    loadError: 'Brand Kitlar yuklanmadi.', createError: 'Brand Kit saqlanmadi.', generateError: 'Kampaniya yaratilmadi. Ulanish va token limitini tekshiring.', imageError: 'Tasvir yaratilmadi. Media provider ulanishini tekshiring.', liveOnly: 'Generatsiya backend ulangandan keyin ishlaydi.',
  },
  en: {
    eyebrow: 'Marketing engine 2.0', title: 'Content strategist', subtitle: 'From brief to storyboard and visual prompt — structured for your team.',
    brandKit: 'Brand Kit', tone: 'Tone of Voice', format: 'Format', short_video: 'Reels / Shorts', carousel: 'Carousel', post: 'Post',
    topic: 'What are you promoting?', topicPh: 'For example: a new small-business plan, course launch, or seasonal offer', context: 'Context and verified facts', contextPh: 'Benefits, constraints, pricing, and facts the campaign may use. Nothing will be invented.',
    goal: 'Goal', lead_gen: 'Leads', reach: 'Reach', sales: 'Sales', expert_authority: 'Authority', generate: 'Build campaign', generating: 'Building strategy',
    preview: 'Demo preview · not generated', liveResult: 'OpenRouter result', audit: 'Strategic focus', audience: 'Segment', angle: 'Angle', pain: 'Pain',
    hooks: 'Choose a hook', hookHint: 'The active option becomes the working direction.', provocation: 'Provocation', mistake: 'Mistake', case_study: 'Case study', copied: 'Copied', copy: 'Copy',
    storyboard: 'Storyboard', storyboardHint: 'A scene-by-scene script with B-roll and copy.', scene: 'Scene', timing: 'Time / slide', visual: 'Visual / B-roll', voice: 'Voiceover', onScreen: 'On screen',
    visualStudio: 'Visual Studio', visualHint: 'The prompt is ready for image generation.', preset: 'Style', prompt: 'Exact prompt', negative: 'Exclude', regenerate: 'Create image', regenerating: 'Creating image', noImage: 'No image generated yet', promptReady: 'Prompt ready', ratio: 'Ratio',
    cta: 'Call to action', emptyTitle: 'Start with a short brief', emptyText: 'Choose a Brand Kit and format. The engine returns three hooks, a storyboard, and a visual prompt under a strict schema.',
    noBrandTitle: 'A Brand Kit is required', noBrandText: 'Create the first kit with a name, Tone of Voice, colors, and visual style.', newBrand: 'New Brand Kit', createBrand: 'Save Brand Kit', cancel: 'Cancel', brandName: 'Name', brandNamePh: 'For example: Nemo Product', brandTonePh: 'How the brand speaks to its audience', stopWords: 'Stop words, comma-separated', primaryColor: 'Primary color', accentColor: 'Accent',
    loadError: 'Could not load Brand Kits.', createError: 'Could not save the Brand Kit.', generateError: 'Campaign generation failed. Check the connection and token limit.', imageError: 'Could not create the image. Check the connected media provider.', liveOnly: 'Generation is available after connecting the backend.',
  },
}

const presetLabels: Record<Preset, string> = Object.fromEntries(Object.entries(VISUAL_PRESETS).map(([id, value]) => [id, value.label])) as Record<Preset, string>

export function MarketingCampaignStudio() {
  const { lang } = useI18n()
  const c = COPY[lang]
  const [brands, setBrands] = useState<BrandKit[]>(isSupabaseEnabled ? [] : [PREVIEW_BRAND])
  const [brandId, setBrandId] = useState(isSupabaseEnabled ? '' : PREVIEW_BRAND.id)
  const [format, setFormat] = useState<Format>('short_video')
  const [goal, setGoal] = useState<Goal>('lead_gen')
  const [topic, setTopic] = useState('')
  const [context, setContext] = useState('')
  const [campaign, setCampaign] = useState<MarketingOutput | null>(isSupabaseEnabled ? null : PREVIEW_CAMPAIGN)
  const [isPreview, setIsPreview] = useState(!isSupabaseEnabled)
  const [activeHook, setActiveHook] = useState(PREVIEW_CAMPAIGN.hooks[0].id)
  const [copiedHook, setCopiedHook] = useState('')
  const [visualPreset, setVisualPreset] = useState<Preset>(PREVIEW_BRAND.visual_preset)
  const [imageUrl, setImageUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)
  const [brandLoading, setBrandLoading] = useState(isSupabaseEnabled)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [brandEditorOpen, setBrandEditorOpen] = useState(false)
  const [brandDraft, setBrandDraft] = useState({ name: '', tone: '', stopWords: '', primary: '#06B6D4', accent: '#6366F1', preset: 'minimal_tech_ui' as Preset })

  const selectedBrand = useMemo(() => brands.find((brand) => brand.id === brandId) ?? null, [brands, brandId])

  useEffect(() => {
    if (!supabase) return
    let active = true
    void supabase.from('brand_kits').select('id, name, colors, fonts, tone_of_voice, stop_words, visual_preset, custom_visual_rules').order('updated_at', { ascending: false }).then(({ data, error }) => {
      if (!active) return
      if (error) { setLoadError(c.loadError); setBrandLoading(false); return }
      const valid = (data ?? []).map((row) => BrandKitSchema.safeParse(row)).filter((result) => result.success).map((result) => result.data)
      setBrands(valid)
      if (valid[0]) { setBrandId(valid[0].id); setVisualPreset(valid[0].visual_preset) }
      setBrandLoading(false)
    })
    return () => { active = false }
  }, [c.loadError])

  async function createBrandKit() {
    if (!supabase) return
    setActionError('')
    const payload = {
      name: brandDraft.name.trim(),
      colors: [brandDraft.primary, brandDraft.accent],
      fonts: { heading: 'Manrope', body: 'Inter' },
      tone_of_voice: brandDraft.tone.trim(),
      stop_words: brandDraft.stopWords.split(',').map((word) => word.trim()).filter(Boolean),
      visual_preset: brandDraft.preset,
      custom_visual_rules: '',
    }
    const checked = BrandKitSchema.omit({ id: true }).safeParse(payload)
    if (!checked.success) { setActionError(c.createError); return }
    const { data, error } = await supabase.from('brand_kits').insert(checked.data).select('id, name, colors, fonts, tone_of_voice, stop_words, visual_preset, custom_visual_rules').single()
    const parsed = BrandKitSchema.safeParse(data)
    if (error || !parsed.success) { setActionError(c.createError); return }
    setBrands((current) => [parsed.data, ...current])
    setBrandId(parsed.data.id)
    setVisualPreset(parsed.data.visual_preset)
    setBrandEditorOpen(false)
  }

  async function generateCampaign() {
    if (!selectedBrand || topic.trim().length < 3) return
    if (!isSupabaseEnabled) { setActionError(c.liveOnly); return }
    setLoading(true)
    setActionError('')
    setImageUrl('')
    try {
      const token = await getAccessToken()
      if (!token) throw new Error('NO_SESSION')
      const config = FORMAT_CONFIG[format]
      const response = await fetch('/api/marketing/generate-campaign', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic.trim(), context: context.trim() || undefined, platform: config.platform, goal, brand_kit_id: selectedBrand.id, image_ratio: config.ratio, language: lang }),
      })
      const body = await response.json().catch(() => null)
      const parsed = MarketingOutputSchema.safeParse(body?.campaign)
      if (!response.ok || !body?.ok || !parsed.success) throw new Error(String(body?.code ?? 'INVALID_RESPONSE'))
      setCampaign(parsed.data)
      setActiveHook(parsed.data.hooks[0].id)
      setVisualPreset(parsed.data.visual_spec.style_preset)
      setIsPreview(false)
    } catch {
      setActionError(c.generateError)
    } finally {
      setLoading(false)
    }
  }

  async function copyHook(id: string, text: string) {
    await navigator.clipboard.writeText(text)
    setCopiedHook(id)
    window.setTimeout(() => setCopiedHook(''), 1400)
  }

  async function regenerateVisual() {
    if (!campaign || !supabase || !isSupabaseEnabled) { setActionError(c.liveOnly); return }
    setImageLoading(true)
    setActionError('')
    const preset = VISUAL_PRESETS[visualPreset]
    const prompt = `${campaign.visual_spec.prompt}. ${preset.positive}. Avoid: ${campaign.visual_spec.negative_prompt}; ${preset.negative}`
    const { data, error } = await supabase.functions.invoke('generate-image', { body: { prompt, style: visualPreset === 'editorial_photo_35mm' ? 'photo' : visualPreset } })
    const nextImage = String(data?.url ?? data?.image ?? '')
    if (error || !data?.ok || !nextImage) setActionError(c.imageError)
    else setImageUrl(nextImage)
    setImageLoading(false)
  }

  const hookTypeLabel = (type: MarketingOutput['hooks'][number]['type']) => c[type]
  const selectedColors = selectedBrand?.colors ?? PREVIEW_BRAND.colors

  return (
    <section className="space-y-6" aria-labelledby="marketing-campaign-title">
      <header className="relative overflow-hidden rounded-3xl border border-ice/[0.08] bg-panel/70 px-5 pb-6 pt-5 shadow-card sm:px-7 sm:pb-7">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent-cyan/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold tracking-[0.16em] text-accent-cyan">{c.eyebrow}</p>
            <h2 id="marketing-campaign-title" className="mt-2 text-3xl font-extrabold tracking-[-0.04em] text-text sm:text-4xl">{c.title}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{c.subtitle}</p>
          </div>
          <button type="button" onClick={() => setBrandEditorOpen((value) => !value)} className="inline-flex items-center gap-2 rounded-xl border border-ice/[0.1] bg-card/[0.04] px-3 py-2 text-xs font-semibold text-muted transition hover:border-accent-cyan/30 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40">
            <Plus size={14} /> {c.newBrand}
          </button>
        </div>

        <div className="relative mt-6 grid gap-3 xl:grid-cols-[minmax(190px,0.8fr)_minmax(240px,1.2fr)_auto]">
          <label className="rounded-xl border border-ice/[0.08] bg-bg/35 px-3 py-2">
            <span className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-fog"><Palette size={12} /> {c.brandKit}</span>
            <span className="relative block">
              <select value={brandId} onChange={(event) => { const nextId = event.target.value; setBrandId(nextId); const nextBrand = brands.find((brand) => brand.id === nextId); if (nextBrand) setVisualPreset(nextBrand.visual_preset) }} className="w-full appearance-none bg-transparent pr-6 text-sm font-semibold text-text outline-none" disabled={!brands.length}>
                {!brands.length && <option value="">{brandLoading ? '…' : '—'}</option>}
                {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-fog" />
            </span>
          </label>
          <div className="rounded-xl border border-ice/[0.08] bg-bg/35 px-3 py-2">
            <span className="mb-1 block text-[10px] font-semibold tracking-wide text-fog">{c.tone}</span>
            <p className="truncate text-sm text-text" title={selectedBrand?.tone_of_voice}>{selectedBrand?.tone_of_voice ?? '—'}</p>
          </div>
          <div className="rounded-xl border border-ice/[0.08] bg-bg/35 p-1">
            <span className="sr-only">{c.format}</span>
            <div className="grid grid-cols-3 gap-1">
              {(Object.keys(FORMAT_CONFIG) as Format[]).map((item) => (
                <button key={item} type="button" onClick={() => setFormat(item)} className={cn('rounded-lg px-3 py-2 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40', format === item ? 'bg-panel text-text shadow-soft' : 'text-fog hover:text-text')}>
                  {c[item]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {brandEditorOpen && (
          <div className="relative mt-4 grid gap-3 rounded-2xl border border-accent-cyan/15 bg-bg/45 p-4 sm:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1.5"><span className="text-[11px] text-muted">{c.brandName}</span><input value={brandDraft.name} onChange={(event) => setBrandDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder={c.brandNamePh} className="glass w-full px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/40" /></label>
            <label className="space-y-1.5 sm:col-span-2"><span className="text-[11px] text-muted">{c.tone}</span><input value={brandDraft.tone} onChange={(event) => setBrandDraft((draft) => ({ ...draft, tone: event.target.value }))} placeholder={c.brandTonePh} className="glass w-full px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/40" /></label>
            <label className="space-y-1.5"><span className="text-[11px] text-muted">{c.preset}</span><select value={brandDraft.preset} onChange={(event) => setBrandDraft((draft) => ({ ...draft, preset: event.target.value as Preset }))} className="glass w-full px-3 py-2 text-sm text-text outline-none">{Object.entries(presetLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label className="space-y-1.5 sm:col-span-2"><span className="text-[11px] text-muted">{c.stopWords}</span><input value={brandDraft.stopWords} onChange={(event) => setBrandDraft((draft) => ({ ...draft, stopWords: event.target.value }))} className="glass w-full px-3 py-2 text-sm text-text outline-none focus:border-accent-cyan/40" /></label>
            <div className="flex gap-3"><label className="space-y-1.5 text-[11px] text-muted">{c.primaryColor}<input type="color" value={brandDraft.primary} onChange={(event) => setBrandDraft((draft) => ({ ...draft, primary: event.target.value }))} className="block h-9 w-full cursor-pointer rounded-lg border border-ice/10 bg-transparent" /></label><label className="space-y-1.5 text-[11px] text-muted">{c.accentColor}<input type="color" value={brandDraft.accent} onChange={(event) => setBrandDraft((draft) => ({ ...draft, accent: event.target.value }))} className="block h-9 w-full cursor-pointer rounded-lg border border-ice/10 bg-transparent" /></label></div>
            <div className="flex items-end gap-2 xl:col-span-1"><Button size="sm" onClick={() => void createBrandKit()} disabled={!isSupabaseEnabled || brandDraft.name.trim().length < 1 || brandDraft.tone.trim().length < 1}>{c.createBrand}</Button><Button size="sm" variant="ghost" onClick={() => setBrandEditorOpen(false)}>{c.cancel}</Button></div>
          </div>
        )}
      </header>

      <div className="grid gap-4 rounded-2xl border border-ice/[0.08] bg-card/[0.025] p-4 lg:grid-cols-[1.4fr_1fr_auto] lg:items-end">
        <label className="space-y-1.5"><span className="text-xs font-semibold text-text">{c.topic}</span><textarea value={topic} onChange={(event) => setTopic(event.target.value)} rows={3} placeholder={c.topicPh} className="glass w-full resize-none px-3 py-2.5 text-sm leading-5 text-text outline-none placeholder:text-fog focus:border-accent-cyan/40" /></label>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <label className="space-y-1.5"><span className="text-xs font-semibold text-text">{c.goal}</span><select value={goal} onChange={(event) => setGoal(event.target.value as Goal)} className="glass w-full px-3 py-2.5 text-sm text-text outline-none">{(['lead_gen', 'reach', 'sales', 'expert_authority'] as Goal[]).map((item) => <option key={item} value={item}>{c[item]}</option>)}</select></label>
          <label className="space-y-1.5"><span className="text-xs font-semibold text-text">{c.context}</span><input value={context} onChange={(event) => setContext(event.target.value)} placeholder={c.contextPh} className="glass w-full px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-accent-cyan/40" /></label>
        </div>
        <Button size="lg" onClick={() => void generateCampaign()} loading={loading} disabled={!selectedBrand || topic.trim().length < 3} className="min-w-44">{loading ? c.generating : c.generate}</Button>
      </div>

      {(loadError || actionError) && <p role="alert" className="rounded-xl border border-danger/20 bg-danger/[0.07] px-4 py-3 text-sm text-danger">{loadError || actionError}</p>}

      {!brands.length && !brandLoading && !loadError && (
        <div className="rounded-3xl border border-dashed border-ice/[0.13] px-6 py-14 text-center"><Palette className="mx-auto text-accent-cyan" size={28} /><h3 className="mt-4 text-xl">{c.noBrandTitle}</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{c.noBrandText}</p><Button className="mt-5" onClick={() => setBrandEditorOpen(true)} leftIcon={<Plus size={15} />}>{c.newBrand}</Button></div>
      )}

      {loading && <CampaignSkeleton />}

      {!campaign && !loading && brands.length > 0 && (
        <div className="rounded-3xl border border-dashed border-ice/[0.13] px-6 py-16 text-center"><WandSparkles className="mx-auto text-accent-cyan" size={30} /><h3 className="mt-4 text-xl">{c.emptyTitle}</h3><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">{c.emptyText}</p></div>
      )}

      {campaign && !loading && (
        <div className="space-y-6 animate-fadeInUp">
          <div className="flex items-center justify-between gap-3"><span className={cn('inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[10px] font-semibold tracking-wide', isPreview ? 'border-amber/25 bg-amber/[0.07] text-amber' : 'border-teal/25 bg-teal/[0.07] text-teal')}><span className="h-1.5 w-1.5 rounded-full bg-current" />{isPreview ? c.preview : c.liveResult}</span></div>

          <section className="rounded-2xl border border-ice/[0.08] bg-card/[0.025] p-5" aria-labelledby="campaign-audit-title">
            <div className="flex items-center gap-2"><Target size={16} className="text-accent-cyan" /><h3 id="campaign-audit-title" className="text-base font-semibold">{c.audit}</h3></div>
            <dl className="mt-4 grid gap-5 md:grid-cols-3"><AuditItem label={c.audience} value={campaign.audit.target_segment} /><AuditItem label={c.angle} value={campaign.audit.angle} /><AuditItem label={c.pain} value={campaign.audit.core_pain} /></dl>
          </section>

          <section aria-labelledby="campaign-hooks-title">
            <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 id="campaign-hooks-title" className="text-xl font-bold">{c.hooks}</h3><p className="mt-1 text-sm text-muted">{c.hookHint}</p></div><span className="font-mono text-xs text-fog">03 variants</span></div>
            <div className="mt-4 grid gap-3 lg:grid-cols-3" role="radiogroup" aria-label={c.hooks}>
              {campaign.hooks.map((hook, index) => {
                const active = hook.id === activeHook
                return <article key={hook.id} role="radio" aria-checked={active} tabIndex={0} onClick={() => setActiveHook(hook.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveHook(hook.id) } }} className={cn('group relative cursor-pointer rounded-2xl border p-4 transition-[transform,border-color,background-color,box-shadow] duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40', active ? 'border-accent-cyan/45 bg-accent-cyan/[0.055] shadow-[0_18px_38px_-28px_rgba(6,182,212,0.8)]' : 'border-ice/[0.08] bg-card/[0.025] hover:border-ice/[0.16]')}>
                  <div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-fog">0{index + 1}</span><span className={cn('rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-[0.1em]', active ? 'bg-accent-cyan/12 text-accent-cyan' : 'bg-card/[0.05] text-muted')}>{hookTypeLabel(hook.type)}</span></div>
                  <p className="mt-5 text-base font-semibold leading-6 text-text">{hook.text}</p><p className="mt-3 text-xs leading-5 text-muted">{hook.rationale}</p>
                  <div className="mt-5 flex items-center justify-between"><span className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold', active ? 'text-teal' : 'text-fog')}>{active && <Check size={12} />}{active ? 'Active' : ''}</span><button type="button" onClick={(event) => { event.stopPropagation(); void copyHook(hook.id, hook.text) }} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-semibold text-muted transition hover:bg-card/[0.07] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40">{copiedHook === hook.id ? <Check size={12} className="text-teal" /> : <Copy size={12} />}{copiedHook === hook.id ? c.copied : c.copy}</button></div>
                </article>
              })}
            </div>
          </section>

          <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.75fr)]">
            <section className="min-w-0 overflow-hidden rounded-2xl border border-ice/[0.08] bg-card/[0.02]" aria-labelledby="campaign-storyboard-title">
              <div className="flex items-start gap-3 border-b border-ice/[0.07] px-5 py-4"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-indigo/10 text-accent-indigo"><LayoutTemplate size={17} /></span><div><h3 id="campaign-storyboard-title" className="text-lg font-bold">{c.storyboard}</h3><p className="mt-0.5 text-xs text-muted">{c.storyboardHint}</p></div></div>
              <div className="overflow-x-auto"><table className="w-full min-w-[900px] table-fixed text-left"><thead><tr className="border-b border-ice/[0.06] text-[9px] uppercase tracking-[0.12em] text-fog"><th className="w-16 px-4 py-3">{c.scene}</th><th className="w-32 px-3 py-3">{c.timing}</th><th className="w-[31%] px-3 py-3">{c.visual}</th><th className="w-[31%] px-3 py-3">{c.voice}</th><th className="px-3 py-3">{c.onScreen}</th></tr></thead><tbody>{campaign.timeline.map((scene) => <tr key={scene.step} className="border-b border-ice/[0.055] align-top last:border-0"><td className="px-4 py-4"><span className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-ice/[0.08] bg-panel font-mono text-[10px] text-accent-cyan">{String(scene.step).padStart(2, '0')}</span></td><td className="px-3 py-4 font-mono text-[11px] text-muted">{scene.timestamp_or_slide}</td><td className="px-3 py-4 text-xs leading-5 text-text">{scene.visual_description}</td><td className="px-3 py-4 text-xs leading-5 text-muted">{scene.script_text}</td><td className="px-3 py-4 text-xs font-semibold leading-5 text-text">{scene.on_screen_text}</td></tr>)}</tbody></table></div>
            </section>

            <aside className="overflow-hidden rounded-2xl border border-ice/[0.08] bg-panel/55" aria-labelledby="visual-studio-title">
              <div className="flex items-start justify-between gap-3 px-5 py-4"><div><h3 id="visual-studio-title" className="text-lg font-bold">{c.visualStudio}</h3><p className="mt-0.5 text-xs text-muted">{c.visualHint}</p></div><span className="rounded-md border border-teal/20 bg-teal/[0.07] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-teal">{c.promptReady}</span></div>
              <div className="relative mx-4 overflow-hidden rounded-xl border border-ice/[0.08] bg-bg" style={{ aspectRatio: campaign.visual_spec.recommended_ratio.replace(':', ' / ') }}>
                {imageUrl ? <img src={imageUrl} alt={campaign.visual_spec.prompt} className="h-full w-full object-cover" /> : <div className="absolute inset-0 flex items-center justify-center" style={{ background: `radial-gradient(circle at 25% 20%, ${selectedColors[0]}35, transparent 38%), radial-gradient(circle at 75% 80%, ${selectedColors[1] ?? selectedColors[0]}2b, transparent 42%), rgb(var(--color-bg))` }}><div className="text-center"><ImageIcon size={28} className="mx-auto text-ice/30" /><p className="mt-2 text-[11px] text-fog">{c.noImage}</p></div></div>}
                <span className="absolute bottom-3 left-3 rounded-md border border-white/10 bg-bg/75 px-2 py-1 text-[9px] font-semibold text-text backdrop-blur">{presetLabels[visualPreset]}</span>
              </div>
              <div className="space-y-4 p-5">
                <label className="space-y-1.5"><span className="text-[10px] font-semibold tracking-wide text-fog">{c.preset}</span><select value={visualPreset} onChange={(event) => setVisualPreset(event.target.value as Preset)} className="glass w-full px-3 py-2 text-xs text-text outline-none">{Object.entries(presetLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
                <div><p className="text-[10px] font-semibold tracking-wide text-fog">{c.prompt}</p><p className="mt-1.5 max-h-32 overflow-y-auto rounded-xl border border-ice/[0.07] bg-bg/35 p-3 font-mono text-[10px] leading-5 text-muted">{campaign.visual_spec.prompt}</p></div>
                <div><p className="text-[10px] font-semibold tracking-wide text-fog">{c.negative}</p><p className="mt-1.5 text-[10px] leading-5 text-fog">{campaign.visual_spec.negative_prompt}</p></div>
                <div className="flex items-center justify-between gap-3"><span className="font-mono text-[10px] text-fog">{c.ratio} {campaign.visual_spec.recommended_ratio}</span><Button size="sm" variant="secondary" onClick={() => void regenerateVisual()} loading={imageLoading} leftIcon={imageLoading ? <Loader2 size={13} /> : <RefreshCw size={13} />}>{imageLoading ? c.regenerating : c.regenerate}</Button></div>
              </div>
            </aside>
          </div>

          <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-accent-cyan/15 bg-accent-cyan/[0.035] px-5 py-4"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan"><Sparkles size={16} /></span><div className="min-w-0 flex-1"><p className="text-[10px] font-semibold tracking-wide text-fog">{c.cta} · {campaign.cta.action_type}</p><p className="mt-1 text-sm font-semibold text-text">{campaign.cta.copy}</p></div><button type="button" onClick={() => void navigator.clipboard.writeText(campaign.cta.copy)} className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted transition hover:bg-card/[0.06] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/40" aria-label={c.copy}><Clipboard size={15} /></button></section>
        </div>
      )}
    </section>
  )
}

function AuditItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[9px] font-bold uppercase tracking-[0.14em] text-fog">{label}</dt><dd className="mt-2 text-sm leading-6 text-text">{value}</dd></div>
}

function CampaignSkeleton() {
  return <div className="space-y-4" aria-busy="true"><div className="h-28 animate-pulse rounded-2xl bg-card/[0.05]" /><div className="grid gap-3 lg:grid-cols-3">{[0, 1, 2].map((item) => <div key={item} className="h-48 animate-pulse rounded-2xl bg-card/[0.05]" />)}</div><div className="h-80 animate-pulse rounded-2xl bg-card/[0.05]" /></div>
}
