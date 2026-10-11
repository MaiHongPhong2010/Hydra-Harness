/** Global chat default over the same catalog and settings mirror as Models. */
import { useState } from 'react'
import type { IApiClient, ModelProviderGroup, SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { supportsConversation } from '@hydraharness/harness-llm/model-endpoints'
import { Button } from '@hydraharness/harness-client-ui-primitives'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Save the model for future Agents without switching an existing session.
 * @param props - Host catalog, global namespace, and acknowledged settings callbacks.
 * @returns the default selector with saving, retry, and availability states.
 */
export function DefaultChatModel({ namespace, groups, loading, readOnly, api, onSaved, t }: {
  namespace: SettingsNamespaceView
  groups: readonly ModelProviderGroup[]
  loading: boolean
  readOnly: boolean
  api: Pick<IApiClient, 'settings'>
  onSaved: (view: SettingsNamespaceView) => Promise<void>
  t: (key: keyof typeof en) => string
}) {
  const value = namespace.value as { provider: string; model: string; reasoningEffort?: string }
  const saved = JSON.stringify([value.provider, value.model])
  const [draft, setDraft] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [savedNotice, setSavedNotice] = useState(false)
  const catalogs = groups.map(group => ({ ...group, models: group.models.filter(model => supportsConversation(model.endpoints)) }))
    .filter(group => group.models.length > 0)
  const choices = new Map(catalogs.flatMap(group => group.models.map(model => [
    JSON.stringify([group.id, model.id]), { provider: group.id, model },
  ] as const)))
  const selected = draft ?? saved
  const [provider, model] = JSON.parse(selected) as [string, string]
  const unavailableLabel = provider === '__unselected__' && model === '__unselected__'
    ? t('defaultModelUnselected') : `${model} — ${t('generationModelUnavailable')}`
  const apply = async (key: string): Promise<void> => {
    const choice = choices.get(key)
    if (choice === undefined || busy || readOnly) return
    setDraft(key)
    setBusy(true)
    setFailure(undefined)
    setSavedNotice(false)
    const effort = key === saved ? value.reasoningEffort : choice.model.reasoning?.defaultEffort
    try {
      const response = await api.settings.mutate({ ns: namespace.ns, expectedRevision: namespace.revision, ops: [
        { op: 'set', path: ['provider'], value: choice.provider },
        { op: 'set', path: ['model'], value: choice.model.id },
        effort === undefined ? { op: 'unset', path: ['reasoningEffort'] } : { op: 'set', path: ['reasoningEffort'], value: effort },
      ] })
      if (!response.result.ok) {
        setFailure(response.result.error.message)
        if (response.result.error.code === 'settings-conflict') {
          const refreshed = await api.settings.describe({})
          if (!refreshed.result.ok) throw new Error(refreshed.result.error.message)
          const latest = refreshed.result.value.namespaces.find(row => row.ns === namespace.ns)
          if (latest !== undefined) await onSaved(latest)
        }
        return
      }
      await onSaved(response.result.value)
      setDraft(undefined)
      setSavedNotice(true)
    } catch (error) { setFailure(messageOf(error)) }
    finally { setBusy(false) }
  }
  return <section className={styles['generationModels']} aria-label={t('defaultModel')} aria-busy={busy}>
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('defaultModel')}</span>
      <select data-hydra-control="field" className={styles['input']} aria-label={t('defaultModel')}
        value={selected} disabled={readOnly || loading || busy} onChange={(event) => { void apply(event.currentTarget.value) }}>
        {!choices.has(selected) && <option value={selected} disabled>{unavailableLabel}</option>}
        {catalogs.map(group => <optgroup key={group.id} label={`${group.name} (${group.id})`}>
          {group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>
            {model.name || model.id}
          </option>)}
        </optgroup>)}
      </select>
    </label>
    <p className={styles['advancedHint']}>{t('defaultModelHint')}</p>
    {busy ? <p role="status" className={styles['advancedHint']}>{t('saving')}</p>
      : savedNotice && <p role="status" className={styles['savedNotice']}>{t('defaultModelSaved')}</p>}
    {failure !== undefined && <>
      <p className={styles['error']} role="alert">{failure}</p>
      <div className={styles['addActions']}>
        <Button variant="outline" disabled={busy || loading || readOnly || !choices.has(selected)}
          onClick={() => { void apply(selected) }}>{t('retry')}</Button>
        <Button variant="outline" disabled={busy}
          onClick={() => { setDraft(undefined); setFailure(undefined) }}>{t('discard')}</Button>
      </div>
    </>}
  </section>
}
