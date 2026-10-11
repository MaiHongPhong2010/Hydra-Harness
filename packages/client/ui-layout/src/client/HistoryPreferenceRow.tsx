/** Presentation for the JSONL persistence owner's restart preference. */
import { PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'

/** Storage owner's accepted preference and mutation. */
export interface HistoryPreferenceRowInjected {
  save: (enabled: boolean) => Promise<void>
  hooks: { history: HostObservable<SettingsScopeSnapshot<{ compression: 'none' | 'zstd' }>> }
}

type Props = PropsRuntime<'settings.general.general.item'> & PropsLocale<'settings.desktop'> & InjectFace<HistoryPreferenceRowInjected>

/**
 * Render compression only when the Host serves a JSONL persistence preference.
 * @param props - storage-owned snapshot and mutation.
 * @returns the history preference or no row for another backend.
 */
export function HistoryPreferenceRow({ useHistory, save, t }: Props) {
  const state = useHistory(value => value)
  if (state.value === undefined) return null
  return <PreferenceRow title={t('history.title')} description={t('history.description')}
    value={state.value.compression === 'zstd'} disabled={!state.writable}
    onChange={value => save(value === true)} savingLabel={t('saving')} appliesLabel={t('history.applies')} />
}
