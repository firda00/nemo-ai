import { useState } from 'react'
import { Sparkles, Share2, FileText, Mail, Megaphone, Users2, Clapperboard, Layers } from 'lucide-react'
import { AutonomousRunner } from './AutonomousRunner'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

/** Ready-made content team producing publish-ready content across formats. */
const CONTENT_TEAM = [
  { role: 'Content Strategist', name: 'Стратег', prompt: { role: 'ведущий контент-стратег: под аудиторию и формат определяет угол, структуру и ключевое сообщение', tasks: 'проанализировать бриф; выбрать угол и структуру под формат; задать ключевое сообщение и CTA', tone: 'чётко', rules: 'без воды; опираться на бриф' } },
  { role: 'Copywriter', name: 'Копирайтер', prompt: { role: 'сильный копирайтер', tasks: 'по структуре стратега написать заголовок, тело, призыв — на языке брифа', tone: 'живо, убедительно', rules: 'конкретика; без клише' } },
  { role: 'Editor', name: 'Редактор', prompt: { role: 'редактор', tasks: 'улучшить ясность и ритм, убрать штампы, проверить соответствие брифу', tone: 'требовательно', rules: 'сохранять смысл; не удлинять' } },
  { role: 'SMM Manager', name: 'SMM', prompt: { role: 'SMM/дистрибуция', tasks: 'соцсети — хэштеги, идея визуала; email — тема+прехедер; реклама — заголовки+CTA; статья — SEO-заголовок+анонс', tone: 'практично', rules: 'подгонять под формат' } },
]
const CONTENT_HINT = 'Ты — готовая контент-команда Nemo (Стратег, Копирайтер, Редактор, SMM). Выдай ГОТОВЫЙ к публикации контент точно по брифу и формату, на языке брифа.'

/** For video: a Scriptwriter joins the team to build a shot-by-shot script. */
const VIDEO_TEAM = [
  { role: 'Content Strategist', name: 'Стратег', prompt: { role: 'контент-стратег для видео: определяет идею, крючок и структуру ролика под платформу', tasks: 'выбрать угол и структуру ролика; задать ключевое сообщение, крючок и CTA', tone: 'чётко', rules: 'думать форматом коротких видео; опираться на бриф' } },
  { role: 'Scriptwriter', name: 'Сценарист', prompt: { role: 'сценарист видео/Reels/Shorts', tasks: 'построить сценарий: хук (0–3 сек), сцены с таймкодами (что в кадре + закадровый текст/реплики), текст на экране, финальный CTA', tone: 'динамично', rules: 'коротко и по кадрам; удерживать внимание с первой секунды; без воды' } },
  { role: 'Editor', name: 'Редактор', prompt: { role: 'редактор сценария', tasks: 'проверить темп, ясность реплик и хука, соответствие хронометражу и брифу', tone: 'требовательно', rules: 'сохранять смысл; держать длину в рамках' } },
  { role: 'SMM Manager', name: 'SMM', prompt: { role: 'SMM/дистрибуция видео', tasks: 'подобрать заголовок, описание, хэштеги под платформу и идею обложки/превью', tone: 'практично', rules: 'подгонять под платформу' } },
]
const VIDEO_HINT = 'Ты — готовая видео-команда Nemo (Стратег, Сценарист, Редактор, SMM). Выдай ГОТОВЫЙ сценарий видео/Reels точно по брифу: хук, сцены с таймкодами, закадровый текст, текст на экране, CTA и идею обложки. На языке брифа.'

type Format = 'social' | 'carousel' | 'article' | 'email' | 'ad' | 'video'
const FORMATS: { id: Format; label: string; icon: typeof Share2 }[] = [
  { id: 'social', label: 'Соцсети', icon: Share2 },
  { id: 'carousel', label: 'Карусель', icon: Layers },
  { id: 'video', label: 'Видео / Reels сценарий', icon: Clapperboard },
  { id: 'article', label: 'Статья / блог', icon: FileText },
  { id: 'email', label: 'Email-рассылка', icon: Mail },
  { id: 'ad', label: 'Реклама', icon: Megaphone },
]
const PLATFORMS = ['Instagram', 'Telegram', 'TikTok', 'Facebook', 'YouTube', 'LinkedIn']
const DURATIONS = [{ k: '15', l: '15 сек' }, { k: '30', l: '30 сек' }, { k: '60', l: '60 сек' }, { k: '180', l: 'до 3 мин' }]
const LENGTHS = [{ k: 'short', l: 'Короткая ~300 сл.' }, { k: 'medium', l: 'Средняя ~800 сл.' }, { k: 'long', l: 'Лонгрид ~1500 сл.' }]
const EMAIL_GOALS = ['Анонс', 'Прогрев', 'Возврат клиента', 'Акция / скидка']
const AD_CHANNELS = ['Таргет в соцсетях', 'Google Ads', 'Наружная реклама', 'Маркетплейс']
const EXAMPLES = ['Запуск вечернего курса IELTS, ранняя скидка', 'B2B: система автоматизации склада (WMS)', 'Акция «приведи друга» для фитнес-клуба']
const pill = (on: boolean) => cn('rounded-pill border px-3 py-1.5 text-xs font-medium transition', on ? 'border-violet/60 bg-violet/10 text-text' : 'border-ice/10 text-muted hover:border-ice/25')

