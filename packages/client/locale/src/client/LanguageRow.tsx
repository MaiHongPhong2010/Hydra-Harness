/**
 * Language preference row registered into the General section item slot
 * (figma 501:30011 'Setting-Cell'): title + selector pill opening the locale
 * menu. Registered by this package — the locale feature owns its own
 * settings surface.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@hydraharness/harness-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@hydraharness/harness-client-ui-primitives'
import type {} from '@hydraharness/harness-client-ui-settings/client'
import type { createLanguageRowStore } from './settings-store.ts'
import css from './LanguageRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface LanguageRowInjected {
  /** Switch the active locale (a registered locale id). */
  setLocale: (id: string) => Promise<void>
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type LanguageRowComponentProps =
  PropsRuntime<'settings.general.general.item'> & PropsStore<ReturnType<typeof createLanguageRowStore>>
  & PropsLocale<'settings.locale'> & LanguageRowInjected

/**
 * Render the Language row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function LanguageRow({ t, setLocale, useStore }: LanguageRowComponentProps) {
  const active = useStore(s => s.active)
  const options = useStore(s => s.options)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const activeLabel = options.find(o => o.id === active)?.label ?? active

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('language.title')}</div>
        <div role="status" className={css.description}>{saving ? t('language.saving') : saved ? t('language.applies') : t('language.description')}</div>
        {error !== undefined && <div role="alert">{error}</div>}
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={options.map(o => ({ id: o.id, label: o.label }))}
        selectedId={active}
        onSelect={(id) => {
          setOpen(false)
          setSaving(true); setSaved(false); setError(undefined)
          void setLocale(id).then(() => { setSaved(true) }, (failure: unknown) => {
            setError(failure instanceof Error ? failure.message : String(failure))
          }).finally(() => { setSaving(false) })
        }}
        align="end"
        portal
        anchor={(
          <button data-hydra-control="field"
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={saving}
            onClick={() => { setOpen(v => !v) }}
          >
            {activeLabel}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
