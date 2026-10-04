/** Shared image/video choices filtered by saved model endpoint metadata. */
import { useEffect, useState } from 'react'
import type { IApiClient, ModelProviderGroup, SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import { EditorFooter } from './EditorFooter.tsx'
import { messageOf } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const fields = ['imageModel', 'videoModel'] as const
type Field = typeof fields[number]
type Selection = { provider: string; model: string }

function selected(value: unknown): Selection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model } = value as Record<string, unknown>
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
}

/**
 * Render the page's two generation selectors and revision-checked Apply.
 * @param props - complete-catalog wire face, settings snapshot, and refresh callback.
 * @returns the shared generation settings section.
 */
export function GenerationModels({ namespace, catalogRevision, schema, api, readOnly, onSaved, t }: {
  namespace: SettingsNamespaceView
  catalogRevision: string
  schema: SettingsSchemaOperations
  api: Pick<IApiClient, 'llm' | 'settings'>
  readOnly: boolean
  onSaved: () => Promise<void>
  t: (key: keyof typeof en) => string
}) {
  const [groups, setGroups] = useState<ModelProviderGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogFailure, setCatalogFailure] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<{ revision: number; choices: Record<Field, string> }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setCatalogFailure(undefined)
    void api.llm.models({}).then((response) => {
      if (!active) return
      if (!response.result.ok) { setCatalogFailure(response.result.error.message); return }
      setGroups(response.result.value.groups)
      const errors = response.result.value.failures
      if (errors.length > 0) setCatalogFailure(errors.map(error => error.message).join('\n'))
    }, (error: unknown) => { if (active) setCatalogFailure(messageOf(error)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api.llm, catalogRevision, attempt])
  const catalogs = Object.fromEntries(fields.map(field => [field, groups.map(group => ({
    ...group, models: group.models.filter(model => model.endpoints?.includes(field === 'imageModel' ? 'images/generations' : 'videos')),
  })).filter(group => group.models.length > 0)])) as Record<Field, ModelProviderGroup[]>
  const choices = Object.fromEntries(fields.map(field => [field, new Map(catalogs[field].flatMap(group => group.models.map(model => [
    JSON.stringify([group.id, model.id]), { provider: group.id, model: model.id },
  ] as const)))])) as Record<Field, Map<string, Selection>>
  const saved = Object.fromEntries(fields.map((field) => {
    const value = selected(schema.getPath(namespace.value, [field]))
    return [field, value === undefined ? '' : JSON.stringify([value.provider, value.model])]
  })) as Record<Field, string>
  const values = draft?.choices ?? saved
  const unavailable = fields.some(field => values[field] !== '' && !choices[field].has(values[field]))
  const apply = async (pending: NonNullable<typeof draft>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await api.settings.mutate({
        ns: namespace.ns, expectedRevision: pending.revision,
        ops: fields.map((field) => {
          if (pending.choices[field] === '') return { op: 'unset', path: [field] }
          const value = choices[field].get(pending.choices[field]) as Selection
          return { op: 'set', path: [field], value }
        }),
      })
      if (!response.result.ok) { setFailure(response.result.error.message); return }
      await onSaved()
      setDraft(undefined)
    } catch (error) { setFailure(messageOf(error)) }
    finally { setBusy(false) }
  }
  return (
    <section className={styles['generationModels']} aria-label={t('generationModels')} aria-busy={loading || busy}>
      <div className={styles['modelListHead']}>
        <h3 className={styles['modelCatalogTitle']}>{t('generationModels')}</h3>
        <button type="button" className={styles['linkButton']} disabled={loading || busy}
          onClick={() => { setAttempt(value => value + 1) }}>{t('refreshModels')}</button>
      </div>
      <p className={styles['advancedHint']}>{t('generationModelsHint')}</p>
      {fields.map(field => (
        <label key={field} className={styles['field']}>
          <span className={styles['fieldLabel']}>{t(field)}</span>
          <select data-hydra-control="field" className={styles['input']} aria-label={t(field)}
            value={values[field]} disabled={readOnly || loading || busy}
            onChange={(event) => {
              const value = event.currentTarget.value
              setFailure(undefined)
              setDraft(current => ({ revision: current?.revision ?? namespace.revision,
                choices: { ...current?.choices ?? saved, [field]: value } }))
            }}>
            <option value="">{t('generationModelUnset')}</option>
            {values[field] !== '' && !choices[field].has(values[field]) && <option value={values[field]} disabled>{t('generationModelUnavailable')}</option>}
            {catalogs[field].map(group => <optgroup key={group.id} label={`${group.name} (${group.id})`}>
              {group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>
                {`${group.name} / ${model.name === model.id ? model.id : `${model.name} (${model.id})`}`}
              </option>)}
            </optgroup>)}
          </select>
        </label>
      ))}
      {catalogFailure !== undefined && <p className={styles['error']} role="alert">{catalogFailure}</p>}
      {failure !== undefined && <p className={styles['error']} role="alert">{failure}</p>}
      {draft !== undefined && <EditorFooter t={t} busy={busy} submitDisabled={readOnly || busy || loading || unavailable}
        submitLabel="apply" submitBusyLabel="applying" cancelLabel="discard"
        onCancel={() => { setDraft(undefined); setFailure(undefined) }} onSubmit={() => { void apply(draft) }} />}
    </section>
  )
}
