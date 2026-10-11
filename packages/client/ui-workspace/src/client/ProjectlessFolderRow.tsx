/** Standalone-chat storage root owned by the Host workspace registry. */
import { Button, PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'

/** Acknowledged workspace-root preference and Host directory picker. */
export interface ProjectlessFolderInjected {
  save: (root: string) => Promise<void>
  pick: () => Promise<void>
  hooks: { tasks: HostObservable<SettingsScopeSnapshot<{ root: string }>> }
}
type Props = PropsRuntime<'settings.general.general.item'> & PropsLocale<'workspace'> & InjectFace<ProjectlessFolderInjected>
/** @param props - accepted root and owning operations. @returns the scalar root preference. */
export function ProjectlessFolderRow({ useTasks, save, pick, t }: Props) {
  const state = useTasks(value => value)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string>()
  if (state.value === undefined) return null
  return <PreferenceRow title={t('tasks.title')} description={t('tasks.description')} value={state.value.root}
    disabled={!state.writable} onChange={value => save(String(value))} savingLabel={t('tasks.saving')} appliesLabel={t('tasks.applies')}>
    <Button size="sm" disabled={!state.writable || picking} onClick={() => {
      setPicking(true); setError(undefined)
      void pick().catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      }).finally(() => { setPicking(false) })
    }}>{t('tasks.change')}</Button>
    {error !== undefined && <div role="alert">{error}</div>}
  </PreferenceRow>
}
