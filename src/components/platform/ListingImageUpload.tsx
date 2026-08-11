import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAgentStore } from '../../store/useAgentStore'
import { useI18n } from '../../i18n'
import { IMAGE_BUCKET, MAX_IMAGES, imagePath, pickImages, type RejectedFile } from '../../lib/listingImageUpload'

type Preview = { url: string; name: string }

/**
 * Фотографии товара для Listing Agent.
 *
 * Файл уходит в приватный бакет ПРЯМО ОТСЮДА, а в edge-функцию едет только путь. Так сделано не
 * ради элегантности: восьмимегабайтный снимок в теле запроса упёрся бы в лимит функции, а
 * base64 раздул бы его ещё на треть. Здесь же за загрузку отвечает Storage, который для этого и
 * существует, а RLS следит, чтобы файл лёг в папку своего аккаунта.
 *
 * Превью строится из локального файла, а не из подписанной ссылки: картинку владелец только что
 * выбрал сам, и лишний поход на сервер ради того, что уже лежит в памяти браузера, — это
 * ожидание вместо мгновенного отклика.
 */
export function ListingImageUpload({ paths, onChange, disabled }: {
  paths: string[]
  onChange: (paths: string[]) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const accountId = useAgentStore((state) => state.accountId)
  // Превью ВЫВОДЯТСЯ из путей, а не синхронизируются с ними эффектом: родитель очистил список
  // после успешной генерации — миниатюры исчезли сами, потому что рисуется ровно то, что в paths.
  // Синхронный setState в эффекте здесь запускал бы каскад перерисовок, и правило проекта это
  // запрещает не из вкуса.
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const [busy, setBusy] = useState(false)
  const [rejected, setRejected] = useState<RejectedFile[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Ссылки на объекты живут до отзыва: без этого каждая перевыбранная фотография оставляет за
  // собой удерживаемый blob, и вкладка растёт, пока её не закроют.
  // Ref пишется В ЭФФЕКТЕ, а не во время рендера: чтение и запись ref по ходу рендера ломают
  // конкурентный режим React, и правило проекта это ловит.
  const held = useRef<Record<string, Preview>>({})
  useEffect(() => { held.current = previews }, [previews])
  useEffect(() => () => { Object.values(held.current).forEach((item) => URL.revokeObjectURL(item.url)) }, [])

  const add = async (files: File[]) => {
    if (!supabase || !accountId || accountId === 'demo' || disabled) return
    const { accepted, rejected: refused } = pickImages(files, paths.length)
    setRejected(refused)
    if (!accepted.length) return
    setBusy(true)
    const stored: Array<{ path: string; preview: Preview }> = []
    for (const file of accepted) {
      const path = imagePath(accountId, file.type, crypto.randomUUID())
      if (!path) continue
      const { error } = await supabase.storage.from(IMAGE_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      // Отказ Storage не отменяет остальные файлы: три загрузившихся фотографии лучше нуля.
      if (error) { setRejected((current) => [...current, { name: file.name, reason: 'size' }]); continue }
      stored.push({ path, preview: { url: URL.createObjectURL(file), name: file.name } })
    }
    setPreviews((current) => ({ ...current, ...Object.fromEntries(stored.map((item) => [item.path, item.preview])) }))
    onChange([...paths, ...stored.map((item) => item.path)])
    setBusy(false)
  }

  const remove = async (path: string) => {
    const preview = previews[path]
    if (preview) URL.revokeObjectURL(preview.url)
    setPreviews((current) => { const next = { ...current }; delete next[path]; return next })
    onChange(paths.filter((entry) => entry !== path))
    // Открепить — значит удалить: файл в приватном бакете, который никому не нужен, всё равно
    // занимает место и всё равно попадёт под суточную уборку. Убрать сразу честнее.
    if (supabase) await supabase.storage.from(IMAGE_BUCKET).remove([path]).catch(() => {})
  }

  const full = paths.length >= MAX_IMAGES

  return (
    <div className="space-y-2">
      <div
        onDragOver={(event) => { event.preventDefault(); if (!full && !disabled) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void add([...event.dataTransfer.files])
        }}
        onClick={() => { if (!full && !disabled) inputRef.current?.click() }}
        className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-3 text-xs transition ${
          dragging ? 'border-accent-cyan bg-accent-cyan/[0.06] text-accent-cyan'
            : full || disabled ? 'cursor-not-allowed border-ice/10 text-muted'
            : 'border-ice/15 text-muted hover:border-accent-cyan/50 hover:text-accent-cyan'
        }`}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
        <span>{full ? t('commerce.listing.photoFull') : t('commerce.listing.photoHint', { n: MAX_IMAGES - paths.length })}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(event) => {
          void add([...(event.target.files ?? [])])
          // Иначе повторный выбор того же файла не даст события: значение input не изменилось.
          event.target.value = ''
        }}
      />

      {/* Рисуется ровно то, что лежит в paths: родитель очистил список — миниатюры исчезли сами. */}
      {paths.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {paths.map((path) => previews[path] && (
            <div key={path} className="group relative">
              <img src={previews[path].url} alt={previews[path].name} className="h-16 w-16 rounded-lg border border-ice/10 object-cover" />
              <button
                type="button"
                onClick={() => void remove(path)}
                title={t('commerce.listing.photoRemove')}
                aria-label={t('commerce.listing.photoRemove')}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-panel p-0.5 text-muted shadow ring-1 ring-ice/15 hover:text-danger"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Причина у каждого отклонённого файла своя: владелец перетащил пять фотографий, увидел
          четыре — и должен знать, какая пропала и почему, а не догадываться. */}
      {rejected.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-amber">
          {rejected.map((item, index) => (
            <li key={`${item.name}-${index}`}>{item.name} — {t(`commerce.listing.photoRejected.${item.reason}`)}</li>
          ))}
        </ul>
      )}

      {/* Сказано прямо и рядом с кнопкой: по фотографии определяются вид, цвет и материал, но не
          габариты. Иначе владелец приложит снимок и будет ждать, что размеры заполнятся сами. */}
      <p className="text-[11px] leading-relaxed text-muted">{t('commerce.listing.photoProvenance')}</p>
    </div>
  )
}
