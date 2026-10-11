/** Decision preference and write-only Jev credential editor. */
import { useState, type ReactNode } from 'react'
import { Button } from '@hydraharness/harness-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { SettingsDescribeFace } from '@hydraharness/harness-client-ui-settings/client'
import type {} from '@hydraharness/harness-client-ui-settings-models/client'
import styles from './JevProviderOption.module.css'

/** Settings and credentials are acknowledged by the Host before showing success. */
export interface JevProviderInjected {
  hooks: { settings: SettingsDescribeFace }
  saveKey: (ref: string, value: string) => Promise<boolean>
  saveEnabled: (enabled: boolean, revision: number) => Promise<void>
}

type Props = PropsRuntime<'settings.models.decision'> & InjectFace<JevProviderInjected> & PropsLocale<'settings.models'>

/**
 * Render Off/Jev and an explicitly opened credential editor.
 * @param props - global settings, value-free credentials, and acknowledged writes.
 * @returns the advisory decision settings and credential controls.
 */
export function JevProviderOption(props: Props): ReactNode {
  const { t } = props
  const [editing, setEditing] = useState(false)
  const [key, setKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [keyError, setKeyError] = useState<string>()
  const [keySaved, setKeySaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<boolean>()
  const [failure, setFailure] = useState<string>()
  const [saved, setSaved] = useState(false)
  const settings = props.useSettings(value => value)
  const config = settings.view?.namespaces.find(row => row.ns === 'jev')?.value as
    { apiKeyEnv: string; model: string } | undefined
  const decision = settings.view?.namespaces.find(row => row.ns === 'browser-decisions')
  const ready = settings.error === null && config !== undefined && decision !== undefined
  const enabled = (decision?.value as { enabled?: boolean } | undefined)?.enabled !== false
  const disabled = props.readOnly || busy || !ready
  const select = async (next: boolean): Promise<void> => {
    if (disabled) return
    setPending(next)
    setBusy(true)
    setFailure(undefined)
    setSaved(false)
    try {
      await props.saveEnabled(next, decision.revision)
      setPending(undefined)
      setSaved(true)
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const saveKey = async (): Promise<void> => {
    if (props.readOnly || savingKey || !ready) return
    const value = key.trim()
    if (value === '') { setKeyError(t('decisionKeyRequired')); return }
    setSavingKey(true)
    setKeyError(undefined)
    try {
      if (!await props.saveKey(config.apiKeyEnv, value)) { setKeyError(t('decisionKeyError')); return }
      setKey('')
      setEditing(false)
      setKeySaved(true)
    } catch { setKeyError(t('decisionKeyError')) }
    finally { setSavingKey(false) }
  }
  return <div className={styles['editor']}>
    <label className={styles['field']}>
      <span>{t('decisionModel')}</span>
      <select data-hydra-control="field" aria-label={t('decisionModel')} disabled={disabled}
        value={ready && (pending ?? enabled) ? 'jev' : 'off'}
        onChange={(event) => { void select(event.currentTarget.value === 'jev') }}>
        <option value="off">{t('decisionOff')}</option>
        <option value="jev" disabled={!ready}>Jev</option>
      </select>
    </label>
    <p className={styles['description']}>{t('decisionHint')}</p>
    {!ready ? <>
      <p className={styles['description']} role="status">{t(settings.status === 'loading' || settings.status === 'idle'
        ? 'decisionLoading' : 'decisionSettingsUnavailable')}</p>
      <Button variant="outline" onClick={() => { props.openSection('plugins') }}>{t('managePlugins')}</Button>
    </> : <>
      <p className={styles['description']}>{`${t('decisionModelLabel')}: ${config.model}`}</p>
      <p className={styles['description']} role="status">{props.credentials[config.apiKeyEnv]?.configured === true
        ? t('credentialConfigured') : t('credentialMissing')}</p>
      <Button variant="outline" disabled={props.readOnly || savingKey}
        onClick={() => { setEditing(true); setKeySaved(false) }}>{t('configureDecision')}</Button>
    </>}
    {busy ? <p role="status">{t('saving')}</p> : saved && <p role="status">{t('decisionSaved')}</p>}
    {failure !== undefined && <>
      <p className={styles['error']} role="alert">{failure}</p>
      <div className={styles['actions']}>
        <Button variant="outline" disabled={disabled} onClick={() => { void select(pending ?? enabled) }}>{t('retry')}</Button>
        <Button variant="outline" disabled={busy}
          onClick={() => { setPending(undefined); setFailure(undefined) }}>{t('discard')}</Button>
      </div>
    </>}
    {editing && <>
      <label className={styles['field']}>
        <span>{t('keyInput')}</span>
        <input data-hydra-control="field" type="password" value={key} autoComplete="off" disabled={props.readOnly || savingKey || !ready}
          onChange={(event) => { setKey(event.currentTarget.value); setKeyError(undefined) }} />
      </label>
      {keyError !== undefined && <p className={styles['error']} role="alert">{keyError}</p>}
      <div className={styles['actions']}>
        <Button variant="outline" disabled={props.readOnly || savingKey || !ready}
          onClick={() => { void saveKey() }}>{t(savingKey ? 'saving' : 'apply')}</Button>
        <Button variant="outline" disabled={savingKey}
          onClick={() => { setKey(''); setKeyError(undefined); setEditing(false) }}>{t('cancel')}</Button>
      </div>
    </>}
    {keySaved && <p role="status">{t('decisionKeySaved')}</p>}
  </div>
}
