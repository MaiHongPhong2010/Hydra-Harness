/** Layout-owned scalar preferences and OS startup status. */
import { useEffect, useState } from 'react'
import { Button, PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
import type { DesktopPreferences } from '../preferences.ts'
import type { DesktopSettingsKey } from './desktop-locales.ts'
import type { NativePreferencesSnapshot } from './desktop-preferences.ts'

/** Feature-supplied snapshot, execution, and row metadata. */
export interface DesktopPreferenceRowInjected {
  field: keyof DesktopPreferences | 'startup'
  title: DesktopSettingsKey
  description: DesktopSettingsKey
  applies: DesktopSettingsKey
  choices?: readonly { value: string; label: DesktopSettingsKey }[]
  save: (value: string | boolean) => Promise<void>
  openStartup: () => Promise<void>
  hooks: {
    preferences: HostObservable<SettingsScopeSnapshot<DesktopPreferences>>
    native: HostObservable<NativePreferencesSnapshot>
  }
}

type Props = PropsRuntime<'settings.general.general.item'> & PropsLocale<'settings.desktop'> & InjectFace<DesktopPreferenceRowInjected>

/**
 * Render a preference backed by Host acceptance, or startup state owned by the OS.
 * @param props - row metadata and owner operations.
 * @returns the preference row, or no control before its namespace is available.
 */
export function DesktopPreferenceRow({ field, title, description, applies, choices, save, openStartup,
  usePreferences, useNative, t }: Props) {
  const state = usePreferences(value => value)
  const native = useNative(value => value)
  const [error, setError] = useState<string>()
  const [opening, setOpening] = useState(false)
  useEffect(() => { setError(undefined) }, [field])
  if (field === 'startup') {
    if (native.status?.startup.available !== true) return null
    return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', padding: '14px 0' }}>
      <div style={{ flex: 1, minWidth: 200 }}><div>{t(title)}</div><small>{t(description)}</small>
        <div>{t(native.status.startup.enabled ? 'startup.on' : 'startup.off')}</div>
        {error !== undefined && <div role="alert">{error}</div>}</div>
      <Button size="sm" disabled={opening} onClick={() => {
        setOpening(true)
        setError(undefined)
        void openStartup().catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
          .finally(() => { setOpening(false) })
      }}>{t('startup.open')}</Button>
    </div>
  }
  const value = state.value?.[field]
  if (value === undefined) return null
  const options = field === 'terminalShell'
    ? [{ value: '', label: t('shell.automatic') }, ...(native.status?.shells ?? [])]
    : choices?.map(choice => ({ value: choice.value, label: t(choice.label) }))
  const unavailable = typeof value === 'string' && options !== undefined && !options.some(option => option.value === value)
  return <PreferenceRow title={t(title)} description={unavailable ? `${t(description)} ${t('unavailable')}` : t(description)}
    value={value} disabled={!state.writable || (field === 'terminalShell' && native.status === undefined)} options={options}
    onChange={save} savingLabel={t('saving')} appliesLabel={t(applies)}>
    {native.error !== undefined && <div role="alert">{native.error}</div>}
  </PreferenceRow>
}
