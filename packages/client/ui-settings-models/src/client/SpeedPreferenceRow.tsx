/** Provider-aware processing speed independent of model selection. */
import { useEffect, useState } from 'react'
import { PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { IApiClient, ModelProviderGroup, SessionId } from '@hydraharness/harness-api-remotes/client'
import type { SettingsScopeSnapshot } from '@hydraharness/harness-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'

/** The LLM owner's settings, catalog and fresh request history. */
export interface SpeedPreferenceRowInjected {
  api: Pick<IApiClient, 'llm' | 'sessions'>
  current: () => SessionId | undefined
  save: (tier: string) => Promise<void>
  hooks: {
    speed: HostObservable<SettingsScopeSnapshot<{ tier: 'standard' | 'priority' }>>
    model: HostObservable<SettingsScopeSnapshot<{ provider: string; model: string }>>
  }
}
type Props = PropsRuntime<'settings.general.general.item'> & PropsLocale<'settings.models'> & InjectFace<SpeedPreferenceRowInjected>

/**
 * @param props - accepted preferences and capability lookup.
 * @returns the processing-tier selector.
 */
export function SpeedPreferenceRow({ api, current, save, useSpeed, useModel, t }: Props) {
  const speed = useSpeed(value => value)
  const model = useModel(value => value.value)
  const [groups, setGroups] = useState<ModelProviderGroup[]>([])
  const [error, setError] = useState<string>()
  const [actual, setActual] = useState<string>()
  const [requested, setRequested] = useState<string>()
  const [route, setRoute] = useState<{ provider: string; model: string }>()
  const sessionId = current()
  useEffect(() => {
    let mounted = true
    setActual(undefined)
    setRequested(undefined)
    setRoute(undefined)
    setError(undefined)
    void api.llm.models({}).then((response) => {
      if (!mounted) return
      if (response.result.ok) setGroups(response.result.value.groups)
      else setError(response.result.error.message)
    }, (failure: unknown) => { if (mounted) setError(String(failure)) })
    if (sessionId !== undefined) void api.sessions.history({ sessionId, maxMessages: 1 }).then((response) => {
      if (!mounted) return
      if (!response.result.ok) { setError(response.result.error.message); return }
      for (const { event } of response.result.value.events) {
        if (event.type === 'request/header') {
          setRoute(event.data.header.config)
          setRequested(event.data.header.config.requestedServiceTier ?? event.data.header.config.serviceTier ?? 'standard')
        }
        if (event.type === 'assistant/chunk' && event.data.chunk.type === 'finish') setActual(event.data.chunk.serviceTier)
      }
    }, (failure: unknown) => { if (mounted) setError(String(failure)) })
    return () => { mounted = false }
  }, [api, sessionId, model?.provider, model?.model])
  if (speed.value === undefined) return null
  const selected = route ?? model
  const capability = groups.find(group => group.id === selected?.provider)?.models.find(entry => entry.id === selected?.model)
  const priority = capability?.serviceTiers?.includes('priority') === true
  return <PreferenceRow title={t('speed.title')} description={priority ? t('speed.description') : t('speed.unavailable')}
    value={speed.value.tier} disabled={!speed.writable} onChange={value => save(String(value))}
    options={[{ value: 'standard', label: 'Standard' }, { value: 'priority', label: 'Priority', disabled: !priority }]}
    savingLabel={t('speed.saving')} appliesLabel={t('speed.applies')} details={<>
      {sessionId !== undefined && <div>{t('speed.requested')}: {requested ?? speed.value.tier}. {t('speed.actual')}: {actual ?? t('speed.unknown')}</div>}
      {error !== undefined && <div role="alert">{error}</div>}
    </>} />
}
