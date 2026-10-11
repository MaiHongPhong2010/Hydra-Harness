/** User gate for effects that only fire on explicit request. */
import { PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'

type Props = PropsRuntime<'settings.general.toys.item'> & PropsLocale<'settings.desktop'> & InjectFace<{
  save: (value: boolean) => Promise<void>
  hooks: { toys: HostObservable<SettingsScopeSnapshot<{ confetti: boolean }>> }
}>

/**
 * @param props - acknowledged preference and mutation.
 * @returns the confetti opt-in.
 */
export function ToysPreferenceRow({ useToys, save, t }: Props) {
  const state = useToys(value => value)
  if (state.value === undefined) return null
  return <PreferenceRow title={t('toys.title')} description={t('toys.description')} value={state.value.confetti}
    disabled={!state.writable} onChange={async (value) => { if (typeof value !== 'boolean') throw new Error('Invalid confetti choice'); await save(value) }}
    savingLabel={t('saving')} appliesLabel={t('applied')} />
}
