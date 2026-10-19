/**
 * Provider model drafts and discovery, including separately addressed catalogs
 * fetched together by the shared Google account editor.
 *
 * The list is the profile's `models` array as the card holds it: an empty list
 * means "serve this route's built-in catalog", and any entry replaces that
 * catalog, so a row is only ever added deliberately. Fetching asks the endpoint
 * **the form currently shows** — including a key typed but not yet saved — so
 * adding a provider is one pass instead of save-then-return. Fetch offers
 * candidates for adoption; Get all adopts the complete listing into
 * the local draft. Apply saves it for the page's shared generation selectors.
 * Candidate names and image/video roles are editable before adoption; missing or cleared names
 * remain unset rather than falling back to the model id.
 *
 * A provider that cannot be interrogated (an unreachable endpoint, a protocol
 * with no readable listing) is not a dead end: the failure is shown next to the
 * rows the user can still fill in by hand.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DiscoveredModelView, IApiClient } from '@hydraharness/harness-api-remotes/client'
import { inferModelEndpoints } from '@hydraharness/harness-llm/model-endpoints'
import { Button, Modal } from '@hydraharness/harness-client-ui-primitives'
import { formatCapacity, parseCapacity } from './DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import { ModelColumnHeaders, ModelTypeCheckbox } from './ModelClassification.tsx'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * One configured model row. Structurally open, exactly like the DeepSeek
 * catalog editor's rows: a profile field this card does not edit — one a future
 * schema adds, or one hand-written in `settings.yaml` — has to survive being
 * edited here rather than being dropped by a rebuild.
 */
export type ModelDraft = DeepSeekModelDraft

/** A row's text field, or the empty string when unset or not a string. */
function textOf(model: ModelDraft, key: string): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A row's numeric field, or `undefined` when unset or not a number. */
function numberOf(model: ModelDraft, key: string): number | undefined {
  const value = model[key]
  return typeof value === 'number' ? value : undefined
}

/** Use explicit classification first, then the adapter's shared family hints. */
function endpointsOf(model: ModelDraft): readonly string[] | undefined {
  const endpoints = model['endpoints'] as string[] | undefined
  return endpoints === undefined || endpoints.length === 0 ? inferModelEndpoints(textOf(model, 'id')) : endpoints
}

/** What an interrogation needs, taken from the live form. */
export interface ProbeTarget {
  /** Settings namespace whose adapter family answers. */
  settingsNs: string
  /**
   * Route being edited, when the card edits one. An adapter that already
   * describes it answers from its own registry, so such a card can ask without
   * an endpoint at all.
   */
  provider?: string
  /** Endpoint as the form currently shows it. */
  baseURL?: string
  /** Optional HTTP(S) network proxy for endpoint interrogation. */
  proxy?: string
  /** Wire protocol the form names, when it names one. */
  api?: string
  /** Key typed into the form and not yet stored, when there is one. */
  apiKey?: string
}

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  /** The rows as currently drafted. */
  models: readonly ModelDraft[]
  /** Whether the user layer currently owns the whole array; absent on a create. */
  overridden?: boolean
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Remove the user-owned array and return to inheritance; absent on a create. */
  onReset?: () => void
  /** Endpoint facts for the fetch action. */
  probe: ProbeTarget
  /** Additional unsaved keys tried after the primary probe key. */
  probeKeys?: readonly string[]
  /** Backend name shown when this editor participates in shared discovery. */
  catalogLabel?: string | undefined
  /** A second catalog fetched together and adopted into its own draft. */
  relatedCatalog?: {
    label: string
    probe: ProbeTarget
    models: readonly ModelDraft[]
    onChange: (models: ModelDraft[]) => void
  } | undefined
  /** Let a neighboring editor own shared discovery while retaining row edits. */
  hideDiscoveryActions?: boolean
  /** Fetch and show candidates once when an account shortcut opens this editor. */
  fetchOnOpen?: boolean | undefined
  /**
   * Copy key naming why the fetch action is unavailable, or `undefined` when
   * it is. The card owns this because the key it would send is judged there:
   * asking with a key the form has already refused spends a round trip to be
   * told what the field already says.
   */
  probeBlocked?: keyof typeof en | undefined
  /** Wire face the fetch action calls. */
  api: Pick<IApiClient, 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every control (read-only deployment or a pending write). */
  disabled: boolean
}

