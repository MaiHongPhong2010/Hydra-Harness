/**
 * Provider configuration over the shared directory, settings, and credential
 * join. Editors open only through Edit or Add; writes use the existing wire
 * APIs, and provider removal requires confirmation.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@hydraharness/harness-api-remotes/client'
import { Button, IconPlusOutline16, Modal } from '@hydraharness/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRenderSlots } from '@hydraharness/harness-client-ui-slots'
import { isManagedFallbackRef } from './FallbackKeysEditor.tsx'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { GenerationModels } from './GenerationModels.tsx'
import {
  deriveKeyRef, messageOf, protocolChoices, providerAccountKey,
} from './store.ts'
import type { ModelsSettingsStore, ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import { ProviderEditor, type ProviderEditorProps } from './ProviderEditor.tsx'
import type { en } from './locales.ts'
import {
  OFFICIAL_DEEPSEEK_DECLINED_FIELD, OFFICIAL_DEEPSEEK_PROVIDER,
  OFFICIAL_DEEPSEEK_SETTINGS_NS, WELCOME_NOTICE_SETTINGS_NAMESPACE,
} from '../onboarding-copy.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
    /** Live count of optional provider contributions. */
    providerOptions: HostObservable<number>
  }
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm' | 'authorization'>
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected> & PropsRenderSlots<'settings.models.provider-option'>>

type ModelsSectionFace = Omit<InjectFace<ModelsSectionInjected>, 'useProviderOptions'> & Partial<Pick<InjectFace<ModelsSectionInjected>, 'useProviderOptions'>> & PropsRenderSlots<'settings.models.provider-option'>

/** Provider identity shared by row actions and confirmation copy. */
export interface ProviderIdentity {
  /** Stable provider route id. */
  provider: string
  /** Human-facing provider name. */
  displayName: string
}

/** One existing row or dormant directory entry addressed by an editor action. */
interface EditorTarget extends ProviderIdentity {
  settingsNs: string
  settingsPath: readonly string[]
  /** Writable credential identified under this page's conventional reference. */
  credentialRef?: string
  /** Writable fallback credentials owned by this page. */
  credentialRefs: readonly string[]
  /** The adapter reports this route as one it does not ship (see {@link ProviderEditorProps.declared}). */
  declared?: boolean
}

/** Values that vary around the shared provider-editor rendering. */
interface ProviderEditorRenderProps extends Pick<
  ProviderEditorProps,
  'namespace' | 'schema' | 'api' | 't' | 'readOnly' | 'onClose'
> {
  target: EditorTarget
}

/** Render the editor for an expanded provider row. */
function renderProviderEditor({ target, ...props }: ProviderEditorRenderProps): ReactNode {
  return (
    <ProviderEditor
      provider={target.provider}
      displayName={target.displayName}
      settingsPath={target.settingsPath}
      {...target.declared === true ? { declared: true } : {}}
      {...props}
    />
  )
}

/** Whether this removal hides the shipped official DeepSeek row. */
function hidesOfficialDeepSeek(target: {
  settingsNs: string
  settingsPath: readonly string[]
}): boolean {
  return target.settingsNs === OFFICIAL_DEEPSEEK_SETTINGS_NS && target.settingsPath.length === 0
}

