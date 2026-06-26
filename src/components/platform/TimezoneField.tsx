import { useI18n } from '../../i18n'
import { TIMEZONES } from '../../data/platform'

const inputCls =
  'glass w-full rounded-xl px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted/70 focus:border-violet/50 focus:shadow-glow'

/**
 * Timezone picker: a free-text input backed by a <datalist> of common presets.
 * Users can pick a suggestion or type any IANA zone (e.g. America/New_York).
 */
export function TimezoneField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n()
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-normal text-muted">{t('platform.onboarding.timezone')}</span>
      <input
        list="nemo-timezones"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('platform.onboarding.tzCustomPh')}
        className={inputCls}
        spellCheck={false}
      />
      <datalist id="nemo-timezones">
        {TIMEZONES.map((tz) => (
          <option key={tz} value={tz} />
        ))}
      </datalist>
    </label>
  )
}

/** Base reply language: auto (mirror customer) or a forced language. */
export function LanguageField({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useI18n()
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-normal text-muted">{t('platform.onboarding.language')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        <option value="auto" className="bg-panel">{t('platform.onboarding.langAuto')}</option>
        <option value="uz" className="bg-panel">O‘zbekcha</option>
        <option value="ru" className="bg-panel">Русский</option>
        <option value="en" className="bg-panel">{t('platform.onboarding.langEn')}</option>
      </select>
    </label>
  )
}
