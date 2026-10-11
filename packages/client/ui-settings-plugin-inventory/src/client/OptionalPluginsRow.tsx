/** Global optional-plugin policy, preserving individual plugin preferences. */
import { PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
/** Accepted gate and owning mutation. */
export interface OptionalPluginsRowInjected {
  save: (enabled: boolean) => Promise<void>
  hooks: { policy: HostObservable<SettingsScopeSnapshot<{ enabled: boolean }>> }
}
type Props = PropsRuntime<'settings.general.general.item'> & PropsLocale<'settings.pluginInventory'> & InjectFace<OptionalPluginsRowInjected>
/** @param props - Host gate snapshot and writer. @returns the optional-plugin preference. */
export function OptionalPluginsRow({ usePolicy, save, t }: Props) {
  const state = usePolicy(value => value)
  if (state.value === undefined) return null
  return <PreferenceRow title={t('optional.title')} description={t('optional.description')} value={state.value.enabled}
    disabled={!state.writable} onChange={value => save(value === true)} savingLabel={t('optional.saving')} appliesLabel={t('optional.applies')} />
}