/**
 * Remove one configured provider, its saved accounts, and page-managed credentials. Credential
 * removal comes first so a second-step failure leaves the provider row visible
 * and the whole operation safely retryable; both unsets are idempotent.
 * Nested profiles unset their user-layer path. The shipped official DeepSeek
 * route records a durable hide flag instead of unsetting the composition
 * section, which would fight the base document and recreate the row.
 * @param api - settings, credential, and authorization wire faces.
 * @param controller - the page store to refresh.
 * @param target - the provider's settings address and managed credentials.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeProviderProfile(
  api: Pick<IApiClient, 'settings' | 'credentials' | 'authorization'>,
  controller: ModelsSettingsStore,
  target: {
    provider?: string
    settingsNs: string
    settingsPath: readonly string[]
    credentialRef?: string
    credentialRefs?: readonly string[]
  },
): Promise<string | undefined> {
  const namespace = controller.store.getSnapshot().namespaces.get(target.settingsNs)
  const selections = namespace?.value as Record<string, { provider?: string } | undefined> | undefined
  const generationFields = target.settingsNs === 'llm-pi-ai'
    ? (['imageModel', 'videoModel'] as const).filter(field => selections?.[field]?.provider === target.settingsPath[1]) : []
  const provider = target.provider ?? target.settingsPath[1]
  const accountKey = provider === undefined ? undefined : providerAccountKey(target.settingsNs, provider)
  const recordKey = accountKey ?? (target.settingsNs === 'llm-pi-ai' && provider !== undefined
    ? `${target.settingsNs}/${provider}` : undefined)
  try {
    if (recordKey !== undefined) {
      const removed = await api.authorization.logout({ key: recordKey })
      if (!removed.result.ok) return removed.result.error.message
    }
    for (const ref of [...target.credentialRef === undefined ? [] : [target.credentialRef], ...(target.credentialRefs ?? [])]) {
      const credential = await api.credentials.unset({ ref })
      if (!credential.result.ok) return credential.result.error.message
    }
    const response = hidesOfficialDeepSeek(target)
      ? await api.settings.mutate({
        ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: [OFFICIAL_DEEPSEEK_DECLINED_FIELD], value: true }],
      })
      : await api.settings.mutate({
        ns: target.settingsNs,
        ...namespace === undefined || generationFields.length === 0 ? {} : { expectedRevision: namespace.revision },
        ops: [{ op: 'unset', path: [...target.settingsPath] },
          ...generationFields.map(field => ({ op: 'unset' as const, path: [field] }))],
      })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    // The transport rejected rather than answering; the caller must be able
    // to retry the idempotent operation instead of the row silently staying.
    return messageOf(error)
  }
  await controller.load()
  return undefined
}

/**
 * Clear the official-DeepSeek hide flag so the shipped route can return to
 * the configured list. The composition base opts out by default, so an
 * explicit `false` is required instead of an unset that restores the base
 * value. Always reloads the join so a failed write still reflects the durable
 * section.
 * @param api - settings wire face.
 * @param controller - the page store to refresh.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function revealOfficialDeepSeek(
  api: Pick<IApiClient, 'settings'>,
  controller: ModelsSettingsStore,
): Promise<string | undefined> {
  let failure: string | undefined
  try {
    const response = await api.settings.mutate({
      ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: [OFFICIAL_DEEPSEEK_DECLINED_FIELD], value: false }],
    })
    if (!response.result.ok) failure = response.result.error.message
  } catch (error) {
    failure = messageOf(error)
  }
  await controller.load()
  return failure
}

function targetOf(row: ProviderRow): EditorTarget {
  const managedRef = deriveKeyRef(row.entry.provider)
  const credentialRef = row.apiKeyEnv === managedRef
    && row.credential?.configured === true
    && row.credential.writable
    ? managedRef
    : undefined
  return {
    provider: row.entry.provider,
    displayName: row.entry.displayName,
    settingsNs: row.entry.settingsNs,
    settingsPath: row.entry.settingsPath,
    ...credentialRef === undefined ? {} : { credentialRef },
    credentialRefs: Object.entries(row.fallbackCredentials)
      .filter(([ref, state]) => isManagedFallbackRef(row.entry.provider, ref) && state?.configured === true && state.writable)
      .map(([ref]) => ref),
    // Absent is not "shipped": an adapter that answers nothing leaves the
    // route-level fields only a declared route owns off the card, exactly as
    // it leaves the custom tag off the row.
    ...row.entry.declared === true ? { declared: true } : {},
  }
}

/** Stable visible and accessible identity for one provider target. */
export function providerTargetLabel(target: ProviderIdentity): string {
  return target.provider === target.displayName
    ? target.provider
    : `${target.displayName} (${target.provider})`
}

/** Replace the one provider placeholder in localized destructive-action copy. */
export function providerCopy(template: string, target: ProviderIdentity): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Render the Models section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, useProviderOptions, api, schema, t, renderSlot } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined
    || schema === undefined || t === undefined) return null
  const optionalRenderSlot = renderSlot ?? (() => null) as ModelsSectionFace['renderSlot']
  return <Loaded injected={{
    controller, useSnapshot, api, schema, t, renderSlot: optionalRenderSlot,
    ...useProviderOptions === undefined ? {} : { useProviderOptions },
  }} />
}

