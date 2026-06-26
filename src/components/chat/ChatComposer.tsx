import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { useI18n } from '../../i18n'
import { cn } from '../../lib/cn'

export function ChatComposer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const autoGrow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  return (
    <div className="px-4 pb-4 pt-2 sm:px-6">
      <div
        className={cn(
          'glass flex items-end gap-2 rounded-2xl p-2 transition-all',
          disabled ? 'opacity-70' : 'focus-within:border-cobalt/50 focus-within:shadow-glow',
        )}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            autoGrow()
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          aria-label={t('chat.composerPlaceholder')}
          placeholder={t('chat.composerPlaceholder')}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text outline-none placeholder:text-muted disabled:cursor-not-allowed"
        />
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cobalt/50 text-cobalt transition-colors hover:bg-cobalt/10 disabled:opacity-40"
          aria-label={t('chat.send')}
        >
          <ArrowUp size={18} />
        </button>
      </div>
      <p className="mt-2 px-1 text-center text-[11px] text-muted">{t('chat.composerHint')}</p>
    </div>
  )
}