export function ContentTeamPanel({ model }: { model?: string }) {
  const { t } = useI18n()
  const [format, setFormat] = useState<Format>('social')
  const [topic, setTopic] = useState('')
  const [tone, setTone] = useState('дружелюбный, экспертный')
  const [platform, setPlatform] = useState('Instagram')
  const [count, setCount] = useState(3)
  const [length, setLength] = useState('medium')
  const [seo, setSeo] = useState('')
  const [emailGoal, setEmailGoal] = useState('Анонс')
  const [adChannel, setAdChannel] = useState('Таргет в соцсетях')
  const [duration, setDuration] = useState('30')

  const team = format === 'video' ? VIDEO_TEAM : CONTENT_TEAM
  const topicText = topic.trim()
  const lengthLabel = LENGTHS.find((x) => x.k === length)?.l ?? ''
  let brief = ''
  if (topicText) {
    if (format === 'social') brief = `Создай контент для соцсетей. Платформа: ${platform}. Количество: ${count}. Тон: ${tone}. Тема: ${topicText}. Для КАЖДОЙ единицы: цепляющий текст/подпись, релевантные хэштеги и короткую идею визуала. На языке темы.`
    else if (format === 'carousel') brief = `Создай КАРУСЕЛЬ из ${count} слайдов для ${platform}. Тон: ${tone}. Тема: ${topicText}. Для КАЖДОГО слайда выдай: «Слайд N», короткий ЗАГОЛОВОК (крупный текст на слайде, до 6 слов) и 1–2 предложения текста. Слайд 1 — цепляющий хук, последний слайд — призыв к действию (CTA). Для каждого слайда добавь короткую идею визуала. В конце — ПОДПИСЬ к посту (caption) с 5–10 хэштегами. На языке темы.`
    else if (format === 'article') brief = `Напиши статью для блога (${lengthLabel}). Тон: ${tone}. Тема: ${topicText}.${seo.trim() ? ` Ключевое слово для SEO: ${seo.trim()}.` : ''} Выдай: цепляющий заголовок и SEO-вариант, короткий анонс, полный структурированный текст с подзаголовками и выводом. На языке темы.`
    else if (format === 'email') brief = `Напиши email (${emailGoal})${count > 1 ? ` — серия из ${count} писем` : ''}. Тон: ${tone}. Тема/задача: ${topicText}. Для каждого письма: тема, прехедер, тело и призыв к действию. На языке темы.`
    else if (format === 'ad') brief = `Напиши рекламный текст для канала «${adChannel}». Вариантов: ${count}. Тон: ${tone}. Оффер/задача: ${topicText}. Для КАЖДОГО варианта: цепляющий заголовок, короткий текст, призыв к действию и идею креатива. На языке темы.`
    else brief = `Напиши сценарий видео/Reels для платформы ${platform}. Хронометраж: ${DURATIONS.find((d) => d.k === duration)?.l ?? duration}. Тон: ${tone}. Тема: ${topicText}. Выдай: цепляющий хук (0–3 сек), раскадровку по сценам с таймкодами (что в кадре + закадровый текст/реплики), текст на экране, финальный CTA и идею обложки/превью. На языке темы.`
  }

  return (
    <>
      <div className="card flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3">
        <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-muted"><Users2 size={14} className="text-violet" /> {t('contentTeamPanel.teamLabel')}</span>
        {team.map((m) => <span key={m.name} className="rounded-pill border border-ice/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-text">{m.name} · {m.role}</span>)}
      </div>

      <div className="card mt-4 space-y-5 rounded-3xl p-6">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.formatLabel')}</p>
          <div className="flex flex-wrap gap-2">{FORMATS.map((f) => <button key={f.id} onClick={() => setFormat(f.id)} className={cn('inline-flex items-center gap-1.5', pill(format === f.id))}><f.icon size={13} /> {t(`contentTeamPanel.format_${f.id}`)}</button>)}</div>
        </div>

        {format === 'social' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.platformLabel')}</p><div className="flex flex-wrap gap-2">{PLATFORMS.map((p) => <button key={p} onClick={() => setPlatform(p)} className={pill(platform === p)}>{p}</button>)}</div></div>
            <Count value={count} onChange={setCount} label={t('contentTeamPanel.countPosts')} />
          </div>
        )}
        {format === 'carousel' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.platformLabel')}</p><div className="flex flex-wrap gap-2">{PLATFORMS.map((p) => <button key={p} onClick={() => setPlatform(p)} className={pill(platform === p)}>{p}</button>)}</div></div>
            <Count value={count} onChange={setCount} label={t('contentTeamPanel.countSlides')} />
          </div>
        )}
        {format === 'video' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.platformLabel')}</p><div className="flex flex-wrap gap-2">{PLATFORMS.map((p) => <button key={p} onClick={() => setPlatform(p)} className={pill(platform === p)}>{p}</button>)}</div></div>
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.durationLabel')}</p><div className="flex flex-wrap gap-2">{DURATIONS.map((d) => <button key={d.k} onClick={() => setDuration(d.k)} className={pill(duration === d.k)}>{t(`contentTeamPanel.duration_${d.k}`)}</button>)}</div></div>
          </div>
        )}
        {format === 'article' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.lengthLabel')}</p><div className="flex flex-wrap gap-2">{LENGTHS.map((x) => <button key={x.k} onClick={() => setLength(x.k)} className={pill(length === x.k)}>{t(`contentTeamPanel.length_${x.k}`)}</button>)}</div></div>
            <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.seoLabel')}</span><input value={seo} onChange={(e) => setSeo(e.target.value)} placeholder={t('contentTeamPanel.seoPh')} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
          </div>
        )}
        {format === 'email' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.emailGoalLabel')}</p><div className="flex flex-wrap gap-2">{EMAIL_GOALS.map((g) => <button key={g} onClick={() => setEmailGoal(g)} className={pill(emailGoal === g)}>{g}</button>)}</div></div>
            <Count value={count} onChange={setCount} label={t('contentTeamPanel.countEmails')} />
          </div>
        )}
        {format === 'ad' && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.channelLabel')}</p><div className="flex flex-wrap gap-2">{AD_CHANNELS.map((c) => <button key={c} onClick={() => setAdChannel(c)} className={pill(adChannel === c)}>{c}</button>)}</div></div>
            <Count value={count} onChange={setCount} label={t('contentTeamPanel.countVariants')} />
          </div>
        )}

        <label className="block space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.toneLabel')}</span><input value={tone} onChange={(e) => setTone(e.target.value)} className="glass w-full rounded-xl px-3 py-2 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" /></label>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{t('contentTeamPanel.topicLabel')}</p>
          <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={2} placeholder={t('contentTeamPanel.topicPh')} className="glass w-full resize-y rounded-xl px-3 py-2.5 text-sm text-text outline-none placeholder:text-fog focus:border-violet/50" />
          <div className="mt-2 flex flex-wrap gap-1.5">{EXAMPLES.map((ex) => <button key={ex} onClick={() => setTopic(ex)} className="rounded-lg border border-ice/10 px-2 py-1 text-[11px] text-muted hover:text-text">{ex}</button>)}</div>
        </div>
      </div>

      <div className="mt-6">
        {brief ? (
          <AutonomousRunner key={brief} defaultGoal={brief} presetSpecs={team} contextHint={format === 'video' ? VIDEO_HINT : CONTENT_HINT} model={model} postActions placeholder={t('contentTeamPanel.runnerPh')} />
        ) : (
          <div className="card flex items-center gap-3 rounded-2xl p-5 text-sm text-muted"><Sparkles size={16} className="text-violet" /> {t('contentTeamPanel.emptyHint')}</div>
        )}
      </div>
    </>
  )
}

function Count({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return <label className="space-y-1.5"><span className="block text-xs font-medium uppercase tracking-wide text-muted">{label}</span><input type="number" min={1} max={10} value={value} onChange={(e) => onChange(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="glass w-28 rounded-xl px-3 py-2 text-sm text-text outline-none focus:border-violet/50" /></label>
}