function Loaded({ injected }: { injected: ModelsSectionFace }): ReactNode {
  const { controller, api, schema, t, renderSlot } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const providerOptionCount = injected.useProviderOptions?.(count => count) ?? 0
  const [editing, setEditing] = useState<EditorTarget | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [addingOption, setAddingOption] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<EditorTarget | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)

  const announceSaved = (target: ProviderIdentity): void => {
    // Announced only once the refreshed directory is in the snapshot the
    // notice reads its name from: an apply can rename the route, and the
    // target captured when the card opened still carries the old name.
    void controller.load().then(() => { setSavedTarget(target) })
  }

  const persistSaved = (changed: boolean, target: ProviderIdentity): void => {
    if (!changed) return
    if (target.provider === OFFICIAL_DEEPSEEK_PROVIDER
      && controller.store.getSnapshot().officialDeepSeekDeclined) {
      void revealOfficialDeepSeek(api, controller).then(() => { setSavedTarget(target) })
      return
    }
    announceSaved(target)
  }

  const closeEditor = (changed: boolean, target: ProviderIdentity): void => {
    setEditing(undefined)
    setAdding(false)
    setAddingOption(undefined)
    setDeclaring(false)
    persistSaved(changed, target)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeProviderProfile(api, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  // The saved provider as the directory currently names it. The route id is
  // what the apply cannot change, so it is what the notice is keyed by; a row
  // the same apply removed keeps the captured identity, since nothing newer
  // exists to name it with.
  const savedRow = savedTarget === undefined
    ? undefined
    : state.rows.find(row => row.entry.provider === savedTarget.provider)
  const savedIdentity = savedRow === undefined
    ? savedTarget
    : { provider: savedRow.entry.provider, displayName: savedRow.entry.displayName }

  // Hand-declared routes live in the pi-ai namespace, which is also the only
  // one whose schema names the protocols one may speak; without it mounted
  // there is nothing to declare and the entry point stays disabled.
  const protocols = protocolChoices(state.namespaces.get('llm-pi-ai'), schema)
  const generationNamespace = state.namespaces.get('llm-pi-ai')

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {generationNamespace !== undefined && <GenerationModels
        namespace={generationNamespace} schema={schema} api={api} readOnly={!state.writable}
        catalogRevision={JSON.stringify([...state.namespaces].map(([ns, view]) => [ns, view.revision]))}
        onSaved={() => controller.load()} t={t} />}
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      {(['apiKeys', 'accountLogin'] as const).map((group) => {
        const accountGroup = group === 'accountLogin'
        const rows = state.rows.filter((row) => {
          const geminiApiOAuth = row.entry.settingsNs === 'llm-account-auth' && row.entry.provider === 'gemini-api'
          if (geminiApiOAuth) return !accountGroup && row.configured
          return (providerAccountKey(row.entry.settingsNs, row.entry.provider) !== undefined) === accountGroup
        })
        if (accountGroup && rows.length === 0) return null
        const configured = rows.filter(row => row.configured)
        // Account providers remain selectable after their profile exists: the
        // editor is also where a second account is added.
        const selectable = accountGroup
          ? rows
          : rows.filter(row => providerAccountKey(row.entry.settingsNs, row.entry.provider) === undefined
            && ((!row.configured && row.entry.settingsNs !== '') || row.entry.provider === editing?.provider))
        const addTarget = adding && rows.some(row => row.entry.provider === editing?.provider) ? editing : undefined
        const addNamespace = addTarget === undefined ? undefined : state.namespaces.get(addTarget.settingsNs)
        const showAdd = addTarget !== undefined || (!accountGroup && adding && editing === undefined)
        const googleRow = accountGroup ? selectable.find(row => row.entry.provider === 'antigravity') : undefined
        const googleSelected = googleRow !== undefined && googleRow.entry.provider === addTarget?.provider
        return (
          <section key={group} className={styles['providerGroup']} aria-label={t(group)}>
            <h3 className={styles['title']}>{t(group)}</h3>
            <p className={styles['intro']}>{t(accountGroup ? 'accountLoginHint' : 'apiKeysHint')}</p>
            <ul className={styles['rows']}>
              {configured.map((row) => {
                const target = targetOf(row)
                const namespace = state.namespaces.get(target.settingsNs)
                /* v8 ignore next -- the join marks a row configured only when its namespace resolved */
                if (namespace === undefined) return null
                const open = !adding && editing?.provider === row.entry.provider
                const credentialConfigured = row.accountCount === undefined
                  ? row.credential?.configured === true || Object.values(row.fallbackCredentials).some(state => state?.configured === true)
                  : row.accountCount > 0
                const credentialMissing = row.accountCount === undefined
                  ? !credentialConfigured && (row.credential?.configured === false
                    || Object.values(row.fallbackCredentials).some(state => state?.configured === false))
                  : row.accountCount === 0
                const configuredLabel = t(row.accountCount === undefined ? 'credentialConfigured' : 'accountConfigured')
                const missingLabel = t(row.accountCount === undefined ? 'credentialMissing' : 'accountMissing')
                return (
                  <li key={row.entry.provider} className={styles['rowCard']}>
                    <div className={styles['rowHead']}>
                      <span className={styles['rowIdentity']}>
                        <span className={styles['rowName']}>{row.entry.displayName}</span>
                        {/* Only the adapter can tell a hand-declared route from a
                            shipped one it also has a stored profile for, so the tag
                            follows its answer and stays off when it gives none. */}
                        {row.entry.declared === true
                          ? <span className={styles['rowTag']}>{t('customTag')}</span>
                          : null}
                        {credentialConfigured
                          ? (
                            <span
                              className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                              role="img"
                              aria-label={configuredLabel}
                              title={configuredLabel}
                            />
                          )
                          : credentialMissing
                            ? (
                              <span
                                className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                                role="img"
                                aria-label={missingLabel}
                                title={missingLabel}
                              />
                            )
                            : null}
                      </span>
                      <span className={styles['rowActions']}>
                        <button
                          type="button"
                          className={styles['secondaryButton']}
                          aria-label={providerCopy(t('editProvider'), target)}
                          onClick={() => {
                            setSavedTarget(undefined)
                            setAddingOption(undefined)
                            // One card at a time: leaving `declaring` set would show
                            // the create card beside this editor, and closing either
                            // one discards the other's draft.
                            setDeclaring(false)
                            setAdding(false)
                            setEditing(open ? undefined : target)
                          }}
                        >
                          {t('edit')}
                        </button>
                        {row.removable
                          ? (
                            <button
                              type="button"
                              className={styles['dangerButton']}
                              aria-label={providerCopy(t('removeProvider'), target)}
                              disabled={!state.writable}
                              onClick={() => {
                                if (editing?.provider === target.provider && editing.settingsNs === target.settingsNs) {
                                  setEditing(undefined)
                                  setAdding(false)
                                  setAddingOption(undefined)
                                }
                                setSavedTarget(undefined)
                                setDeleteFailure(undefined)
                                setDeleteTarget(target)
                              }}
                            >
                              {t('remove')}
                            </button>
                          )
                          : null}
                      </span>
                    </div>
                    {open
                      ? renderProviderEditor({
                        target,
                        namespace,
                        schema,
                        api,
                        t,
                        readOnly: !state.writable,
                        onClose: (changed) => { closeEditor(changed, target) },
                      })
                      : null}
                  </li>
                )
              })}
              {accountGroup ? null : renderSlot('settings.models.provider-option', {
                mode: 'row', credentials: state.credentials,
                onEdit: (id) => {
                  setSavedTarget(undefined)
                  setEditing(undefined)
                  setDeclaring(false)
                  setAdding(true)
                  setAddingOption(id)
                },
              })}
            </ul>
            <div className={styles['addBlock']}>
              {showAdd
                ? (
                  <div className={styles['addCard']}>
                    <div className={styles['field']}>
                      <span className={styles['fieldLabel']}>{t('provider')}</span>
                      <select data-hydra-control="field"
                        className={styles['input']}
                        value={addingOption === undefined ? googleSelected ? 'google' : addTarget?.provider ?? '' : `plugin:${addingOption}`}
                        aria-label={t('provider')}
                        onChange={(event) => {
                          const optionalId = event.currentTarget.selectedOptions[0]?.dataset['hydraProviderOption']
                          if (optionalId !== undefined) {
                            setSavedTarget(undefined)
                            setEditing(undefined)
                            setAdding(true)
                            setDeclaring(false)
                            setAddingOption(optionalId)
                            return
                          }
                          const row = event.target.value === 'google'
                            ? googleRow
                            : selectable.find(candidate => candidate.entry.provider === event.target.value)
                          /* v8 ignore next -- the select only lists addable rows */
                          if (row === undefined) return
                          setAddingOption(undefined)
                          setEditing(targetOf(row))
                        }}
                      >
                        {selectable.map(row => row === googleRow
                          ? <option key="google" value="google">Google</option>
                          : <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>)}
                        {addTarget === undefined && addingOption === undefined ? <option value="" disabled>{t('provider')}</option> : null}
                        {accountGroup ? null : renderSlot('settings.models.provider-option', { mode: 'option' })}
                      </select>
                    </div>
                    {addingOption !== undefined && !accountGroup
                      ? renderSlot('settings.models.provider-option', {
                        mode: 'editor', readOnly: !state.writable,
                        onClose: (changed) => {
                          setAdding(false)
                          setAddingOption(undefined)
                          if (changed) announceSaved({ provider: addingOption, displayName: addingOption })
                        },
                      }, { only: addingOption, fallback: <p role="status">{t('providerUnavailable')}</p> })
                      : addTarget !== undefined && addNamespace !== undefined ? <ProviderEditor
                        key={addTarget.provider}
                        provider={addTarget.provider}
                        displayName={addTarget.displayName}
                        hideTitle
                        accountMode="add"
                        namespace={addNamespace}
                        schema={schema}
                        settingsPath={addTarget.settingsPath}
                        api={api}
                        t={t}
                        readOnly={!state.writable}
                        onClose={(changed) => { closeEditor(changed, addTarget) }}
                      /> : null}
                  </div>
                )
                : declaring && !accountGroup
                  ? (
                    <div className={styles['addCard']}>
                      <CustomProviderCard
                        taken={state.rows.map(row => row.entry.provider)}
                        protocols={protocols}
                        /* v8 ignore next -- the card only opens from a button disabled without this namespace */
                        revision={state.namespaces.get('llm-pi-ai')?.revision ?? 0}
                        api={api}
                        t={t}
                        readOnly={!state.writable}
                        onClose={(changed) => {
                          setDeclaring(false)
                          if (changed) void controller.load()
                        }}
                      />
                    </div>
                  )
                  : (
                    <div className={styles['addActions']}>
                      <button
                        type="button"
                        className={styles['addButton']}
                        disabled={(selectable.length === 0 && (accountGroup || providerOptionCount === 0)) || !state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setAddingOption(undefined)
                          setDeclaring(false)
                          setAdding(true)
                          // API-key providers require an explicit choice; the
                          // account flow keeps its repeat-sign-in shortcut.
                          setEditing(accountGroup && selectable[0] !== undefined
                            ? targetOf(selectable[0])
                            : undefined)
                        }}
                      >
                        {/* Same glyph as the composer's attach button. */}
                        <IconPlusOutline16 size={14} />
                        {t(accountGroup ? 'accountProviderAdd' : 'add')}
                      </button>
                      {accountGroup ? null : <button
                        type="button"
                        className={styles['addButton']}
                        disabled={protocols.length === 0 || !state.writable}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setAdding(false)
                          setEditing(undefined)
                          setDeclaring(true)
                        }}
                      >
                        <IconPlusOutline16 size={14} />
                        {t('customAdd')}
                      </button>}
                    </div>
                  )}
            </div>
          </section>
        )
      })}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined
          ? ''
          : providerCopy(
            providerAccountKey(deleteTarget.settingsNs, deleteTarget.provider) !== undefined
              ? t(deleteTarget.provider === 'antigravity' || deleteTarget.provider === 'gemini-api'
                ? 'deleteDescriptionWithGoogleAccounts' : 'deleteDescriptionWithAccounts')
              : deleteTarget.credentialRef === undefined && deleteTarget.credentialRefs.length === 0
                ? t(deleteTarget.settingsNs === 'llm-pi-ai' ? 'deleteDescriptionWithRecord' : 'deleteDescription')
                : t('deleteDescriptionWithCredential'),
            deleteTarget,
          )}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
