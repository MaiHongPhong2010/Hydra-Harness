/** Electron-owned launcher selection with a checked WSL catalog. */
import { useEffect, useState } from 'react'
import { Button, PreferenceRow } from '@hydraharness/harness-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'

/** Readiness and the launcher choice applied after clean shutdown. */
export interface EnvironmentStatus {
  active: string
  selected: string
  choices: { value: string; label: string; ready: boolean; reason?: string }[]
  reason?: string
}

/** Allowlisted Electron launcher operations. */
export interface EnvironmentApi {
  /**
 * @returns the saved choice, active environment and checked runtimes.
 */
  status(): Promise<EnvironmentStatus>
  /**
 * @param value - Native or a checked WSL distro.
 * @returns the persisted launcher choice.
 */
  select(value: string): Promise<EnvironmentStatus>
}

type Props = PropsRuntime<'settings.general.general.item'> & PropsLocale<'settings.desktop'> & InjectFace<{ api: EnvironmentApi }>

/**
 * @param props - launcher operations and locale.
 * @returns the environment control and readiness details.
 */
export function EnvironmentPreferenceRow({ api, t }: Props) {
  const [status, setStatus] = useState<EnvironmentStatus>()
  const [error, setError] = useState<string>()
  const [checking, setChecking] = useState(false)
  const refresh = async (): Promise<void> => {
    setChecking(true)
    setError(undefined)
    try { setStatus(await api.status()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setChecking(false) }
  }
  useEffect(() => { void refresh() }, [api])
  return <PreferenceRow title={t('environment.title')} description={t('environment.description')}
    value={status?.selected ?? 'native'} disabled={checking || status === undefined}
    options={(status?.choices ?? [{ value: 'native', label: 'Native', ready: true }]).map(choice => ({
      value: choice.value, label: choice.reason === undefined ? choice.label : `${choice.label}: ${choice.reason}`, disabled: !choice.ready,
    }))} savingLabel={t('saving')} appliesLabel={t('environment.applies')} onChange={async (value) => {
      if (typeof value !== 'string') throw new Error('Invalid agent environment')
      const accepted = await api.select(value)
      if (accepted.selected !== value) throw new Error('Could not save agent environment')
      setStatus(accepted)
    }} details={<>
      {status?.active !== undefined && <div>{t('environment.active')}: {status.active}</div>}
      {status?.reason !== undefined && <div>{status.reason}</div>}
      {status !== undefined && !status.choices.some(choice => choice.value === status.selected && choice.ready)
        && <div>{t('unavailable')}</div>}
      {error !== undefined && <div role="alert">{error}</div>}
    </>}>
    <Button size="sm" disabled={checking} onClick={() => { void refresh() }}>{t('environment.refresh')}</Button>
  </PreferenceRow>
}
