import { useRef, useState } from 'react'
import { FileCode2, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { Button } from '../ui/Button'
import { useI18n } from '../../i18n'
import { extractSkillText, MAX_SKILL_FILE_BYTES } from '../../lib/extractText'
import { isSupabaseEnabled, supabase } from '../../lib/supabase'

const START = '<<<NEMO_CUSTOM_SKILL:'
const END = '<<<END_NEMO_CUSTOM_SKILL>>>'
const MAX_IMPORTED_SKILLS = 3

interface ImportedSkill { name: string; full: string }

function importedSkills(rules: string): ImportedSkill[] {
  const pattern = /<<<NEMO_CUSTOM_SKILL: ([^\n>]+)>>>\n[\s\S]*?\n<<<END_NEMO_CUSTOM_SKILL>>>/g
  return [...rules.matchAll(pattern)].map((match) => ({ name: match[1], full: match[0] }))
}

const copy = {
  ru: {
    title: 'Свой skill из файла',
    hint: 'PDF, DOCX, XLSX, JSON, YAML, Markdown, код и другие текстовые форматы. До 5 МБ; в prompt попадут первые 12 000 символов.',
    add: 'Загрузить skill',
    saved: 'Skill добавлен в инструкции. Сохраните агента, затем проверьте его в тестовом чате.',
    bad: 'Формат нельзя безопасно преобразовать в текст. Архивы, программы, изображения, аудио и видео не запускаются.',
    tooLarge: 'Файл слишком большой. Максимальный размер skill-файла — 5 МБ.',
    limit: 'Для одного агента можно импортировать до 3 собственных skills.',
    safety: 'Файл используется только как текстовая инструкция и никогда не исполняется как программа.',
    remove: 'Удалить skill',
  },
  uz: {
    title: 'Fayldan o‘z skill’ingiz',
    hint: 'PDF, DOCX, XLSX, JSON, YAML, Markdown, kod va boshqa matn formatlari. 5 MB gacha; promptga dastlabki 12 000 belgi tushadi.',
    add: 'Skill yuklash',
    saved: 'Skill ko‘rsatmalarga qo‘shildi. Agentni saqlang va test chatda tekshiring.',
    bad: 'Formatni xavfsiz matnga aylantirib bo‘lmadi. Arxiv, dastur, rasm, audio va video ishga tushirilmaydi.',
    tooLarge: 'Fayl juda katta. Skill-faylning maksimal hajmi — 5 MB.',
    limit: 'Bitta agentga 3 tagacha shaxsiy skill import qilish mumkin.',
    safety: 'Fayl faqat matnli ko‘rsatma sifatida ishlatiladi va dastur sifatida ishga tushirilmaydi.',
    remove: 'Skillni o‘chirish',
  },
  en: {
    title: 'Custom skill from a file',
    hint: 'PDF, DOCX, XLSX, JSON, YAML, Markdown, source code and other text formats. Up to 5 MB; the first 12,000 characters enter the prompt.',
    add: 'Upload skill',
    saved: 'Skill added to the instructions. Save the agent, then verify it in the test chat.',
    bad: 'This format cannot be converted to text safely. Archives, executables, images, audio and video are never run.',
    tooLarge: 'The file is too large. A skill file can be at most 5 MB.',
    limit: 'You can import up to 3 custom skills per agent.',
    safety: 'The file is used only as text instructions and is never executed as a program. New skills stay private until Nemo compatibility review.',
    remove: 'Remove skill',
  },
}

export function SkillFileImporter({ rules, onChange, agentId }: { rules: string; onChange: (rules: string) => void; agentId?: string }) {
  const { lang } = useI18n()
  const c = copy[lang]
  const inputRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const skills = importedSkills(rules)

  const importFile = async (file?: File) => {
    if (!file) return
    if (skills.length >= MAX_IMPORTED_SKILLS) { setMessage({ ok: false, text: c.limit }); return }
    try {
      const instruction = (await extractSkillText(file)).trim().replaceAll(END, '[end marker removed]')
      if (!instruction) throw new Error('EMPTY_FILE')
      const safeName = file.name.replace(/[\r\n<>]/g, '_').slice(0, 100) || 'custom-skill'
      const block = `${START} ${safeName}>>>\n${instruction}\n${END}`
      onChange(`${rules.trim()}${rules.trim() ? '\n\n' : ''}${block}`)
      let review = ''
      if (isSupabaseEnabled && supabase) {
        const { data } = await supabase.functions.invoke('review-skill', { body: { action: 'submit', agent_id: agentId, name: safeName.replace(/\.[^.]+$/, ''), source_filename: safeName, content: instruction } })
        const result = data as { skill?: { status?: string; compatibility_score?: number } } | null
        if (result?.skill?.status === 'shared_candidate') review = ` AI review: candidate (${result.skill.compatibility_score ?? 0}/100), pending admin approval.`
        else if (result?.skill?.status === 'private') review = ' AI review: kept private.'
      }
      setMessage({ ok: true, text: `${c.saved}${review}` })
    } catch {
      setMessage({ ok: false, text: file.size > MAX_SKILL_FILE_BYTES ? c.tooLarge : c.bad })
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = (skill: ImportedSkill) => {
    onChange(rules.replace(skill.full, '').replace(/\n{3,}/g, '\n\n').trim())
    setMessage(null)
  }

  return (
    <div className="mt-4 rounded-2xl border border-cyan/15 bg-cyan/[0.04] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-text"><FileCode2 size={15} className="text-cyan" /> {c.title}</p>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted">{c.hint}</p>
        </div>
        <input ref={inputRef} type="file" className="hidden" onChange={(event) => importFile(event.target.files?.[0])} />
        <Button type="button" size="sm" variant="subtle" onClick={() => inputRef.current?.click()} disabled={skills.length >= MAX_IMPORTED_SKILLS}>
          <Upload size={14} /> {c.add}
        </Button>
      </div>
      {skills.length > 0 && (
        <div className="mt-3 space-y-2">
          {skills.map((skill) => (
            <div key={skill.name} className="flex items-center gap-2 rounded-xl border border-ice/10 bg-black/15 px-3 py-2">
              <FileCode2 size={13} className="shrink-0 text-cyan" />
              <span className="min-w-0 flex-1 truncate text-xs text-text">{skill.name}</span>
              <span className="rounded-full border border-amber/25 bg-amber/10 px-2 py-0.5 text-[10px] text-amber">Private · review</span>
              <button type="button" onClick={() => remove(skill)} aria-label={c.remove} className="rounded-md p-1 text-muted hover:bg-white/5 hover:text-danger"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-fog"><ShieldCheck size={12} className="mt-0.5 shrink-0 text-teal" /> {c.safety}</p>
      {message && <p className={`mt-2 text-xs ${message.ok ? 'text-teal' : 'text-danger'}`}>{message.text}</p>}
    </div>
  )
}