/** Discovery identity includes the destination catalog, so equal ids remain distinct. */
type Candidate = DiscoveredModelView & { catalog: 'primary' | 'related' }

/** Selection and edits address a model within its catalog. */
function candidateKey(candidate: Candidate): string {
  return JSON.stringify([candidate.catalog, candidate.id])
}

/** Disclosure chevron; rotates to point down while its row is open. */
function IconChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden
      style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms ease' }}
    >
      <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Removal glyph for one model row. */
function IconTrash(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** The two token counts edited as K/M-suffixed text behind a row's disclosure. */
type CapacityField = 'contextWindow' | 'maxTokens'

/**
 * Context fallback hint; K input uses decimal counts while the adapter's
 * default is 131072. Route overrides are not available to this editor.
 */
const CONTEXT_WINDOW_HINT = '128K'

/**
 * Spell a stored count for a field that may be unset. The spelling itself is
 * {@link formatCapacity}, shared with the DeepSeek catalog editor so both
 * surfaces read and write one K/M vocabulary.
 * @param value - stored capacity, or `undefined` for an unset field.
 * @returns the field text, empty when unset.
 */
function capacitySpelling(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/** Adopt a candidate, keeping whatever capacities the provider disclosed. */
function adopt(candidate: DiscoveredModelView): ModelDraft {
  return {
    id: candidate.id,
    ...candidate.name === undefined || candidate.name === '' ? {} : { name: candidate.name },
    ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
    ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
    ...candidate.endpoints === undefined ? {} : { endpoints: [...candidate.endpoints] },
  }
}

/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, wire face, and copy.
 * @returns the model-list editor.
 */
export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { models, onChange, probe, api, t, disabled } = props
  const [busy, setBusy] = useState(false)
  const fetchedOnOpen = useRef(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly Candidate[] | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [classified, setClassified] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  // Capacities are edited as text, so a field's keystrokes are held here rather
  // than re-derived from the parsed count on every change — that would rewrite
  // `1000` to `1K` mid-word. Unreadable text is kept past blur so the refusal
  // names a row the user can still see, which is why this is one entry PER
  // FIELD: a single buffer would be displaced by editing any other field, and
  // the abandoned one would render its stored NaN as the literal `NaN`.
  const [editing, setEditing] = useState<ReadonlyMap<string, string>>(new Map())

  /** Buffer key for one capacity field; the row half moves when rows do. */
  const bufferKey = (index: number, field: CapacityField): string => `${String(index)}:${field}`

  const editCapacity = (index: number, field: CapacityField, text: string): void => {
    setEditing(current => new Map(current).set(bufferKey(index, field), text))
    patch(index, { [field]: parseCapacity(text) })
  }

  /** What a capacity field shows: the buffer while typing, else the stored count. */
  const capacityText = (model: ModelDraft, index: number, field: CapacityField): string =>
    editing.get(bufferKey(index, field)) ?? capacitySpelling(numberOf(model, field))

  /** Drop one row's entries and shift the rows after it down, in one pass. */
  const reindexOnRemove = (
    current: ReadonlyMap<string, string>,
    index: number,
  ): Map<string, string> => {
    const next = new Map<string, string>()
    for (const [key, value] of current) {
      const at = Number(key.slice(0, key.indexOf(':')))
      if (at === index) continue
      // Only the row number moves; the field half of the key is untouched.
      next.set(at > index ? key.replace(/^\d+/, String(at - 1)) : key, value)
    }
    return next
  }

  const toggleExpanded = (index: number): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })
  }

  const patch = (index: number, next: Record<string, unknown>): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return model
      // Rebuilt rather than spread over: an emptied optional field has to leave
      // the profile, not be stored as a value its schema would reject.
      // Spread first so a field this card does not edit survives; an emptied
      // optional field is then dropped rather than stored as a value its
      // schema would reject.
      const cleared = new Set(
        Object.entries(next).filter(([, value]) => value === undefined || value === '').map(([key]) => key),
      )
      return Object.fromEntries(
        Object.entries({ ...model, ...next }).filter(([key]) => !cleared.has(key)),
      )
    }))
  }

  const catalogs = [
    { catalog: 'primary' as const, label: props.catalogLabel, probe, models, onChange },
    ...props.relatedCatalog === undefined ? [] : [{ catalog: 'related' as const, ...props.relatedCatalog }],
  ]

  const adoptCandidates = (found: readonly Candidate[], selected: ReadonlySet<string>, edited: ReadonlySet<string>): void => {
    for (const target of catalogs) {
      const additions = found.filter(candidate => candidate.catalog === target.catalog && selected.has(candidateKey(candidate)))
      if (additions.length === 0) continue
      const byId = new Map(target.models.map(model => [textOf(model, 'id'), model]))
      for (const candidate of additions) {
        const existing = byId.get(candidate.id)
        byId.set(candidate.id, existing === undefined ? adopt(candidate)
          : edited.has(candidateKey(candidate)) ? { ...existing, endpoints: candidate.endpoints } : existing)
      }
      target.onChange([...byId.values()])
    }
  }

  const fetchModels = async (adoptAll = false): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const responses = await Promise.allSettled(catalogs.map(async (target) => {
        const probe = target.probe
        const request = {
          settingsNs: probe.settingsNs,
          ...probe.provider === undefined ? {} : { provider: probe.provider },
          ...probe.baseURL === undefined || probe.baseURL.length === 0 ? {} : { baseURL: probe.baseURL },
          ...probe.proxy === undefined || probe.proxy.length === 0 ? {} : { proxy: probe.proxy },
          ...probe.api === undefined ? {} : { api: probe.api },
          ...probe.apiKey === undefined ? {} : { apiKey: probe.apiKey },
        }
        let response = await api.llm.discoverModels(request)
        for (const apiKey of target.catalog === 'primary' ? props.probeKeys ?? [] : []) {
          if (response.result.ok) break
          response = await api.llm.discoverModels({ ...request, apiKey })
        }
        if (!response.result.ok) throw new Error(response.result.error.message)
        return response.result.value.models.map(candidate => ({ ...candidate, catalog: target.catalog }))
      }))
      const found: Candidate[] = []
      const errors: string[] = []
      responses.forEach((response, index) => {
        if (response.status === 'fulfilled') found.push(...response.value)
        else {
          const label = catalogs[index]?.label
          errors.push(`${label === undefined ? '' : `${label}: `}${messageOf(response.reason)}`)
        }
      })
      setFailure(errors.length === 0 ? undefined : errors.join(' · '))
      if (found.length === 0) {
        if (errors.length === 0) setFailure(t('fetchEmpty'))
        return
      }
      if (adoptAll) {
        adoptCandidates(found, new Set(found.map(candidateKey)), new Set())
        return
      }
      // Everything already configured starts unchecked, so adopting a
      // selection never silently rewrites a capacity the user corrected.
      const known = new Set(catalogs.flatMap(target => target.models.map(model =>
        candidateKey({ id: textOf(model, 'id'), catalog: target.catalog }))))
      setCandidates(found.map((candidate) => {
        const saved = (candidate.catalog === 'primary' ? models : props.relatedCatalog?.models)
          ?.find(model => textOf(model, 'id') === candidate.id)
        const endpoints = saved?.['endpoints'] as string[] | undefined
        return endpoints === undefined || endpoints.length === 0 ? candidate : { ...candidate, endpoints }
      }))
      setClassified(new Set())
      setPicked(new Set(found.filter(model => !known.has(candidateKey(model))).map(candidateKey)))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (props.fetchOnOpen !== true || fetchedOnOpen.current) return
    fetchedOnOpen.current = true
    void fetchModels()
  }, [props.fetchOnOpen, fetchModels])

  const closePicker = (): void => {
    setCandidates(undefined)
    setPicked(new Set())
    setClassified(new Set())
  }

  const adoptPicked = (): void => {
    /* v8 ignore next -- the dialog only renders with candidates loaded */
    if (candidates === undefined) return
    adoptCandidates(candidates, picked, classified)
    closePicker()
  }

  const toggle = (id: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const activeCandidates = candidates ?? []
  const allCandidatesPicked = activeCandidates.length > 0
    && activeCandidates.every(candidate => picked.has(candidateKey(candidate)))

  const toggleAllCandidates = (): void => {
    setPicked((current) => {
      return activeCandidates.every(candidate => current.has(candidateKey(candidate)))
        ? new Set()
        : new Set(activeCandidates.map(candidateKey))
    })
  }

  // A route the adapter already describes answers without an endpoint; only a
  // draft with neither has nothing to ask about.
  const askable = probe.provider !== undefined || (probe.baseURL !== undefined && probe.baseURL.length > 0)
  const discoveryUnavailable = props.probeBlocked !== undefined
    ? t(props.probeBlocked)
    : askable ? undefined : t('fetchNeedsBaseUrl')
  return (
    <section className={styles['modelCatalog']} aria-label={props.catalogLabel ?? t('models')}>
      <div className={styles['modelListHead']}>
        <div className={styles['modelCatalogHeading']}>
          <span className={styles['modelCatalogTitle']}>{props.catalogLabel ?? t('models')}</span>
          {props.overridden === undefined
            ? null
            : (
              <span className={styles['modelCatalogMeta']}>
                {props.overridden ? t('modelsCustomized') : t('modelsInherited')}
              </span>
            )}
        </div>
      </div>
      <div className={styles['modelCatalogActions']}>
        {props.overridden === true && props.onReset !== undefined
          ? (
            <Button
              size="sm"
              variant="outline"
              className={styles['modelResetButton']}
              disabled={disabled}
              title={t('resetModelsHint')}
              onClick={props.onReset}
            >
              {t('resetModels')}
            </Button>
          )
          : null}
        {props.hideDiscoveryActions === true ? null : <><Button size="sm" variant="primary"
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={discoveryUnavailable ?? t(props.relatedCatalog === undefined ? 'getAllModelsHint' : 'getAllGoogleModelsHint')}
          onClick={() => { void fetchModels(true) }}>
          {t(props.relatedCatalog === undefined ? 'getAllModels' : 'getAllGoogleModels')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
          title={discoveryUnavailable ?? t(props.relatedCatalog === undefined ? 'fetchModelsHint' : 'fetchGoogleModelsHint')}
          onClick={() => { void fetchModels() }}
        >
          {busy ? t('fetching') : t(props.relatedCatalog === undefined ? 'fetchModels' : 'fetchGoogleModels')}
        </Button>
        </>}
      </div>
      {models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      {models.length > 0 ? <ModelColumnHeaders t={t} /> : null}
      {models.map((model, index) => (
        <div key={index} className={styles['modelEntry']}>
          <div className={styles['modelRow']}>
            <input data-hydra-control="field"
              className={styles['input']}
              type="text"
              value={textOf(model, 'id')}
              placeholder={t('modelId')}
              aria-label={`${t('modelId')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { id: event.target.value }) }}
            />
            <input data-hydra-control="field"
              className={styles['input']}
              type="text"
              value={textOf(model, 'name')}
              placeholder={t('modelName')}
              aria-label={`${t('modelName')} ${index + 1}`}
              disabled={disabled}
              onChange={(event) => { patch(index, { name: event.target.value === '' ? undefined : event.target.value }) }}
            />
            {(['image', 'video'] as const).map(role => (
              <ModelTypeCheckbox key={role} role={role} model={textOf(model, 'id') || index + 1}
                endpoints={endpointsOf(model)} t={t} disabled={disabled}
                onChange={(endpoints) => { patch(index, { endpoints }) }} />
            ))}
            <button
              type="button"
              className={styles['iconButton']}
              aria-label={`${t('modelDetails')} ${index + 1}`}
              aria-expanded={expanded.has(index)}
              title={t('modelDetails')}
              onClick={() => { toggleExpanded(index) }}
            >
              <IconChevron open={expanded.has(index)} />
            </button>
            <button
              type="button"
              className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
              aria-label={`${t('removeModel')} ${index + 1}`}
              title={t('removeModel')}
              disabled={disabled}
              onClick={() => {
                onChange(models.filter((_model, at) => at !== index))
                // Both stores are keyed by position, so every row after this
                // one shifts down and would otherwise inherit its neighbour's
                // state — a different row's capacities popping open, or its
                // half-typed text appearing in another row's field.
                setExpanded((current) => {
                  const next = new Set<number>()
                  for (const at of current) {
                    if (at < index) next.add(at)
                    else if (at > index) next.add(at - 1)
                  }
                  return next
                })
                setEditing(current => reindexOnRemove(current, index))
              }}
            >
              <IconTrash />
            </button>
          </div>
          {expanded.has(index)
            ? (
              <div className={styles['modelAdvanced']}>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelContextWindow')}</span>
                  <input data-hydra-control="field"
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'contextWindow')}
                    placeholder={CONTEXT_WINDOW_HINT}
                    aria-label={`${t('modelContextWindow')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'contextWindow', event.target.value) }}
                  />
                </label>
                <label className={styles['modelField']}>
                  <span className={styles['modelFieldLabel']}>{t('modelMaxTokens')}</span>
                  <input data-hydra-control="field"
                    className={styles['input']}
                    type="text"
                    inputMode="numeric"
                    value={capacityText(model, index, 'maxTokens')}
                    placeholder={t('modelMaxTokensPlaceholder')}
                    aria-label={`${t('modelMaxTokens')} ${index + 1}`}
                    disabled={disabled}
                    onChange={(event) => { editCapacity(index, 'maxTokens', event.target.value) }}
                  />
                </label>
              </div>
            )
            : null}
        </div>
      ))}
      <button
        type="button"
        className={styles['addModelButton']}
        disabled={disabled}
        onClick={() => { onChange([...models, { id: '' }]) }}
      >
        {t('addModel')}
      </button>
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <Modal
        open={candidates !== undefined}
        onClose={closePicker}
        title={t('fetchTitle')}
        closeLabel={t('close')}
        description={t(props.relatedCatalog === undefined ? 'fetchDescription' : 'fetchGoogleDescription')}
        className={styles['fetchDialog'] as string}
        footer={(
          <>
            <Button variant="outline" onClick={closePicker}>{t('cancel')}</Button>
            <Button variant="outline" onClick={adoptPicked}>{t('fetchAdopt')}</Button>
          </>
        )}
      >
        {failure === undefined ? null : <p role="alert" className={styles['error']}>{failure}</p>}
        <p className={styles['advancedHint']}>{t('modelTypesHint')}</p>
        <div className={styles['candidateActions']}>
          <Button variant="ghost" size="sm" onClick={toggleAllCandidates}>
            {t(allCandidatesPicked ? 'fetchDeselectAll' : 'fetchSelectAll')}
          </Button>
        </div>
        <div className={styles['candidateList']}>
          <table className={styles['candidateTable']}>
            <thead>
              <tr>
                <th scope="col">{t('modelId')}</th>
                <th scope="col">{t('fetchModelName')}</th>
                <th scope="col" className={styles['candidateType']}>{t('modelImage')}</th>
                <th scope="col" className={styles['candidateType']}>{t('modelVideo')}</th>
              </tr>
            </thead>
            {catalogs.filter(target => activeCandidates.some(candidate => candidate.catalog === target.catalog))
              .map(target => <tbody key={target.catalog} aria-label={target.label}>
                {target.label === undefined ? null : <tr><th colSpan={4} scope="rowgroup">{target.label}</th></tr>}
                {activeCandidates.filter(candidate => candidate.catalog === target.catalog).map(candidate => (
                  <tr key={candidateKey(candidate)}>
                    <td>
                      <label className={styles['candidateLabel']}>
                        <input
                          type="checkbox"
                          checked={picked.has(candidateKey(candidate))}
                          onChange={() => { toggle(candidateKey(candidate)) }}
                        />
                        <span className={styles['candidateId']}>{candidate.id}</span>
                      </label>
                    </td>
                    <td>
                      <input data-hydra-control="field"
                        className={styles['input']}
                        type="text"
                        aria-label={`${t('fetchModelName')} ${candidate.id}`}
                        value={candidate.name ?? ''}
                        placeholder=""
                        onChange={(event) => {
                          const name = event.target.value
                          setCandidates(current => current?.map(model => candidateKey(model) === candidateKey(candidate)
                            ? { ...model, name } : model))
                        }}
                      />
                    </td>
                    {(['image', 'video'] as const).map(role => (
                      <td key={role} className={styles['candidateType']}>
                        <ModelTypeCheckbox role={role} model={candidate.id} endpoints={candidate.endpoints} t={t}
                          onChange={(endpoints) => {
                            setCandidates(current => current?.map(model => candidateKey(model) === candidateKey(candidate)
                              ? { ...model, endpoints } : model))
                            setClassified(current => new Set(current).add(candidateKey(candidate)))
                          }} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>)}
          </table>
        </div>
      </Modal>
    </section>
  )
}
